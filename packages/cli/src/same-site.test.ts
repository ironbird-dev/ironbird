import { describe, expect, it } from 'vitest';
import { hostAllowed, hostWithoutPort, isSameSite, isWildcardBindHost } from './same-site';

describe('same-site checks', () => {
  it('strips ports and keeps IPv6 brackets', () => {
    expect(hostWithoutPort('localhost:4567')).toBe('localhost');
    expect(hostWithoutPort('[::1]:4567')).toBe('[::1]');
    expect(hostWithoutPort('Example.COM')).toBe('example.com');
  });

  it('knows the wildcard binds', () => {
    expect(isWildcardBindHost('0.0.0.0')).toBe(true);
    expect(isWildcardBindHost('::')).toBe(true);
    expect(isWildcardBindHost('127.0.0.1')).toBe(false);
  });

  it('a loopback bind accepts loopback hosts and refuses foreign ones', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) expect(hostAllowed(host, '127.0.0.1')).toBe(true);
    expect(hostAllowed('evil.example', '127.0.0.1')).toBe(false);
    expect(hostAllowed('192.168.1.5', '127.0.0.1')).toBe(false);
  });

  it('a LAN bind accepts its own address and loopback, and still refuses others', () => {
    expect(hostAllowed('192.168.1.5', '192.168.1.5')).toBe(true);
    expect(hostAllowed('localhost', '192.168.1.5')).toBe(true);
    expect(hostAllowed('192.168.1.6', '192.168.1.5')).toBe(false);
    expect(hostAllowed('[fe80::1]', 'fe80::1')).toBe(true);
  });

  it('a wildcard bind accepts any host', () => {
    expect(hostAllowed('anything.example', '0.0.0.0')).toBe(true);
  });

  it('isSameSite refuses any Origin, allows a missing Host, and applies the host rule otherwise', () => {
    expect(isSameSite({ origin: 'http://localhost:4567' }, '127.0.0.1')).toBe(false);
    expect(isSameSite({}, '127.0.0.1')).toBe(true);
    expect(isSameSite({ host: 'localhost:4567' }, '127.0.0.1')).toBe(true);
    expect(isSameSite({ host: 'evil.example:4567' }, '127.0.0.1')).toBe(false);
    expect(isSameSite({ host: 'evil.example' }, '0.0.0.0')).toBe(true);
  });
});
