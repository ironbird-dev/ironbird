/**
 * The string `ironbird verify-bundle` searches release output for. It is sent in every `hello`
 * message so no minifier can drop it, and it is defined here and nowhere else: `@ironbird/core`
 * can legitimately ship in a release bundle, so the literal must not appear in any other package
 * (AGENTS.md hard rule 3).
 */
export const BRIDGE_MARKER = '__IRONBIRD_BRIDGE_v1__';
