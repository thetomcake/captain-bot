import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../../../src');
const GATEWAY_DIR = join(SRC, 'whatsapp-gateway');
const BAILEYS = '@whiskeysockets/baileys';

/** Recursively collect every `.ts` file under a directory. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('SC-011 — the MVP never imports Baileys', () => {
  it('no file under src/ (except src/whatsapp-gateway/**) references @whiskeysockets/baileys', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.startsWith(GATEWAY_DIR))
      .filter((f) => readFileSync(f, 'utf-8').includes(BAILEYS))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
