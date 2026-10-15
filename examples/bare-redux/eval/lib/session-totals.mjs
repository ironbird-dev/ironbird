// The proxy session record over the whole transcript. A proxy agent reports, and Claude Code then
// wakes it again when it kills a background task (the agent's `ironbird serve`), so a transcript can
// hold several `result` events: one per turn. `parseTranscript` keeps the last as `result` (the M3
// harness relies on that) and all of them as `results`; these functions read all of them.
import { deniedCalls, finalReport } from '../../../checkout/eval/lib/transcript.mjs';

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The session totals, or null without a result event: `durationMs` and `numTurns` summed over the
 * result events, `costUsd` from the last (`total_cost_usd` is cumulative), `subtype` and `isError`
 * from the last, and `firstReport`, the first event's figures: how long and how costly it was to the
 * first report.
 */
export function sessionResult(parsed) {
  const { results } = parsed;
  const last = results.at(-1);
  const head = results[0];
  if (!last || !head) return null;
  return {
    subtype: last.subtype,
    isError: last.is_error,
    costUsd: last.total_cost_usd,
    durationMs: results.reduce((sum, event) => sum + number(event.duration_ms), 0),
    numTurns: results.reduce((sum, event) => sum + number(event.num_turns), 0),
    resultEvents: results.length,
    firstReport: { durationMs: number(head.duration_ms), numTurns: number(head.num_turns), costUsd: head.total_cost_usd },
  };
}

/**
 * Denied tool calls over the whole transcript: the distinct tool calls named by any result event's
 * `permission_denials` or by a `permission_denied` event. M3's `deniedCalls` reads only the last
 * result event, so it is the fallback for a transcript that names none.
 */
export function allDeniedCalls(parsed) {
  const ids = new Set();
  let unnamed = 0;
  const note = (denial) => {
    if (typeof denial?.tool_use_id === 'string') ids.add(denial.tool_use_id);
    else unnamed += 1;
  };
  for (const event of parsed.events) {
    if (event?.type === 'result' && Array.isArray(event.permission_denials)) event.permission_denials.forEach(note);
    else if (event?.type === 'system' && event.subtype === 'permission_denied') note(event);
  }
  return ids.size + unnamed > 0 ? ids.size + unnamed : deniedCalls(parsed);
}

/**
 * The final report: every result event's text in order. With one it is that text; with more, the
 * first with text is headed as the report and the rest as follow-ups. Without any text it is M3's
 * `finalReport`, the last assistant text.
 */
export function fullReport(parsed) {
  const texts = parsed.results.map((event) => (typeof event.result === 'string' ? event.result.trim() : '')).map((text, index) => ({ text, index })).filter((entry) => entry.text !== '');
  if (texts.length === 0) return finalReport(parsed);
  if (texts.length === 1) return texts[0].text;
  return texts.map(({ text, index }, position) => `## ${position === 0 ? 'Report' : 'Follow-up'} (result ${index + 1} of ${parsed.results.length})\n\n${text}`).join('\n\n');
}
