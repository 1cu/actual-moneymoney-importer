import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import ActualApi, {
    buildActualNetworkFailureError,
    extractNetworkErrorCode,
    isActualNetworkFailureError,
} from '../../dist/utils/ActualApi.js';
import { DEFAULT_DATA_DIR } from '../../dist/utils/shared.js';

const makeLogger = () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
});

const makeServerConfig = () => ({
    serverUrl: 'http://localhost:5006',
    serverPassword: 'pw',
    budgets: [],
});

const makeResponse = ({
    ok = true,
    status = 200,
    statusText = 'OK',
    json,
}) => ({
    ok,
    status,
    statusText,
    json: json ?? mock.fn(async () => ({})),
});

test('ActualApi.getTransactions starts on 2000-01-01', async () => {
    const getTransactions = mock.fn(() => []);
    const api = new ActualApi(makeServerConfig(), makeLogger(), {
        getTransactions,
    });
    api.isInitialized = true;

    await api.getTransactions('acct-1');

    assert.equal(getTransactions.mock.callCount(), 1);
    const [accountId, startDate, endDate] =
        getTransactions.mock.calls[0].arguments;

    assert.equal(accountId, 'acct-1');
    assert.equal(startDate, '2000-01-01');
    assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('ActualApi.getUserFiles surfaces login HTTP failures', async () => {
    const loginJson = mock.fn(async () => ({}));
    const fetchImpl = mock.fn(async () =>
        makeResponse({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: loginJson,
        })
    );
    const api = new ActualApi(
        makeServerConfig(),
        makeLogger(),
        undefined,
        fetchImpl
    );

    await assert.rejects(
        () => api.getUserFiles(),
        /Could not get user token: HTTP 401 Unauthorized\./
    );

    assert.equal(fetchImpl.mock.callCount(), 1);
    assert.equal(loginJson.mock.callCount(), 0);
});

test('ActualApi.getUserFiles surfaces invalid login JSON', async () => {
    const loginJson = mock.fn(async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
    });
    const fetchImpl = mock.fn(async () =>
        makeResponse({
            ok: true,
            json: loginJson,
        })
    );
    const api = new ActualApi(
        makeServerConfig(),
        makeLogger(),
        undefined,
        fetchImpl
    );

    await assert.rejects(
        () => api.getUserFiles(),
        /Could not get user token: Server returned invalid JSON\./
    );

    assert.equal(fetchImpl.mock.callCount(), 1);
    assert.equal(loginJson.mock.callCount(), 1);
});

test('ActualApi.getUserFiles surfaces files HTTP failures', async () => {
    const loginJson = mock.fn(async () => ({
        data: { token: 'token-1' },
    }));
    const filesJson = mock.fn(async () => ({}));
    const responses = [
        makeResponse({ json: loginJson }),
        makeResponse({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            json: filesJson,
        }),
    ];
    const fetchImpl = mock.fn(async () => responses.shift());
    const api = new ActualApi(
        makeServerConfig(),
        makeLogger(),
        undefined,
        fetchImpl
    );

    await assert.rejects(
        () => api.getUserFiles(),
        /Could not get user files: HTTP 502 Bad Gateway\./
    );

    assert.equal(fetchImpl.mock.callCount(), 2);
    assert.equal(loginJson.mock.callCount(), 1);
    assert.equal(filesJson.mock.callCount(), 0);
});

test('ActualApi.loadBudget translates file-has-reset PostError to actionable message', async () => {
    const fileHasResetError = { type: 'PostError', reason: 'file-has-reset' };
    const downloadBudget = mock.fn(async () => {
        throw fileHasResetError;
    });
    const api = new ActualApi(
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'pw',
            budgets: [
                {
                    syncId: 'test-budget',
                    e2eEncryption: { enabled: false },
                },
            ],
        },
        makeLogger(),
        { downloadBudget }
    );
    api.isInitialized = true;

    await assert.rejects(
        () => api.loadBudget('test-budget'),
        err => {
            assert.ok(
                err.message.includes('file-has-reset'),
                'message should mention file-has-reset'
            );
            assert.ok(
                err.message.includes(DEFAULT_DATA_DIR),
                `message should include cache path ${DEFAULT_DATA_DIR}`
            );
            assert.ok(
                err.message.includes('rerun this command'),
                'message should say "rerun this command"'
            );
            assert.ok(
                !err.message.includes('rerun import'),
                'message should not mention "rerun import"'
            );
            assert.ok(
                !err.message.includes('rm -rf'),
                'message should not include an rm -rf command'
            );
            assert.ok(
                err.cause !== undefined,
                'original error should be preserved as cause'
            );
            assert.deepEqual(err.cause, fileHasResetError);
            return true;
        }
    );

    assert.equal(
        downloadBudget.mock.callCount(),
        1,
        'downloadBudget should be called exactly once (no retry)'
    );
});

