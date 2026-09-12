import { z } from 'zod';

export default z.object({ ok: z.boolean() }).parse({ ok: true });
