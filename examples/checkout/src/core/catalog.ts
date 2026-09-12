export const CATALOG: Record<string, { name: string; unitCents: number }> = {
  'cut-45': { name: 'Haircut', unitCents: 4_500 },
  'beard-20': { name: 'Beard trim', unitCents: 2_000 },
  'shampoo-12': { name: 'Shampoo', unitCents: 1_200 },
};

export function priceOf(sku: string): { name: string; unitCents: number } | undefined {
  return CATALOG[sku];
}