test('ActualApi.loadBudget preserves unknown downloadBudget errors unchanged', async () => {
    const originalError = new Error('download budget failed');
    const downloadBudget = mock.fn(async () => {
        throw originalError;
    });
    const api = new ActualApi(
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'pw',
            budgets: [
                {
                    syncId: 'test-budget',
                    e2eEncryption: { enabled: false },
                },
            ],
        },
        makeLogger(),
        { downloadBudget }
    );
    api.isInitialized = true;

    await assert.rejects(
        () => api.loadBudget('test-budget'),
        err => {
            assert.equal(
                err,
                originalError,
                'unknown errors should propagate exact reference'
            );
            return true;
        }
    );

    assert.equal(downloadBudget.mock.callCount(), 1);
});

test('ActualApi.loadBudget detects file-has-reset via Error message fallback', async () => {
    const downloadBudget = mock.fn(async () => {
        throw new Error('PostError: file-has-reset — sync group mismatch');
    });
    const api = new ActualApi(
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'pw',
            budgets: [
                {
                    syncId: 'test-budget',
                    e2eEncryption: { enabled: false },
                },
            ],
        },
        makeLogger(),
        { downloadBudget }
    );
    api.isInitialized = true;

    await assert.rejects(
        () => api.loadBudget('test-budget'),
        err => {
            assert.ok(
                err.message.includes('file-has-reset'),
                'message should still mention file-has-reset'
            );
            assert.ok(
                err.message.includes(DEFAULT_DATA_DIR),
                `message should include cache path ${DEFAULT_DATA_DIR}`
            );
            assert.ok(
                err.message.includes('rerun this command'),
                'message should say "rerun this command"'
            );
            assert.ok(
                err.cause instanceof Error,
                'cause should be the original Error'
            );
            return true;
        }
    );

    assert.equal(
        downloadBudget.mock.callCount(),
        1,
        'downloadBudget should be called exactly once (no retry)'
    );
});

test('ActualApi.loadBudget throws when budget syncId not found (unchanged behavior)', async () => {
    const downloadBudget = mock.fn(async () => {});
    const api = new ActualApi(
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'pw',
            budgets: [
                {
                    syncId: 'existing-budget',
                    e2eEncryption: { enabled: false },
                },
            ],
        },
        makeLogger(),
        { downloadBudget }
    );
    api.isInitialized = true;

    await assert.rejects(
        () => api.loadBudget('missing-budget'),
        /No budget with syncId 'missing-budget' found\./
    );

    assert.equal(downloadBudget.mock.callCount(), 0);
});

test('ActualApi.getUserFiles surfaces invalid files JSON', async () => {
    const loginJson = mock.fn(async () => ({
        data: { token: 'token-1' },
    }));
    const filesJson = mock.fn(async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
    });
    const responses = [
        makeResponse({ json: loginJson }),
        makeResponse({ json: filesJson }),
    ];
    const fetchImpl = mock.fn(async () => responses.shift());
    const api = new ActualApi(
        makeServerConfig(),
        makeLogger(),
        undefined,
        fetchImpl
    );

    await assert.rejects(
        () => api.getUserFiles(),
        /Could not get user files: Server returned invalid JSON\./
    );

    assert.equal(fetchImpl.mock.callCount(), 2);
    assert.equal(loginJson.mock.callCount(), 1);
    assert.equal(filesJson.mock.callCount(), 1);
});

