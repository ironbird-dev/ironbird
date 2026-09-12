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
  seq: number;
  t: number;
  fake: string;
  method: string;
  args: unknown[];
  outcome: 'returned' | 'resolved' | 'rejected' | 'pending';
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

export interface ScenarioResult {
  scenario: string;
  target: string;
  passed: boolean;
  durationMs: number;
  failedStep?: { index: number; step: unknown; actual?: unknown; error?: ErrorShape };
  skipped: number[];
  artifacts: string;
}
