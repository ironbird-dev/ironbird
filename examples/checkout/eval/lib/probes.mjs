// Parsers for the system probes the harness uses to prove a fresh, owned setup, and the session
// deadline arithmetic. Pure, so they are unit-tested; lib/proc.mjs and lib/ironbird.mjs run the probes.

/** Whether `launchctl list` output (from `xcrun simctl spawn <udid> launchctl list`) shows Expo Go running with a pid. */
export function expoGoRunning(launchctlList) {
  return launchctlList.split('\n').some((line) => {
    const [pid, , label] = line.trim().split(/\s+/);
    return /^\d+$/.test(pid ?? '') && typeof label === 'string' && label.startsWith('UIKitApplication:host.exp.Exponent');
  });
}

/** The working directory from `lsof -a -p <pid> -d cwd -Fn` output, or undefined. */
export function lsofCwd(output) {
  const lines = output.split('\n');
  const at = lines.indexOf('fcwd');
  const name = at === -1 ? undefined : lines.slice(at + 1).find((line) => line.startsWith('n'));
  return name?.slice(1);
}

/** The process group from `ps -o pgid= -p <pid>` output, or undefined. */
export function parsePgid(output) {
  const value = Number(output.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** How long a step may wait: what it wants, cut to the time left before `deadline`, never negative. */
export function deadlineBudget(deadline, now, wantedMs) {
  return Math.max(0, Math.min(wantedMs, deadline - now));
}

/** Port listeners split into the harness's own (their process group is one it started) and anyone else's. */
export function splitOwners(listeners, ownedGroups) {
  const owned = new Set(ownedGroups);
  return {
    ours: listeners.filter((listener) => owned.has(listener.pgid)),
    unknown: listeners.filter((listener) => !owned.has(listener.pgid)),
  };
}

/**
 * Pids from `lsof -t` (one per line). lsof exits 1 with no output when nothing matches; any other
 * failure (a nonzero exit with a message, or output that is not a pid) is a failed probe and throws,
 * so a broken probe is never read as "nothing listens".
 */
export function lsofPids({ code, stdout, stderr }, what) {
  if (code === 1 && stdout.trim() === '' && stderr.trim() === '') return [];
  if (code !== 0) throw new Error(`lsof failed for ${what} (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (!/^\d+$/.test(line)) throw new Error(`lsof printed something other than a pid for ${what}: ${JSON.stringify(line)}`);
      return Number(line);
    });
}
