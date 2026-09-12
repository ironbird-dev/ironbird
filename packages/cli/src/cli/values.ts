import { UsageError } from './durations';

export function parsePayload(input: string | undefined): unknown {
  if (input === undefined) return {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new UsageError(`Payload must be valid JSON; got ${input}`);
  }
}

export function parseJsonOrString(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}
