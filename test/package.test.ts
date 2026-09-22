import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The published artifact: the bin entry must point at a built file that starts with a node shebang. */
describe('package', () => {
  const root = resolve(__dirname, '..');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { bin: Record<string, string>; files: string[]; exports: Record<string, { import: string; types: string }> };

  it('bin points at the shebang entry, not the importable CLI module', () => {
    expect(pkg.bin).toEqual({ natsacl: './dist/bin.js' });
    const source = readFileSync(resolve(root, 'src/bin.ts'), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    if (existsSync(resolve(root, 'dist/bin.js'))) {
      expect(readFileSync(resolve(root, 'dist/bin.js'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    }
  });

  it('ships dist, assets, README and LICENSE and exports the ESM entry with types', () => {
    expect(pkg.files).toEqual(['dist', 'assets', 'README.md', 'LICENSE']);
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
  });
});
