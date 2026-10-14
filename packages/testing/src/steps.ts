import { IronbirdError, suggestNames, type Description, type JsonSchema } from '@ironbird/core';
import * as fc from 'fast-check';
import { arbitraryFromSchema } from './schema';
import type { TestTarget } from './target';

type Path = Array<string | number>;

/** A payload override: a list to pick from, or any fast-check arbitrary. */
export type PayloadOverride = fc.Arbitrary<unknown> | readonly unknown[];

/** One kind of step modelTest may take (M4 design §6). `weight`, default 1, is its relative frequency. */
export type ModelStep =
  | string
  | { command: string; payload?: PayloadOverride; weight?: number }
  | { fake: string; control: string; payload?: PayloadOverride; weight?: number }
  | { clock: { maxMs: number }; weight?: number };

/** One generated step. */
export type Action =
  | { kind: 'send'; command: string; payload: unknown }
  | { kind: 'fake'; fake: string; control: string; payload: unknown }
  | { kind: 'clock'; ms: number };

/** A step as a scenario file writes it (cli.md, "Scenario files"). */
export type TraceStep = { send: string; payload: unknown } | { fake: string; control: string; payload: unknown } | { clock: number };

/** A step that ran, as `INVARIANT_FAILED`'s `details.steps` reports it: the scenario step and whether the app rejected it. */
export type RecordedStep = TraceStep & { rejected: boolean };

/** A modelTest option that can't work, reported before any run. */
export function optionsError(path: Path, message: string): IronbirdError {
  return new IronbirdError('INVALID_PAYLOAD', `Invalid modelTest options at ${path.join('.')}: ${message}`, { name: 'modelTest', issues: [{ path, message }] });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// By shape rather than `instanceof`: a test may build its arbitrary with another copy of
// fast-check (the CommonJS build under Jest, or another 4.x), whose Arbitrary class differs.
const isArbitrary = (value: unknown): value is fc.Arbitrary<unknown> =>
  isRecord(value) && typeof value['generate'] === 'function' && typeof value['shrink'] === 'function' && typeof value['map'] === 'function';

function payloadArbitrary(override: unknown, schema: JsonSchema, name: string, at: Path): fc.Arbitrary<unknown> {
  if (override === undefined) return arbitraryFromSchema(schema, { name });
  if (Array.isArray(override)) {
    if (override.length === 0) throw optionsError(at, 'expected at least one payload');
    return fc.constantFrom(...(override as unknown[]));
  }
  if (isArbitrary(override)) return override;
  throw optionsError(at, 'expected a list of payloads or a fast-check arbitrary');
}

function weightOf(weight: unknown, at: Path): number {
  if (weight === undefined) return 1;
  if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1) throw optionsError([...at, 'weight'], 'expected a positive integer');
  return weight;
}

function commandStep(name: unknown, override: unknown, at: Path, description: Description): fc.Arbitrary<Action> {
  if (typeof name !== 'string') throw optionsError([...at, 'command'], 'expected a command name');
  const declared = Object.hasOwn(description.commands, name) ? description.commands[name] : undefined;
  if (!declared) throw new IronbirdError('UNKNOWN_COMMAND', `Unknown command ${name}`, { name, suggestions: suggestNames(name, Object.keys(description.commands)) });
  return payloadArbitrary(override, declared.payload, name, [...at, 'payload']).map((payload): Action => ({ kind: 'send', command: name, payload }));
}

function fakeStep(step: Record<string, unknown>, at: Path, description: Description): fc.Arbitrary<Action> {
  const fake = step['fake'];
  const control = step['control'];
  if (typeof fake !== 'string') throw optionsError([...at, 'fake'], 'expected a fake name');
  if (typeof control !== 'string') throw optionsError([...at, 'control'], 'expected a control name');
  if (!description.capabilities.includes('fakes')) {
    throw new IronbirdError('UNSUPPORTED', "The headless target doesn't support fakeControl: the app wires no fakes", { op: 'fakeControl', target: 'headless' });
  }
  const available = Object.keys(description.fakes);
  const declared = Object.hasOwn(description.fakes, fake) ? description.fakes[fake] : undefined;
  if (!declared) throw new IronbirdError('UNKNOWN_FAKE', `Unknown fake ${fake}`, { fake, available, suggestions: suggestNames(fake, available) });
  const schema = Object.hasOwn(declared.controls, control) ? declared.controls[control] : undefined;
  if (!schema) {
    throw new IronbirdError('UNKNOWN_CONTROL', `Unknown control ${control} on fake ${fake}`, { fake, control, suggestions: suggestNames(control, Object.keys(declared.controls)) });
  }
  return payloadArbitrary(step['payload'], schema.payload, `${fake}.${control}`, [...at, 'payload']).map((payload): Action => ({ kind: 'fake', fake, control, payload }));
}

function clockStep(clock: unknown, at: Path, description: Description): fc.Arbitrary<Action> {
  const maxMs = isRecord(clock) ? clock['maxMs'] : undefined;
  if (typeof maxMs !== 'number' || !Number.isInteger(maxMs) || maxMs < 0) throw optionsError([...at, 'clock', 'maxMs'], 'expected a non-negative integer');
  if (!description.capabilities.includes('clock')) {
    throw new IronbirdError('UNSUPPORTED', "The headless target doesn't support clockAdvance", { op: 'clockAdvance', target: 'headless' });
  }
  return fc.integer({ min: 0, max: maxMs }).map((ms): Action => ({ kind: 'clock', ms }));
}

/**
 * Turns the declared steps into weighted arbitraries for `fc.oneof`, checking each against
 * `describe()` first, so a typo fails with the CLI's codes and suggestions before any run (§6.1).
 */
export function planSteps(steps: readonly ModelStep[], description: Description): Array<fc.WeightedArbitrary<Action>> {
  if (!Array.isArray(steps) || steps.length === 0) throw optionsError(['steps'], 'declare at least one step');
  return steps.map((step: unknown, index): fc.WeightedArbitrary<Action> => {
    const at: Path = ['steps', index];
    if (typeof step === 'string') return { arbitrary: commandStep(step, undefined, at, description), weight: 1 };
    if (!isRecord(step)) throw optionsError(at, 'expected a command name or a step object');
    const weight = weightOf(step['weight'], at);
    if ('clock' in step) return { arbitrary: clockStep(step['clock'], at, description), weight };
    if ('fake' in step) return { arbitrary: fakeStep(step, at, description), weight };
    if ('command' in step) return { arbitrary: commandStep(step['command'], step['payload'], at, description), weight };
    throw optionsError(at, 'expected command, fake and control, or clock');
  });
}

/** Runs one generated step as one operation with settling. */
export async function applyAction(target: TestTarget, action: Action): Promise<void> {
  if (action.kind === 'send') await target.send(action.command, action.payload);
  else if (action.kind === 'fake') await target.fake(action.fake, action.control, action.payload);
  else await target.advance(action.ms);
}

export function toTraceStep(action: Action): TraceStep {
  if (action.kind === 'send') return { send: action.command, payload: action.payload };
  if (action.kind === 'fake') return { fake: action.fake, control: action.control, payload: action.payload };
  return { clock: action.ms };
}
