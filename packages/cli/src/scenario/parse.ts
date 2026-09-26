import { IronbirdError, isIronbirdError, messageOf, parseCondition, type Condition } from '@ironbird/core';
import { LineCounter, isMap, isNode, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { UsageError, parseDuration } from '../cli/durations';

/** One problem in a scenario file, as `INVALID_SCENARIO` reports it under `details.issues`. */
export interface ScenarioIssue {
  path: Array<string | number>;
  message: string;
  /** 1-based line in the file, when the problem maps to a node in it. */
  line?: number;
}

interface StepBase {
  /** Skip rather than fail when the target can't run this step (docs/cli.md, "Scenario files"). */
  optional: boolean;
  /** The step as written in the file, reported as `failedStep.step`. */
  raw: Record<string, unknown>;
}

export type ScenarioStep =
  | (StepBase & { kind: 'send'; command: string; payload: unknown; repeat: number; settle: boolean })
  | (StepBase & { kind: 'fake'; fake: string; control: string; payload: unknown; repeat: number; settle: boolean })
  | (StepBase & { kind: 'clock'; ms: number; settle: boolean })
  | (StepBase & { kind: 'wait'; path: string; condition: Condition; timeoutMs: number })
  | (StepBase & { kind: 'expect'; path: string; condition: Condition })
  | (StepBase & { kind: 'screenshot'; name: string })
  | (StepBase & { kind: 'reset' });

export interface Scenario {
  name: string;
  description?: string;
  target?: string;
  steps: ScenarioStep[];
}

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

const STEP_KINDS = ['send', 'fake', 'clock', 'wait', 'expect', 'screenshot', 'reset'] as const;
type StepKind = (typeof STEP_KINDS)[number];

const optional = z.boolean().optional();
const settle = z.boolean().optional();
const repeat = z.number().int().min(1).optional();
const payload = z.unknown().optional();
// A number is milliseconds; a string goes through the CLI's duration parser in `durationMs`.
const duration = z.union([z.number().nonnegative(), z.string().min(1)]);
const conditionKeys = { equals: z.unknown().optional(), notEquals: z.unknown().optional(), exists: z.boolean().optional(), matches: z.string().optional() };

// Strict, so a typo such as `payloads` fails at parse time instead of being ignored at run time.
const stepSchemas = {
  send: z.strictObject({ send: z.string().min(1), payload, repeat, settle, optional }),
  fake: z.strictObject({ fake: z.string().min(1), control: z.string().min(1), payload, repeat, settle, optional }),
  clock: z.strictObject({ clock: duration, settle, optional }),
  wait: z.strictObject({ wait: z.string(), ...conditionKeys, timeout: duration.optional(), optional }),
  expect: z.strictObject({ expect: z.string(), ...conditionKeys, optional }),
  screenshot: z.strictObject({ screenshot: z.string().min(1), optional }),
  reset: z.strictObject({ reset: z.literal(true), optional }),
};

const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  target: z.string().min(1).optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1),
});

/** A problem found while normalizing one validated step; `path` is relative to the step. */
class StepIssue extends Error {
  constructor(
    readonly path: Array<string | number>,
    message: string,
  ) {
    super(message);
    this.name = 'StepIssue';
  }
}

function durationMs(value: number | string, key: string): number {
  if (typeof value === 'number') return Math.round(value);
  try {
    return parseDuration(value);
  } catch (error) {
    throw new StepIssue([key], error instanceof UsageError ? error.message : messageOf(error));
  }
}

/** Reads the condition keys through core's `parseCondition`, so scenarios and `waitFor` agree on what a condition is. */
function conditionOf(raw: Record<string, unknown>): Condition {
  try {
    return parseCondition(raw);
  } catch (error) {
    if (isIronbirdError(error) && error.code === 'INVALID_PAYLOAD') {
      const issue = (error.details as { issues?: Array<{ path: Array<string | number>; message: string }> } | undefined)?.issues?.[0];
      throw new StepIssue(issue?.path ?? [], issue?.message ?? error.message);
    }
    throw error;
  }
}

const normalizers: { [K in StepKind]: (raw: Record<string, unknown>) => ScenarioStep } = {
  send: (raw) => {
    const step = stepSchemas.send.parse(raw);
    return { kind: 'send', command: step.send, payload: step.payload === undefined ? {} : step.payload, repeat: step.repeat ?? 1, settle: step.settle ?? true, optional: step.optional ?? false, raw };
  },
  fake: (raw) => {
    const step = stepSchemas.fake.parse(raw);
    return { kind: 'fake', fake: step.fake, control: step.control, payload: step.payload === undefined ? {} : step.payload, repeat: step.repeat ?? 1, settle: step.settle ?? true, optional: step.optional ?? false, raw };
  },
  clock: (raw) => {
    const step = stepSchemas.clock.parse(raw);
    return { kind: 'clock', ms: durationMs(step.clock, 'clock'), settle: step.settle ?? true, optional: step.optional ?? false, raw };
  },
  wait: (raw) => {
    const step = stepSchemas.wait.parse(raw);
    return { kind: 'wait', path: step.wait, condition: conditionOf(raw), timeoutMs: step.timeout === undefined ? DEFAULT_WAIT_TIMEOUT_MS : durationMs(step.timeout, 'timeout'), optional: step.optional ?? false, raw };
  },
  expect: (raw) => {
    const step = stepSchemas.expect.parse(raw);
    return { kind: 'expect', path: step.expect, condition: conditionOf(raw), optional: step.optional ?? false, raw };
  },
  screenshot: (raw) => {
    const step = stepSchemas.screenshot.parse(raw);
    return { kind: 'screenshot', name: step.screenshot, optional: step.optional ?? false, raw };
  },
  reset: (raw) => {
    const step = stepSchemas.reset.parse(raw);
    return { kind: 'reset', optional: step.optional ?? false, raw };
  },
};

