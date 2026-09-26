import type { ErrorCode } from './errors';

export type Platform = 'headless' | 'ios' | 'android';

export type Capability = 'settle' | 'events' | 'fakes' | 'clock' | 'persist' | 'restore' | 'reset';

/** A JSON Schema document. Kept loose on purpose; agents consume it, core doesn't interpret it. */
export type JsonSchema = Record<string, unknown>;

export interface CommandDescription {
  description?: string;
  payload: JsonSchema;
}

export interface Description {
  app: { id: string; platform: Platform; name?: string };
  commands: Record<string, CommandDescription>;
  fakes: Record<string, { description?: string; controls: Record<string, CommandDescription> }>;
  capabilities: Capability[];
}

export interface PendingItem {
  kind: 'effect' | 'timer';
  label: string;
  ageMs: number;
  fake: boolean;
}

export interface SettleResult {
  idle: boolean;
  quiescent: boolean;
  waitedMs: number;
  pending: PendingItem[];
  nextTimerInMs?: number;
}

export interface RecordedEvent {
  seq: number;
  t: number;
  source: string;
  name: string;
  data?: unknown;
}

export interface StepResult {
  target: string;
  rev: number;
  path: string;
  state: unknown;
  events: RecordedEvent[];
  settle: SettleResult | null;
}

export interface FakeCall {
  /** Per fake, from 1. */
  seq: number;
  t: number;
  fake: string;
  method: string;
  /** Serialized like state, so a listener argument is a placeholder rather than a failure. */
  args: unknown[];
  /** A call that returns a promise is `pending` until it settles, then `resolved` or `rejected`. */
  outcome: 'returned' | 'threw' | 'resolved' | 'rejected' | 'pending';
  /** The error's message, for `threw` and `rejected`. */
  error?: string;
}

/** What `FakeInstance.calls` and the `fakeCalls` operation return; `nextSeq` is the cursor to pass as the next `since`, as with `events`. */
export interface FakeCallsResult {
  calls: FakeCall[];
  nextSeq: number;
  truncated: boolean;
}

export interface Screenshot {
  path: string;
  device: string;
  capturedAt: number;
}

export interface TargetInfo {
  id: string;
  platform: Platform;
  appId: string;
  connectedAt: number;
  rev: number;
}

export interface ErrorShape {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * The output of the CLI's scenario runner, one per scenario file. No daemon operation returns
 * it; it lives here so the M3 MCP server and `@ironbird/testing` can share the type.
 */
export interface ScenarioResult {
  /** The scenario's `name`. */
  scenario: string;
  /** Absolute path of the scenario file. */
  file: string;
  /** The target id the run was pinned to, from the first `describe`'s envelope. */
  target: string;
  passed: boolean;
  durationMs: number;
  /** Steps that ran, including a failed one and excluding skipped ones. */
  stepsRun: number;
  failedStep?: { index: number; step: unknown; repetition?: number; expected?: unknown; actual?: unknown; error?: ErrorShape };
  /** Indexes of optional steps skipped because the target can't run them. */
  skipped: number[];
  /** The run directory, or null when the caller turned artifacts off. */
  artifacts: string | null;
  /** Artifact files that could not be written, for example the state after a disconnect. */
  artifactErrors?: string[];
}
