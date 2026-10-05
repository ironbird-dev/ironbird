// The false-claim review's starting list (M3 design §7.5): sentences of a session's final report
// that claim something was verified, fixed, reproduced, or passes. The reviewer adds any claim this
// misses and strikes any sentence that is not a claim; the list only saves the first read.

const CLAIM = /\b(verif\w*|fix\w*|reproduc\w*|pass\w*)\b/i;

/**
 * Candidate claim sentences, in report order. Code blocks are dropped: they quote evidence, they don't
 * claim it. Bold markers are dropped first, so `1. **label**: Passed.` stays one sentence.
 */
export function claimCandidates(text) {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/\*\*/g, '')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`*_(\d])/)
    .map((sentence) => sentence.replace(/^[\s>*#\-|]+|[\s|]+$/g, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((sentence) => sentence.length > 0 && CLAIM.test(sentence));
}

/** claims.md: one row per candidate, with Holds and Evidence left for the reviewer. */
export function claimsTable(session, candidates, success) {
  const escape = (text) => text.replace(/\|/g, '\\|');
  return [
    `# Session ${session}: claims`,
    '',
    `Final report: \`final-report.md\`. Grade: \`grade.json\` (success: ${success}). A claim holds only if the evidence it names exists and says what the claim says (M3 design §7.5).`,
    '',
    '| # | Claim | Holds | Evidence checked |',
    '|---|---|---|---|',
    ...candidates.map((claim, index) => `| ${index + 1} | ${escape(claim)} |  |  |`),
    '',
  ].join('\n');
}
