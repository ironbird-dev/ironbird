import { describe, expect, it } from 'vitest';
import { runDirectoryPath, scenarioSlug } from './artifacts';

describe('scenarioSlug', () => {
  it('lowercases, joins runs of non-alphanumerics with one dash, trims, and caps the length', () => {
    expect(scenarioSlug('Payment success arrives before order confirmation')).toBe('payment-success-arrives-before-order-confirmation');
    expect(scenarioSlug('  Reader: disconnect!! (mid-collection)  ')).toBe('reader-disconnect-mid-collection');
    expect(scenarioSlug('!!!')).toBe('scenario');
    expect(scenarioSlug('x'.repeat(80))).toHaveLength(60);
  });
});

describe('runDirectoryPath', () => {
  it('places the run under runs/ with a UTC millisecond stamp and the slug', () => {
    expect(runDirectoryPath('/app/.ironbird', 'Shot Me!', new Date('2026-09-25T18:04:12.345Z'))).toBe('/app/.ironbird/runs/2026-09-25T18-04-12-345Z-shot-me');
  });
});
