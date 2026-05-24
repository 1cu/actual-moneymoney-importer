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
