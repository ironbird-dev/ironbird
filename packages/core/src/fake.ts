// A type-only import, as everywhere in core (see registry.ts): ControlHandlers needs only z.output.
import type { z } from 'zod';
import { createCallLog } from './call-log';
import type { Clock } from './clock';
import { IronbirdError, isIronbirdError, messageOf } from './errors';
import type { FakeCallsResult } from './protocol';
import type { EventRecorder } from './recorder';
import { defineCommands, suggestNames, type CommandRegistry, type Schemas } from './registry';

/** A fake wired into a target: what `describe`, `fakeControl`, and `fakeCalls` work against. */
export interface FakeInstance<Port extends object = object, C extends Schemas = Schemas> {
  readonly name: string;
  readonly description?: string;
  /** Call-recording proxy over the port returned by create(). */
  readonly port: Port;
  readonly controls: CommandRegistry<C>;
  /** Throws IronbirdError with UNKNOWN_CONTROL, INVALID_PAYLOAD, or DISPATCH_FAILED; an IronbirdError from the handler passes through. */
  control(name: string, payload?: unknown): Promise<void>;
  /** A page of recorded port calls newer than `since`, as copies; `nextSeq` is the cursor to pass next, as with `EventRecorder.since`. */
  calls(since?: number, limit?: number): FakeCallsResult;
}

export interface FakeContext {
  readonly clock: Clock;
  /** Records an event with the fake's name as its source. A no-op without a recorder. */
  record(name: string, data?: unknown): void;
}

export type ControlHandlers<C extends Schemas> = {
  [K in keyof C]: (payload: z.output<C[K]>) => void | Promise<void>;
};

export interface FakeDefinition<Port extends object, C extends Schemas> {
  description?: string;
  controls: C;
  /** Returns the port and one handler per declared control; TypeScript rejects a missing handler, `create` rejects an extra one. */
  create(context: FakeContext): { port: Port; controls: ControlHandlers<C> };
}

export interface FakeFactory<Port extends object, C extends Schemas> {
  readonly name: string;
  create(deps: { clock: Clock; recorder?: EventRecorder }): FakeInstance<Port, C>;
}

type AnyHandler = (payload: unknown) => void | Promise<void>;

/**
 * Declares a fake port with agent-facing controls. Control payloads are validated by a command
 * registry built from `controls`, so `describe` gets their JSON Schema and `INVALID_PAYLOAD` carries
 * the registry's issues (D1). Every instance's `port` records calls (R16) and carries the fake mark
 * that `tracker.wrap` reads for quiescence. Nothing here freezes the port.
 */
export function defineFake<Port extends object, C extends Schemas>(name: string, definition: FakeDefinition<Port, C>): FakeFactory<Port, C> {
  const declared = Object.keys(definition.controls);
  const unknownControl = (control: string, message: string): IronbirdError =>
    new IronbirdError('UNKNOWN_CONTROL', message, { fake: name, control, suggestions: suggestNames(control, declared) });

  return {
    name,
    create(deps) {
      const controls = defineCommands(definition.controls);
      // Widened once: the bare registry's `parse` takes any string, and `has` below already
      // rules out names the fake doesn't declare.
      const registry: CommandRegistry = controls;
      const created = definition.create({
        clock: deps.clock,
        record: (eventName, data) => {
          deps.recorder?.record(name, eventName, data);
        },
      });
      // The handler map is typed as complete over the declared controls, so a missing key is a
      // compile error; an extra key is not, and a JavaScript caller can omit one, so both are
      // checked here. A programming error, hence a boot failure rather than a lazy one.
      const handlers = created.controls as Record<string, AnyHandler | undefined>;
      for (const key of Object.keys(handlers)) {
        if (!Object.prototype.hasOwnProperty.call(definition.controls, key)) {
          throw unknownControl(key, `Fake ${name} returned a handler for ${key}, which it doesn't declare as a control`);
        }
      }
      for (const key of declared) {
        if (typeof handlers[key] !== 'function') throw unknownControl(key, `Fake ${name} declares the control ${key} but returned no handler for it`);
      }
      const log = createCallLog({ fake: name, clock: deps.clock });

      return {
        name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        port: log.wrap(created.port),
        controls,
        async control(controlName, payload) {
          if (!controls.has(controlName)) throw unknownControl(controlName, `Unknown control ${controlName} on fake ${name}`);
          const qualified = `${name}.${controlName}`;
          let parsed: unknown;
          try {
            parsed = registry.parse(controlName, payload);
          } catch (error) {
            // The registry names the bare control; agents see fakes and commands in one list, so
            // the error names it as fake.control instead.
            if (isIronbirdError(error) && error.code === 'INVALID_PAYLOAD') {
              throw new IronbirdError('INVALID_PAYLOAD', `Invalid payload for ${qualified}`, { name: qualified, issues: (error.details as { issues: unknown }).issues });
            }
            throw error;
          }
          const handler = handlers[controlName];
          if (!handler) throw unknownControl(controlName, `Unknown control ${controlName} on fake ${name}`);
          try {
            await handler(parsed);
          } catch (error) {
            if (isIronbirdError(error)) throw error;
            const message = messageOf(error);
            throw new IronbirdError('DISPATCH_FAILED', `Control ${qualified} failed: ${message}`, { name: qualified, message });
          }
        },
        calls: (since = 0, limit = Number.POSITIVE_INFINITY) => log.since(since, limit),
      };
    },
  };
}
