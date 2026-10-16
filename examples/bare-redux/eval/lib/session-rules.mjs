// Which processes, ports, and paths belong to a proxy session. Unlike M3, the agent starts its own
// daemon (and may start Metro), and Claude Code's background Bash commands can leave its process
// group, so a process also counts as the session's when it works inside the session's project.
import os from 'node:os';

/** Pids whose working directory is one of `dirs` or inside it, from `lsof -d cwd -Fpn` output (`p<pid>`, `fcwd`, `n<path>` lines). Sorted, unique. */
export function pidsWithCwdUnder(lsofOutput, dirs) {
  const pids = new Set();
  let pid;
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) {
      const cwd = line.slice(1);
      if (dirs.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`))) pids.add(pid);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

/** Port listeners (`{ port, pid, pgid }`) split into the session's (a group the harness started, or a process working in the session) and anyone else's. */
export function classifyListeners(owners, { ownedGroups, sessionPids }) {
  const ours = [];
  const unknown = [];
  for (const owner of owners) (ownedGroups.includes(owner.pgid) || sessionPids.includes(owner.pid) ? ours : unknown).push(owner);
  return { ours, unknown };
}

/** Temporary folders: build tools write there, and naming one is not reaching for the repository or the eval home. */
export const TMP_ROOTS = [...new Set(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()])];

/** The out-of-folder hits (from outOfFolderPaths) that invalidate a session: everything outside the temporary folders. */
export function outsideProblems(hits, tmpRoots = TMP_ROOTS) {
  return hits.filter((hit) => !tmpRoots.some((root) => hit.path === root || hit.path.startsWith(`${root}/`)));
}
