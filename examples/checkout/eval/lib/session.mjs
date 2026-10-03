// Whether a session counts (M3 design §7.2): the rules that turn what happened during a run into a
// valid or invalid session. Pure, so it is unit-tested; run-session.mjs gathers the facts.

/**
 * The verdict for one session. `reasons` are the invalid reasons gathered while it ran (a failed
 * clone or startup, a device that never registered, an outside-folder path, a copy or port
 * failure); `isolation` is the init-event check, undefined when claude never started; `deadline`
 * and `finishedAt` are ms since the epoch; `aliveGroups` lists `{ name, pgid }` for every process
 * group the harness started that is still alive after the bounded reap. Every cause is reported.
 */
export function sessionVerdict({ reasons, isolation, deadline, finishedAt, aliveGroups }) {
  const invalidReasons = [...reasons];
  if (!isolation) invalidReasons.push('isolation: never checked, because claude did not start');
  else if (!isolation.valid) invalidReasons.push(...isolation.problems.map((problem) => `isolation: ${problem}`));
  if (finishedAt > deadline) invalidReasons.push(`deadline: teardown finished ${finishedAt - deadline} ms after the absolute deadline (${new Date(deadline).toISOString()})`);
  for (const { name, pgid } of aliveGroups) invalidReasons.push(`teardown: process group ${pgid} (${name}) is still alive after the bounded reap`);
  return { valid: invalidReasons.length === 0, invalidReasons };
}
