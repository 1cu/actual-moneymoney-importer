import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../../dist/index.js');

const runCli = (args = []) => {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
        encoding: 'utf8',
    });

    return {
        ...result,
        output: `${result.stdout}${result.stderr}`,
    };
};

test('validate creates nested config directories when missing', async (t) => {
    const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), 'actual-mmi-validate-')
    );
    const configPath = path.join(tempRoot, 'deep', 'nested', 'config.toml');

    t.after(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    const firstRun = runCli(['validate', '--config', configPath]);

    assert.equal(firstRun.status, 0);
    assert.match(firstRun.output, /Configuration file not found\./);
    assert.match(firstRun.output, /Created default configuration file at:/);

    const createdConfig = await readFile(configPath, 'utf8');
    assert.match(createdConfig, /\[payeeTransformation\]/);

    const secondRun = runCli(['validate', '--config', configPath]);

    assert.equal(secondRun.status, 0);
    assert.match(secondRun.output, /Configuration file is valid\./);
});
