import { defineCommands } from '@ironbird/core';
import { z } from 'zod';

const title = z.string().trim().min(1).max(200).describe('The to-do text; surrounding spaces are trimmed');
const id = z.string().min(1).describe('A to-do id, such as t1');

export const commands = defineCommands({
  'todos.add': z.object({ title }).describe('Add a to-do; it is saved to the sync API at once'),
  'todos.toggle': z.object({ id }).describe('Mark a to-do done or not done; the change is saved'),
  'todos.rename': z.object({ id, title }).describe('Change a to-do text; the change is saved'),
});
