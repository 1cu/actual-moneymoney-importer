import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { buildBudgetNameBySyncIdMap } from '../../dist/commands/import.command.js';

test('buildBudgetNameBySyncIdMap fails fast on user file lookup errors', async () => {
    const getUserFiles = mock.fn(async () => {
        throw new Error('login failed');
    });

    await assert.rejects(
        () =>
            buildBudgetNameBySyncIdMap(
                { getUserFiles },
                'http://example.com:5006'
            ),
        /Failed to list Actual user files for server 'http:\/\/example.com:5006': login failed/
    );

    assert.equal(getUserFiles.mock.callCount(), 1);
});
