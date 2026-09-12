import type { ManualClock } from './clock';
import type { FakeInstance } from './fake';
import type { EventRecorder } from './recorder';
import type { Target } from './target';
import type { Tracker } from './tracker';

export interface HeadlessContext {
  clock: ManualClock;
  recorder: EventRecorder;
  tracker: Tracker;
  env: Readonly<Record<string, string | undefined>>;
}

export interface HeadlessApp {
  target: Target;
  fakes?: FakeInstance[];
  dispose?(): void | Promise<void>;
}

export interface HeadlessDefinition {
  readonly kind: 'ironbird.headless';
  create(context: HeadlessContext): Promise<HeadlessApp>;
}

export function defineHeadless(factory: (context: HeadlessContext) => HeadlessApp | Promise<HeadlessApp>): HeadlessDefinition {
  return {
    kind: 'ironbird.headless',
    create: async (context) => factory(context),
  };
}

export function isHeadlessDefinition(value: unknown): value is HeadlessDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; create?: unknown };
  return candidate.kind === 'ironbird.headless' && typeof candidate.create === 'function';
}