test('ActualApi.getUserFiles preserves non-JSON body errors', async () => {
    const loginJson = mock.fn(async () => ({
        data: { token: 'token-1' },
    }));
    const filesJson = mock.fn(async () => {
        throw new Error('socket hang up');
    });
    const responses = [
        makeResponse({ json: loginJson }),
        makeResponse({ json: filesJson }),
    ];
    const fetchImpl = mock.fn(async () => responses.shift());
    const api = new ActualApi(
        makeServerConfig(),
        makeLogger(),
        undefined,
        fetchImpl
    );

    await assert.rejects(() => api.getUserFiles(), /socket hang up/);

    assert.equal(fetchImpl.mock.callCount(), 2);
    assert.equal(loginJson.mock.callCount(), 1);
    assert.equal(filesJson.mock.callCount(), 1);
});

test('ActualApi.batchUpdateTransactions sends internal batch update with runTransfers disabled', async () => {
    const send = mock.fn(async () => 'ok');
    const api = new ActualApi(makeServerConfig(), makeLogger(), {});
    api.actualInternal = { send };
    api.isInitialized = true;

    await api.batchUpdateTransactions({
        updated: [{ id: 'txn-1', date: '2026-05-11', notes: 'memo' }],
        runTransfers: false,
    });

    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(send.mock.calls[0].arguments, [
        'transactions-batch-update',
        {
            updated: [{ id: 'txn-1', date: '2026-05-11', notes: 'memo' }],
            runTransfers: false,
        },
    ]);
});

test('ActualApi.getUserFiles uses globalThis.fetch by default', async t => {
    const loginJson = mock.fn(async () => ({
        data: { token: 'token-1' },
    }));
    const filesJson = mock.fn(async () => ({
        data: [],
    }));
    const responses = [
        makeResponse({ json: loginJson }),
        makeResponse({ json: filesJson }),
    ];
    const fetchImpl = mock.fn(async () => responses.shift());
    const originalFetch = globalThis.fetch;

    globalThis.fetch = fetchImpl;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const api = new ActualApi(makeServerConfig(), makeLogger());

    await api.getUserFiles();

    assert.equal(fetchImpl.mock.callCount(), 2);
    assert.equal(loginJson.mock.callCount(), 1);
    assert.equal(filesJson.mock.callCount(), 1);
});

test('isActualNetworkFailureError detects the code and the message fallback', () => {
    assert.equal(
        isActualNetworkFailureError(
            Object.assign(new Error('Authentication failed'), {
                code: 'network-failure',
            })
        ),
        true
    );
    assert.equal(
        isActualNetworkFailureError(
            new Error('Authentication failed: network-failure')
        ),
        true
    );
    assert.equal(
        isActualNetworkFailureError(
            Object.assign(new Error('invalid password'), {
                code: 'invalid-password',
            })
        ),
        false
    );
    assert.equal(isActualNetworkFailureError('network-failure'), false);
    assert.equal(isActualNetworkFailureError(null), false);
});

test('extractNetworkErrorCode reads code, cause.code and abort names', () => {
    assert.equal(
        extractNetworkErrorCode(
            Object.assign(new TypeError('fetch failed'), {
                cause: { code: 'EHOSTUNREACH' },
            })
        ),
        'EHOSTUNREACH'
    );
    assert.equal(
        extractNetworkErrorCode(
            Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
            })
        ),
        'ECONNREFUSED'
    );
    assert.equal(
        extractNetworkErrorCode(
            Object.assign(new Error('The operation was aborted'), {
                name: 'TimeoutError',
            })
        ),
        'timeout'
    );
    assert.equal(extractNetworkErrorCode(new Error('boom')), null);
    assert.equal(extractNetworkErrorCode(undefined), null);
});

test('buildActualNetworkFailureError explains macOS Local Network blocking', () => {
    const originalError = Object.assign(
        new Error('Authentication failed: network-failure'),
        { code: 'network-failure' }
    );

    const error = buildActualNetworkFailureError({
        serverUrl: 'https://actual.example.test',
        probe: { reachable: false, code: 'EHOSTUNREACH' },
        platform: 'darwin',
        error: originalError,
    });

    assert.match(error.message, /Authentication failed: network-failure/);
    assert.match(error.message, /https:\/\/actual\.example\.test/);
    assert.match(error.message, /Network error: EHOSTUNREACH/);
    assert.match(error.message, /Local Network/);
    assert.match(
        error.message,
        /System Settings → Privacy & Security → Local Network/
    );
    assert.match(
        error.message,
        /node -e "fetch\('https:\/\/actual\.example\.test\/'\)/
    );
    assert.equal(error.cause, originalError);
});

