import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Dynamic import from the compiled output
const { EXAMPLE_CONFIG } = await import(
    join(repoRoot, 'dist', 'utils', 'shared.js')
);

// EXAMPLE_CONFIG starts with a newline, strip it and ensure
// a single trailing newline for editor-friendliness.
const content = EXAMPLE_CONFIG.trimStart() + '\n';

writeFileSync(join(repoRoot, 'assets', 'config.example.toml'), content);

console.log('Generated assets/config.example.toml');
