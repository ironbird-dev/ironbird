// Writes the two images the cart header alternates between, so every add or clear decodes a
// fresh image (spec §6). Run once; the PNGs are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../assets');
mkdirSync(out, { recursive: true });

function paint(name, from, to) {
  const width = 640;
  const height = 360;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x + y) / (width + height);
      const i = (y * width + x) * 4;
      png.data[i] = Math.round(from[0] + (to[0] - from[0]) * t);
      png.data[i + 1] = Math.round(from[1] + (to[1] - from[1]) * t);
      png.data[i + 2] = Math.round(from[2] + (to[2] - from[2]) * t);
      png.data[i + 3] = 255;
    }
  }
  writeFileSync(path.join(out, name), PNG.sync.write(png));
  console.log(`wrote ${name}`);
}

paint('product-a.png', [30, 110, 200], [220, 240, 255]);
paint('product-b.png', [200, 60, 40], [255, 235, 220]);
