import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const generatedPath = join(repoRoot, 'assets', 'config.example.toml');

describe('assets/config.example.toml', () => {
    it('matches EXAMPLE_CONFIG from shared.ts', async () => {
        const { EXAMPLE_CONFIG } = await import(
            join(repoRoot, 'dist', 'utils', 'shared.js')
        );

        const expected = EXAMPLE_CONFIG.trimStart() + '\n';
        const actual = readFileSync(generatedPath, 'utf-8');

        assert.equal(
            actual,
            expected,
            'assets/config.example.toml is stale. Run `npm run generate:example-config` to regenerate.'
        );
    });
});
