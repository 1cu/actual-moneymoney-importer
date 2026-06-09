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

test('accounts base command shows help guidance', () => {
    const result = runCli(['accounts']);

    assert.equal(result.status, 0);
    assert.match(result.output, /accounts list --help/i);
});

test('accounts list --help shows options', () => {
    const result = runCli(['accounts', 'list', '--help']);

    assert.equal(result.status, 0);
    assert.match(result.output, /--format/i);
    assert.match(result.output, /-s,\s*--server/i);
    assert.match(result.output, /-b,\s*--budget/i);
    assert.match(result.output, /--side/i);
});

test('accounts list with invalid format fails', () => {
    const result = runCli(['accounts', 'list', '--format', 'invalid']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Invalid values/i);
});

test('accounts list --format json produces valid JSON', () => {
    const result = runCli(['accounts', 'list', '--format', 'json']);

    // Will fail if MoneyMoney DB is locked, which is expected in CI
    if (result.status !== 0) {
        assert.match(result.output, /MoneyMoney database is locked/i);
        return;
    }

    assert.equal(result.status, 0);
    const parsed = JSON.parse(
        result.stdout.substring(0, result.stdout.lastIndexOf('}') + 1)
    );
    assert.ok(
        Array.isArray(parsed.moneyMoney),
        'moneyMoney should be an array'
    );
    assert.ok(Array.isArray(parsed.actual), 'actual should be an array');
});

test('accounts list --format toml prints TOML snippet', () => {
    const result = runCli(['accounts', 'list', '--format', 'toml']);

    // Will fail if MoneyMoney DB is locked, which is expected in CI
    if (result.status !== 0) {
        assert.match(result.output, /MoneyMoney database is locked/i);
        return;
    }

    assert.equal(result.status, 0);
    assert.match(result.output, /# MoneyMoney accounts/i);
    assert.match(result.output, /"<actual-account-id>"/i);
});

test('accounts list with invalid side fails', () => {
    const result = runCli(['accounts', 'list', '--side', 'invalid']);

    assert.equal(result.status, 1);
    assert.match(result.output, /Invalid values/i);
});

test('accounts list --side moneymoney skips Actual', () => {
    const result = runCli([
        'accounts',
        'list',
        '--side',
        'moneymoney',
        '--format',
        'json',
    ]);

    // Will fail if MoneyMoney DB is locked, which is expected in CI
    if (result.status !== 0) {
        assert.match(result.output, /MoneyMoney database is locked/i);
        return;
    }

    assert.equal(result.status, 0);
    const parsed = JSON.parse(
        result.stdout.substring(0, result.stdout.lastIndexOf('}') + 1)
    );
    assert.ok(
        Array.isArray(parsed.moneyMoney),
        'moneyMoney should be an array'
    );
    assert.equal(
        parsed.actual.length,
        0,
        'actual should be empty when --side moneymoney'
    );
});

test('accounts list --side actual skips MoneyMoney', () => {
    const result = runCli([
        'accounts',
        'list',
        '--side',
        'actual',
        '--format',
        'json',
        '--server',
        'http://localhost:5006',
    ]);

    // In CI with no config/server, this will fail with no matching targets
    if (result.status !== 0) {
        assert.match(
            result.output,
            /No matching server\/budget|MoneyMoney database is locked/i
        );
        return;
    }

    assert.equal(result.status, 0);
    const parsed = JSON.parse(
        result.stdout.substring(0, result.stdout.lastIndexOf('}') + 1)
    );
    assert.equal(
        parsed.moneyMoney.length,
        0,
        'moneyMoney should be empty when --side actual'
    );
    assert.ok(Array.isArray(parsed.actual), 'actual should be an array');
});
