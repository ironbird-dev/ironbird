/** Hosts a request may name beyond the daemon's own bind address. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * `0.0.0.0` and `::` mean "every interface", not one address a request's `Host` header could ever
 * literally name, so there is no single string to compare against. A wildcard bind already
 * requires a token, so the `Host` check is skipped rather than compared against the unreachable
 * wildcard address itself.
 */
export function isWildcardBindHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::';
}

/** Strips the port from a `Host` header, leaving a bracketed IPv6 literal intact. */
export function hostWithoutPort(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1) || value;
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/** Whether a host name may address a daemon bound to `bindHost`: loopback, the bind address itself, or anything under a wildcard bind. */
export function hostAllowed(host: string, bindHost: string): boolean {
  if (isWildcardBindHost(bindHost)) return true;
  const candidate = host.toLowerCase();
  const bound = bindHost.toLowerCase();
  return ALLOWED_HOSTS.has(candidate) || candidate === bound || candidate === `[${bound}]`;
}

/**
 * The HTTP rule: a page in the user's browser can reach a loopback daemon, so a real CLI client
 * never sends `Origin`, and a DNS-rebinding attack arrives with a `Host` the daemon was never
 * bound to (docs/protocol.md §2.1).
 */
export function isSameSite(headers: { origin?: string | undefined; host?: string | undefined }, bindHost: string): boolean {
  if (headers.origin !== undefined) return false;
  if (headers.host === undefined) return true;
  return hostAllowed(hostWithoutPort(headers.host), bindHost);
}
