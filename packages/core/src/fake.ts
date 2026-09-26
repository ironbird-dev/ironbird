import type { FakeCallsResult } from './protocol';
import type { CommandRegistry, Schemas } from './registry';

/**
 * A fake wired into a target. M2 adds defineFake, which builds these; M0 only needs the shape so
 * HeadlessApp, the daemon's describe, and the bridge can be typed against it now.
 */
export interface FakeInstance<Port extends object = object, C extends Schemas = Schemas> {
  readonly name: string;
  readonly description?: string;
  /** Call-recording proxy over the port returned by create(). */
  readonly port: Port;
  readonly controls: CommandRegistry<C>;
  control(name: string, payload?: unknown): Promise<void>;
  /** A page of recorded port calls newer than `since`, as copies; `nextSeq` is the cursor to pass next, as with `EventRecorder.since`. */
  calls(since?: number, limit?: number): FakeCallsResult;
}
