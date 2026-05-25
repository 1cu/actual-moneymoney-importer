import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withApiNoiseFilter } from '../../dist/utils/ActualApiLogControl.js';

test('withApiNoiseFilter suppresses known Actual noise from console.log', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    await withApiNoiseFilter(async () => {
        console.log('Syncing since 2026-01-01');
        console.log('Got messages from server 123');
        console.log('[Breadcrumb] trace');
        console.log('keep this');
    });

    assert.deepEqual(calls, ['keep this']);
});

test('withApiNoiseFilter passes console.log through when no match', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    await withApiNoiseFilter(async () => {
        console.log('regular message');
        console.log('Syncing… but not since');
    });

    assert.deepEqual(calls, ['regular message', 'Syncing… but not since']);
});

test('withApiNoiseFilter does not affect console.info, warn, or error', async (t) => {
    const calls = { info: [], warn: [], error: [] };
    const originals = {
        info: console.info,
        warn: console.warn,
        error: console.error,
    };

    console.info = (...args) => {
        calls.info.push(args[0]);
    };
    console.warn = (...args) => {
        calls.warn.push(args[0]);
    };
    console.error = (...args) => {
        calls.error.push(args[0]);
    };
    t.after(() => {
        console.info = originals.info;
        console.warn = originals.warn;
        console.error = originals.error;
    });

    await withApiNoiseFilter(async () => {
        console.info('info: Syncing since 2026-01-01');
        console.warn('warn: Got messages from server 123');
        console.error('error: [Breadcrumb] trace');
    });

    assert.deepEqual(calls.info, ['info: Syncing since 2026-01-01']);
    assert.deepEqual(calls.warn, ['warn: Got messages from server 123']);
    assert.deepEqual(calls.error, ['error: [Breadcrumb] trace']);
});

test('withApiNoiseFilter restores console.log after errors', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    await assert.rejects(
        () =>
            withApiNoiseFilter(async () => {
                console.log('Syncing since 2026-01-01');
                throw new Error('boom');
            }),
        /boom/
    );

    assert.deepEqual(calls, []);
    console.log('post-restore');
    assert.deepEqual(calls, ['post-restore']);
});

test('withApiNoiseFilter supports nested calls', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    await withApiNoiseFilter(async () => {
        await withApiNoiseFilter(async () => {
            console.log('Syncing since 2026-01-01');
        });
        console.log('outer keep');
    });

    assert.deepEqual(calls, ['outer keep']);
});

test('withApiNoiseFilter recovers after nested error', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    await withApiNoiseFilter(async () => {
        await assert.rejects(
            () =>
                withApiNoiseFilter(async () => {
                    console.log('Syncing since 2026-01-01');
                    throw new Error('boom');
                }),
            /boom/
        );

        console.log('Syncing since 2026-01-01');
        console.log('keep outer');
    });

    // Second call should still filter (depth tracking recovered)
    await withApiNoiseFilter(async () => {
        console.log('Syncing since 2026-01-01');
        console.log('keep post recovery');
    });

    assert.deepEqual(calls, ['keep outer', 'keep post recovery']);
});

test('withApiNoiseFilter suppresses known Actual noise from stdout.write', async (t) => {
    const calls = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (data) => {
        calls.push(
            typeof data === 'string'
                ? data
                : Buffer.from(data).toString('utf-8')
        );
        return true;
    };
    t.after(() => {
        process.stdout.write = originalWrite;
    });

    await withApiNoiseFilter(async () => {
        process.stdout.write('Syncing since 2026-01-01\n');
        process.stdout.write('Got messages from server 123\n');
        process.stdout.write('keep this\n');
    });

    assert.deepEqual(calls, ['keep this\n']);
});

test('withApiNoiseFilter restores stdout.write after errors', async () => {
    const originalWrite = process.stdout.write;

    await assert.rejects(
        () =>
            withApiNoiseFilter(async () => {
                process.stdout.write('Syncing since 2026-01-01\n');
                throw new Error('boom');
            }),
        /boom/
    );

    assert.equal(process.stdout.write, originalWrite);
});

test('withApiNoiseFilter restores globals after overlapping calls where outer finishes first', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Outer starts first, inner starts second, outer finishes first
    const outer = withApiNoiseFilter(async () => {
        console.log('outer before');
        await delay(50); // shorter delay — outer finishes first
        console.log('outer after');
    });

    const inner = withApiNoiseFilter(async () => {
        console.log('Syncing since 2026-01-01');
        await delay(200); // longer delay — inner finishes second
    });

    await outer; // finishes first
    await inner; // finishes second

    // After both complete, globals should be restored
    console.log('post-restore');
    assert.deepEqual(calls, ['outer before', 'outer after', 'post-restore']);
});

test('withApiNoiseFilter suppresses Loaded spreadsheet from cache noise', async (t) => {
    const calls = [];
    const originalLog = console.log;

    console.log = (...args) => {
        calls.push(args[0]);
    };
    t.after(() => {
        console.log = originalLog;
    });

    await withApiNoiseFilter(async () => {
        console.log('Loaded spreadsheet from cache /path/to/file');
        console.log('keep this');
    });

    assert.deepEqual(calls, ['keep this']);
});

test('withApiNoiseFilter does not suppress standalone newline after a noise pattern on stdout (known gap)', async (t) => {
    // When Actual splits "Syncing since ..." and "\n" across separate
    // process.stdout.write calls, the standalone "\n" does not match a
    // noise pattern and leaks as a blank line. Documenting this rather
    // than fixing it here keeps the filter simple.
    const calls = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (data) => {
        calls.push(
            typeof data === 'string'
                ? data
                : Buffer.from(data).toString('utf-8')
        );
        return true;
    };
    t.after(() => {
        process.stdout.write = originalWrite;
    });

    await withApiNoiseFilter(async () => {
        process.stdout.write('Syncing since 2026-01-01');
        process.stdout.write('\n');
    });

    // The noise line is suppressed, but the "\n" leaks through.
    assert.deepEqual(calls, ['\n']);
});

test('withApiNoiseFilter suppresses whole stdout chunk when it starts with noise', async (t) => {
    // When a single write contains multiple newline-separated lines and
    // the trimmed chunk starts with a noise pattern, the entire chunk
    // is suppressed — including any non-noise lines after the first.
    const calls = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = (data) => {
        calls.push(
            typeof data === 'string'
                ? data
                : Buffer.from(data).toString('utf-8')
        );
        return true;
    };
    t.after(() => {
        process.stdout.write = originalWrite;
    });

    await withApiNoiseFilter(async () => {
        process.stdout.write('Syncing since 2026-01-01\nimportant output\n');
    });

    // Whole chunk suppressed because trimmed text starts with "Syncing since".
    assert.deepEqual(calls, []);
});
