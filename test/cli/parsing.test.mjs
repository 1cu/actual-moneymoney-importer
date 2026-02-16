import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('shows help and exits successfully when no command is provided', () => {
    const result = runCli();

    assert.equal(result.status, 0);
    assert.match(result.output, /actual-monmon <command>/i);
    assert.match(result.output, /Commands:/);
});

test('fails with help for unknown command', () => {
    const result = runCli(['frobnicate']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Unknown command/i);
    assert.match(result.output, /actual-monmon <command>/i);
});

test('fails with help for unknown option on command', () => {
    const result = runCli(['import', '--unknownFlag']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Unknown argument/i);
    assert.match(result.output, /unknownFlag/i);
});

test('fails for out-of-range log level', () => {
    const result = runCli(['validate', '--logLevel', '8']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Invalid values/i);
    assert.match(result.output, /logLevel/i);
});

test('prints root help and exits successfully with --help', () => {
    const result = runCli(['--help']);

    assert.equal(result.status, 0);
    assert.match(result.output, /Commands:/);
    assert.match(result.output, /import/);
    assert.match(result.output, /validate/);
});