type Locator = (path: ReadonlyArray<string | number>) => number | undefined;

/**
 * Finds the 1-based line of the node at `path` in the parsed document. A map key resolves to the
 * key's own line; when the path runs past what the document has, the deepest node reached wins,
 * so an issue about a missing field points at the step that lacks it.
 */
function locator(root: YAMLMap, lines: LineCounter): Locator {
  return (path) => {
    let node: unknown = root;
    let located: unknown = root;
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
        if (!pair) break;
        located = pair.key;
        node = pair.value;
      } else if (isSeq(node)) {
        const item: unknown = node.items[Number(segment)];
        if (item === undefined) break;
        located = item;
        node = item;
      } else {
        break;
      }
    }
    const range = isNode(located) ? located.range : undefined;
    return range ? lines.linePos(range[0]).line : undefined;
  };
}

function withLine(issue: { path: Array<string | number>; message: string }, lineOf: Locator): ScenarioIssue {
  const line = lineOf(issue.path);
  return line === undefined ? issue : { ...issue, line };
}

/** Zod issues as scenario issues. An unknown-keys issue becomes one issue per key so each gets its own line. */
function fromZod(issues: ReadonlyArray<z.core.$ZodIssue>, prefix: ReadonlyArray<string | number>, lineOf: Locator): ScenarioIssue[] {
  const out: ScenarioIssue[] = [];
  for (const issue of issues) {
    const base = [...prefix, ...issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol')];
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push(withLine({ path: [...base, key], message: `unknown key ${key}` }, lineOf));
    } else {
      out.push(withLine({ path: base, message: issue.message }, lineOf));
    }
  }
  return out;
}

function invalid(file: string, issues: ScenarioIssue[]): IronbirdError {
  const first = issues[0];
  const where = first?.line === undefined ? '' : `:${first.line}`;
  const summary = first === undefined ? 'unknown problem' : first.path.length === 0 ? first.message : `${first.path.join('.')}: ${first.message}`;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return new IronbirdError('INVALID_SCENARIO', `Invalid scenario ${file}${where}: ${summary}${more}`, { file, issues });
}

/**
 * Turns scenario YAML into a validated `Scenario`, or throws `INVALID_SCENARIO` listing every
 * problem with its path and line. Payloads are not checked here: their schemas live in the app,
 * so an invalid payload fails its step at run time with `INVALID_PAYLOAD`.
 */
export function parseScenario(source: string, file: string): Scenario {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  if (doc.errors.length > 0) {
    throw invalid(
      file,
      doc.errors.map((error) => {
        const line = error.linePos?.[0]?.line;
        const message = error.message.split('\n')[0] ?? error.message;
        return line === undefined ? { path: [], message } : { path: [], message, line };
      }),
    );
  }
  const root = doc.contents;
  if (!isMap(root)) throw invalid(file, [{ path: [], message: 'expected a mapping with name and steps', line: 1 }]);
  const lineOf = locator(root, lines);
  const top = scenarioSchema.safeParse(doc.toJS());
  if (!top.success) throw invalid(file, fromZod(top.error.issues, [], lineOf));

  const issues: ScenarioIssue[] = [];
  const steps: ScenarioStep[] = [];
  top.data.steps.forEach((raw, index) => {
    const at = ['steps', index];
    const present = STEP_KINDS.filter((kind) => kind in raw);
    const kind = present[0];
    if (kind === undefined || present.length !== 1) {
      const got = present.length === 0 ? 'none' : present.join(' and ');
      issues.push(withLine({ path: at, message: `expected exactly one of ${STEP_KINDS.join(', ')}, got ${got}` }, lineOf));
      return;
    }
    try {
      steps.push(normalizers[kind](raw));
    } catch (error) {
      if (error instanceof z.ZodError) issues.push(...fromZod(error.issues, at, lineOf));
      else if (error instanceof StepIssue) issues.push(withLine({ path: [...at, ...error.path], message: error.message }, lineOf));
      else throw error;
    }
  });
  if (issues.length > 0) throw invalid(file, issues);

  return {
    name: top.data.name,
    ...(top.data.description === undefined ? {} : { description: top.data.description }),
    ...(top.data.target === undefined ? {} : { target: top.data.target }),
    steps,
  };
}