test('buildActualNetworkFailureError omits the macOS hint elsewhere', () => {
    for (const platform of ['linux', 'win32']) {
        const error = buildActualNetworkFailureError({
            serverUrl: 'https://actual.example.test',
            probe: { reachable: false, code: 'EHOSTUNREACH' },
            platform,
            error: new Error('Authentication failed: network-failure'),
        });

        assert.doesNotMatch(error.message, /Local Network/);
        assert.match(error.message, /Network error: EHOSTUNREACH/);
    }
});

test('buildActualNetworkFailureError omits the macOS hint for non-unreachable codes', () => {
    const error = buildActualNetworkFailureError({
        serverUrl: 'https://actual.example.test',
        probe: { reachable: false, code: 'ECONNREFUSED' },
        platform: 'darwin',
        error: new Error('Authentication failed: network-failure'),
    });

    assert.doesNotMatch(error.message, /Local Network/);
    assert.match(error.message, /Network error: ECONNREFUSED/);
});

test('buildActualNetworkFailureError reports a reachable server differently', () => {
    const error = buildActualNetworkFailureError({
        serverUrl: 'https://actual.example.test',
        probe: { reachable: true },
        platform: 'darwin',
        error: new Error('Authentication failed: network-failure'),
    });

    assert.match(error.message, /responded, but the login request failed/);
    assert.match(error.message, /\/account\/login/);
    assert.doesNotMatch(error.message, /Local Network/);
    assert.doesNotMatch(error.message, /node -e/);
});

test('ActualApi.init explains network-failure using a reachability probe', async () => {
    const originalError = Object.assign(
        new Error('Authentication failed: network-failure'),
        { code: 'network-failure' }
    );
    const init = mock.fn(async () => {
        throw originalError;
    });
    const fetchImpl = mock.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'EHOSTUNREACH' },
        });
    });
    const api = new ActualApi(
        {
            serverUrl: 'http://127.0.0.1:5006',
            serverPassword: 'pw',
            budgets: [],
        },
        makeLogger(),
        { init },
        fetchImpl
    );

    await assert.rejects(
        () => api.init(),
        err => {
            assert.match(err.message, /network-failure/);
            assert.match(err.message, /http:\/\/127\.0\.0\.1:5006/);
            assert.match(err.message, /Network error: EHOSTUNREACH/);
            assert.equal(err.cause, originalError);
            return true;
        }
    );

    assert.equal(init.mock.callCount(), 1);
    assert.equal(fetchImpl.mock.callCount(), 1);
    assert.equal(fetchImpl.mock.calls[0].arguments[0], 'http://127.0.0.1:5006');
    assert.equal(api.isInitialized, false);
});

test('ActualApi.init reports a reachable server when the probe succeeds', async () => {
    const init = mock.fn(async () => {
        throw Object.assign(
            new Error('Authentication failed: network-failure'),
            { code: 'network-failure' }
        );
    });
    const fetchImpl = mock.fn(async () => ({ status: 200 }));
    const api = new ActualApi(
        {
            serverUrl: 'http://127.0.0.1:5006',
            serverPassword: 'pw',
            budgets: [],
        },
        makeLogger(),
        { init },
        fetchImpl
    );

    await assert.rejects(
        () => api.init(),
        err => {
            assert.match(
                err.message,
                /responded, but the login request failed/
            );
            assert.doesNotMatch(err.message, /Network error/);
            return true;
        }
    );

    assert.equal(fetchImpl.mock.callCount(), 1);
});

test('ActualApi.init preserves unrelated errors unchanged', async () => {
    const originalError = new Error('invalid password');
    const init = mock.fn(async () => {
        throw originalError;
    });
    const fetchImpl = mock.fn(async () => {
        throw new Error('probe should not run');
    });
    const api = new ActualApi(
        {
            serverUrl: 'http://127.0.0.1:5006',
            serverPassword: 'pw',
            budgets: [],
        },
        makeLogger(),
        { init },
        fetchImpl
    );

    await assert.rejects(
        () => api.init(),
        err => {
            assert.equal(err, originalError);
            return true;
        }
    );

    assert.equal(fetchImpl.mock.callCount(), 0);
});
