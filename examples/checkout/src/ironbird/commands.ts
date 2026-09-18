import { defineCommands } from '@ironbird/core';
import { z } from 'zod';

export const commands = defineCommands({
  'cart.addItem': z
    .object({ sku: z.string().describe('Catalog SKU, for example cut-45'), qty: z.number().int().positive() })
    .describe('Add an item to the current cart'),
  'cart.clear': z.object({}).describe('Remove every item from the cart'),
  'payment.start': z
    .object({ method: z.enum(['card', 'saved']).describe('card uses the reader; saved charges the stored card') })
    .describe('Start payment for the current cart'),
  'ui.setMotion': z
    .object({ motion: z.enum(['full', 'reduced']).describe('full animates status changes, list edits, and image swaps; reduced renders them instantly') })
    .describe('Switch the screen between full and reduced motion'),
});
