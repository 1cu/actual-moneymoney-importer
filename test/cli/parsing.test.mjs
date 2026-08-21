import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    assert.match(result.output, /actual-mmi <command>/i);
    assert.match(result.output, /Commands:/);
});

test('fails with help for unknown command', () => {
    const result = runCli(['frobnicate']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Unknown command/i);
    assert.match(result.output, /actual-mmi <command>/i);
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

test('fails for out-of-range log level via --loglevel alias', () => {
    const result = runCli(['validate', '--loglevel', '8']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Invalid values/i);
});

test('fails for out-of-range log level via -l alias', () => {
    const result = runCli(['validate', '-l', '8']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Invalid values/i);
});

test('prints root help and exits successfully with --help', () => {
    const result = runCli(['--help']);

    assert.equal(result.status, 0);
    assert.match(result.output, /Commands:/);
    assert.match(result.output, /import/);
    assert.match(result.output, /accounts/);
    assert.match(result.output, /categories/);
    assert.match(result.output, /validate/);
});

test('shows short aliases for root and import options in help', () => {
    const result = runCli(['import', '--help']);

    assert.equal(result.status, 0);
    assert.match(result.output, /-c,\s*--config/i);
    assert.match(result.output, /-l,\s*--logLevel/i);
    assert.match(result.output, /-a,\s*--account/i);
    assert.match(result.output, /-s,\s*--server/i);
    assert.match(result.output, /-b,\s*--budget/i);
    assert.match(result.output, /-f,\s*--from/i);
    assert.match(result.output, /-t,\s*--to/i);
});

test('shows categories map command help', () => {
    const result = runCli(['categories', 'map', '--help']);

    assert.equal(result.status, 0);
    assert.match(result.output, /--format/i);
    assert.match(result.output, /--write-config/i);
    assert.match(result.output, /-s,\s*--server/i);
    assert.match(result.output, /-b,\s*--budget/i);
});

test('shows categories base command guidance', () => {
    const result = runCli(['categories']);

    assert.equal(result.status, 0);
    assert.match(result.output, /categories map --help/i);
});
