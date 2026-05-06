import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import ActualApi from '../../dist/utils/ActualApi.js';

const makeLogger = () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
});

test('ActualApi.getTransactions starts on 2000-01-01', async () => {
    const getTransactions = mock.fn(() => []);
    const api = new ActualApi(
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'pw',
            budgets: [],
        },
        makeLogger(),
        {
            getTransactions,
        }
    );

    await api.getTransactions('acct-1');

    assert.equal(getTransactions.mock.callCount(), 1);
    const [accountId, startDate, endDate] = getTransactions.mock.calls[0].arguments;

    assert.equal(accountId, 'acct-1');
    assert.equal(startDate, '2000-01-01');
    assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
});
