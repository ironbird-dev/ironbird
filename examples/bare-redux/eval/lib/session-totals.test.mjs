import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../../../checkout/eval/lib/transcript.mjs';
import { allDeniedCalls, fullReport, sessionResult } from './session-totals.mjs';

const lines = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const first = { type: 'result', subtype: 'success', is_error: false, result: 'Wired it in.', total_cost_usd: 0.39, duration_ms: 107_905, num_turns: 47, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'a' }, { tool_name: 'Bash', tool_use_id: 'b' }] };
const second = { type: 'result', subtype: 'success', is_error: false, result: 'The daemon is stopped.', total_cost_usd: 0.41, duration_ms: 6_011, num_turns: 2, permission_denials: [] };

describe('sessionResult', () => {
  it('sums time and turns over every result event, takes the cost from the last, and keeps the first report', () => {
    const parsed = parseTranscript(lines({ type: 'system', subtype: 'init' }, first, { type: 'system', subtype: 'task_notification' }, second));
    expect(sessionResult(parsed)).toEqual({
      subtype: 'success',
      isError: false,
      costUsd: 0.41,
      durationMs: 113_916,
      numTurns: 49,
      resultEvents: 2,
      firstReport: { durationMs: 107_905, numTurns: 47, costUsd: 0.39 },
    });
  });

  it('is the same single-turn figures when there is one result event', () => {
    expect(sessionResult(parseTranscript(lines(first)))).toMatchObject({ costUsd: 0.39, durationMs: 107_905, numTurns: 47, resultEvents: 1, firstReport: { durationMs: 107_905, numTurns: 47, costUsd: 0.39 } });
  });

  it('is null without a result event', () => {
    expect(sessionResult(parseTranscript(lines({ type: 'system', subtype: 'init' })))).toBeNull();
  });

  it('treats a missing figure as zero rather than NaN', () => {
    expect(sessionResult(parseTranscript(lines({ type: 'result', subtype: 'error_max_budget_usd', is_error: true })))).toMatchObject({ durationMs: 0, numTurns: 0, isError: true });
  });
});

describe('allDeniedCalls', () => {
  it('counts the denials of every result event, not only the last', () => {
    expect(allDeniedCalls(parseTranscript(lines(first, second)))).toBe(2);
  });

  it('counts a call once when a permission_denied event and a result event both name it', () => {
    const denied = { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'a' };
    expect(allDeniedCalls(parseTranscript(lines(denied, { type: 'system', subtype: 'permission_denied', tool_use_id: 'c' }, first, second)))).toBe(3);
  });

  it('counts permission_denied events when the session has no result event', () => {
    expect(allDeniedCalls(parseTranscript(lines({ type: 'system', subtype: 'permission_denied', tool_use_id: 'a' })))).toBe(1);
  });

  it('is 0 for a session with no denial', () => {
    expect(allDeniedCalls(parseTranscript(lines(second)))).toBe(0);
    expect(allDeniedCalls(parseTranscript(''))).toBe(0);
  });
});

describe('fullReport', () => {
  it('is the result text when there is one result event', () => {
    expect(fullReport(parseTranscript(lines(first)))).toBe('Wired it in.');
  });

  it('puts every result event in order and marks the first as the report', () => {
    expect(fullReport(parseTranscript(lines(first, second, { ...second, result: 'Done.' })))).toBe(
      '## Report (result 1 of 3)\n\nWired it in.\n\n## Follow-up (result 2 of 3)\n\nThe daemon is stopped.\n\n## Follow-up (result 3 of 3)\n\nDone.',
    );
  });

  it('skips a result event with no text but keeps the numbering of the others', () => {
    expect(fullReport(parseTranscript(lines(first, { ...second, result: '' })))).toBe('Wired it in.');
  });

  it('falls back to the last assistant text when the session was cut off', () => {
    const cut = lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'Half way.' }] } });
    expect(fullReport(parseTranscript(cut))).toBe('Half way.');
  });
});
