import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import ActualApi from '../../dist/utils/ActualApi.js';

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
