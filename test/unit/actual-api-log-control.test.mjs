import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    withApiLogControl,
    withGlobalApiNoiseFilter,
} from '../../dist/utils/ActualApiLogControl.js';

const normalizeChunk = (chunk) =>
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

const createCaptureState = () => ({
    log: [],
    info: [],
    warn: [],
    error: [],
    stdout: [],
    stderr: [],
});

const createCaptureMethods = (calls) => ({
    log: (...args) => {
        calls.log.push(args[0]);
    },
    info: (...args) => {
        calls.info.push(args[0]);
    },
    warn: (...args) => {
        calls.warn.push(args[0]);
    },
    error: (...args) => {
        calls.error.push(args[0]);
    },
    stdout: (...args) => {
        calls.stdout.push(normalizeChunk(args[0]));
        const callback = args.find((value) => typeof value === 'function');
        callback?.();
        return true;
    },
    stderr: (...args) => {
        calls.stderr.push(normalizeChunk(args[0]));
        const callback = args.find((value) => typeof value === 'function');
        callback?.();
        return true;
    },
});

const patchGlobals = (t, methods) => {
    const originals = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        stdout: process.stdout.write,
        stderr: process.stderr.write,
    };

    console.log = methods.log;
    console.info = methods.info;
    console.warn = methods.warn;
    console.error = methods.error;
    process.stdout.write = methods.stdout;
    process.stderr.write = methods.stderr;

    t.after(() => {
        console.log = originals.log;
        console.info = originals.info;
        console.warn = originals.warn;
        console.error = originals.error;
        process.stdout.write = originals.stdout;
        process.stderr.write = originals.stderr;
    });
};

test('withApiLogControl suppresses console.log when verbose is false', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withApiLogControl(false, async () => {
        console.log('hidden');
        console.info('shown');
    });

    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.info, ['shown']);
    assert.strictEqual(console.log, methods.log);
});

test('withApiLogControl passes through console.log when verbose is true', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withApiLogControl(true, async () => {
        console.log('visible');
    });

    assert.deepEqual(calls.log, ['visible']);
    assert.strictEqual(console.log, methods.log);
});

test('withApiLogControl restores console.log after errors', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await assert.rejects(
        () =>
            withApiLogControl(false, async () => {
                console.log('hidden');
                throw new Error('boom');
            }),
        /boom/
    );

    assert.deepEqual(calls.log, []);
    assert.strictEqual(console.log, methods.log);
});

test('withGlobalApiNoiseFilter suppresses known Actual noise', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withGlobalApiNoiseFilter(true, async () => {
        console.log('Syncing since 2026-01-01');
        console.warn('Got messages from server 123');
        console.error('[Breadcrumb] trace');
        console.info('keep this');
        process.stdout.write('Syncing since 2026-01-01\n');
        process.stdout.write('\n');
        process.stdout.write('keep stdout\n');
        process.stderr.write('Got messages from server 123\n');
        process.stderr.write('keep stderr\n');
    });

    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.warn, []);
    assert.deepEqual(calls.error, []);
    assert.deepEqual(calls.info, ['keep this']);
    assert.deepEqual(calls.stdout, ['keep stdout\n']);
    assert.deepEqual(calls.stderr, ['keep stderr\n']);
    assert.strictEqual(console.log, methods.log);

    process.stdout.write('after restore stdout\n');
    process.stderr.write('after restore stderr\n');

    assert.deepEqual(calls.stdout, ['keep stdout\n', 'after restore stdout\n']);
    assert.deepEqual(calls.stderr, ['keep stderr\n', 'after restore stderr\n']);
});

test('withGlobalApiNoiseFilter does not bleed newline suppression across streams', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withGlobalApiNoiseFilter(true, async () => {
        process.stdout.write('Syncing since 2026-01-01\n');
        process.stderr.write('\n');
        process.stdout.write('keep stdout\n');
        process.stderr.write('keep stderr\n');
    });

    assert.deepEqual(calls.stdout, ['keep stdout\n']);
    assert.deepEqual(calls.stderr, ['\n', 'keep stderr\n']);
});

test('withGlobalApiNoiseFilter passes through when suppression is disabled', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withGlobalApiNoiseFilter(false, async () => {
        console.log('plain log');
        process.stdout.write('plain stdout\n');
        process.stderr.write('plain stderr\n');
    });

    assert.deepEqual(calls.log, ['plain log']);
    assert.deepEqual(calls.stdout, ['plain stdout\n']);
    assert.deepEqual(calls.stderr, ['plain stderr\n']);
    assert.strictEqual(console.log, methods.log);

    process.stdout.write('after restore stdout\n');
    process.stderr.write('after restore stderr\n');

    assert.deepEqual(calls.stdout, [
        'plain stdout\n',
        'after restore stdout\n',
    ]);
    assert.deepEqual(calls.stderr, [
        'plain stderr\n',
        'after restore stderr\n',
    ]);
});

test('withGlobalApiNoiseFilter supports nested suppression', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withGlobalApiNoiseFilter(true, async () => {
        await withGlobalApiNoiseFilter(true, async () => {
            console.log('Syncing since 2026-01-01');
            process.stdout.write('Got messages from server 123\n');
        });

        console.info('still visible');
        process.stdout.write('keep outer stdout\n');
    });

    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.stdout, ['keep outer stdout\n']);
    assert.deepEqual(calls.info, ['still visible']);
});

test('withGlobalApiNoiseFilter keeps outer suppression across inner passthrough', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withGlobalApiNoiseFilter(true, async () => {
        await withGlobalApiNoiseFilter(false, async () => {
            console.log('Syncing since 2026-01-01');
            process.stdout.write('Got messages from server 123\n');
            console.info('inner visible');
        });

        console.info('outer visible');
        process.stdout.write('keep outer stdout\n');
    });

    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.info, ['inner visible', 'outer visible']);
    assert.deepEqual(calls.stdout, ['keep outer stdout\n']);
});

test('withGlobalApiNoiseFilter recovers after nested inner error', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await withGlobalApiNoiseFilter(true, async () => {
        await assert.rejects(
            () =>
                withGlobalApiNoiseFilter(true, async () => {
                    console.log('Syncing since 2026-01-01');
                    throw new Error('boom');
                }),
            /boom/
        );

        console.log('Syncing since 2026-01-01');
        process.stdout.write('keep outer stdout\n');
    });

    await withGlobalApiNoiseFilter(true, async () => {
        console.log('Syncing since 2026-01-01');
        process.stdout.write('keep post recovery stdout\n');
    });

    assert.deepEqual(calls.log, []);
    assert.deepEqual(calls.stdout, [
        'keep outer stdout\n',
        'keep post recovery stdout\n',
    ]);
});

test('withGlobalApiNoiseFilter restores globals after errors', async (t) => {
    const calls = createCaptureState();
    const methods = createCaptureMethods(calls);
    patchGlobals(t, methods);

    await assert.rejects(
        () =>
            withGlobalApiNoiseFilter(true, async () => {
                console.log('Syncing since 2026-01-01');
                throw new Error('boom');
            }),
        /boom/
    );

    assert.deepEqual(calls.log, []);
    assert.strictEqual(console.log, methods.log);

    process.stdout.write('after restore stdout\n');
    process.stderr.write('after restore stderr\n');

    assert.deepEqual(calls.stdout, ['after restore stdout\n']);
    assert.deepEqual(calls.stderr, ['after restore stderr\n']);
});
