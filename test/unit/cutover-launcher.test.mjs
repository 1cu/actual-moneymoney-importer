import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fromDate, runLauncher } from '../../scripts/cutover-launcher.mjs';

const today = new Date(2026, 10, 2, 12);

const fixture = t => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-launcher-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return {
        directory,
        repoDir: '/repo',
        configPath: '/private/config.toml',
        earliestImportDate: '2025-01-01',
        actualUrl: 'http://localhost:5006',
        nodePath: '/node',
    };
};

test('date window uses earliest date without state and the earlier overlap with valid state', () => {
    assert.equal(fromDate('2026-11-02', undefined, '2025-01-01'), '2025-01-01');
    assert.equal(fromDate('2026-11-02', 'bad', '2025-01-01'), '2025-01-01');
    assert.equal(
        fromDate('2026-11-02', '2026-10-31', '2025-01-01'),
        '2026-08-04'
    );
    assert.equal(
        fromDate('2026-11-02', '2026-07-01', '2025-01-01'),
        '2026-06-26'
    );
});

test('successful import passes explicit dates and config, writes state, then opens Actual', t => {
    const options = fixture(t);
    const calls = [];
    const spawn = (command, args) => {
        calls.push([command, args]);
        if (calls.length === 2) {
            assert.equal(
                readFileSync(
                    join(options.directory, '.actual-mmi-last-success'),
                    'utf8'
                ),
                '2026-11-02\n'
            );
        }
        return { status: 0 };
    };
    assert.deepEqual(runLauncher(options, { now: today, spawn }), {
        from: '2025-01-01',
        to: '2026-11-02',
    });
    assert.deepEqual(calls, [
        [
            '/node',
            [
                '/repo/dist/index.js',
                'import',
                '--config',
                '/private/config.toml',
                '--from=2025-01-01',
                '--to=2026-11-02',
            ],
        ],
        ['/usr/bin/open', ['http://localhost:5006']],
    ]);
});

test('failure leaves prior state intact, does not open Actual, and releases lock', t => {
    const options = fixture(t);
    const state = join(options.directory, '.actual-mmi-last-success');
    writeFileSync(state, '2026-10-31\n');
    const calls = [];
    const spawn = (command, args) => {
        calls.push([command, args]);
        return { status: 2 };
    };
    assert.throws(
        () => runLauncher(options, { now: today, spawn }),
        /Import failed \(exit 2\)/
    );
    assert.equal(readFileSync(state, 'utf8'), '2026-10-31\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0][1].join(' '), /--from=2026-08-04/);
    assert.doesNotThrow(() =>
        runLauncher(options, { now: today, spawn: () => ({ status: 0 }) })
    );
});

test('existing lock prevents a second import', t => {
    const options = fixture(t);
    mkdirSync(join(options.directory, '.actual-mmi.lock'));
    assert.throws(
        () =>
            runLauncher(options, {
                now: today,
                spawn: () => assert.fail('must not spawn'),
            }),
        /already running/
    );
});
