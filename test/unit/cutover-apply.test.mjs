import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRules, restoreRules } from '../../scripts/cutover-apply.mjs';

const makeRule = (id, payee = 'payee-1') => ({
    id,
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ field: 'imported_payee', op: 'oneOf', value: ['Merchant'] }],
    actions: [{ field: 'payee', op: 'set', value: payee }],
});
const proposal = (create = [makeRule(null)], deleted = []) => ({
    create: create.map(({ id: _id, ...rule }) => rule),
    delete: deleted,
});

const fakeApi = (initial = []) => {
    const rules = new Map(
        initial.map(rule => [rule.id, structuredClone(rule)])
    );
    const calls = { create: 0, delete: 0 };
    return {
        rules,
        calls,
        async createRule(rule) {
            calls.create++;
            rules.set(rule.id, structuredClone(rule));
            return rule;
        },
        async deleteRule(id) {
            calls.delete++;
            rules.delete(id);
            return true;
        },
        currentRules() {
            return [...rules.values()];
        },
    };
};

async function withDirectory(callback) {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'cutover-rules-')
    );
    try {
        await callback(directory);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

test('journal precedes create, retry resumes after interruption, and repeat is idempotent', async () => {
    await withDirectory(async directory => {
        const api = fakeApi();
        const originalCreate = api.createRule;
        api.createRule = async rule => {
            await originalCreate(rule);
            throw new Error('interrupted after create');
        };
        const wanted = proposal();
        await assert.rejects(
            () =>
                applyRules({
                    api,
                    proposal: wanted,
                    directory,
                    currentRules: [],
                }),
            /interrupted/
        );
        const journalPath = path.join(directory, 'cutover-rule-journal.json');
        const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
        assert.equal(journal.plannedCreates[0].id, api.currentRules()[0].id);
        assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);
        api.createRule = originalCreate;
        assert.deepEqual(
            await applyRules({
                api,
                proposal: wanted,
                directory,
                currentRules: api.currentRules(),
            }),
            { created: 0, deleted: 0, journal: journalPath }
        );
        assert.equal(api.calls.create, 1);
    });
});

test('restore revives deleted rule with its original ID and numeric tombstone zero', async () => {
    await withDirectory(async directory => {
        const original = makeRule('old-id');
        const api = fakeApi([original]);
        const wanted = proposal([], ['old-id']);
        await applyRules({
            api,
            proposal: wanted,
            directory,
            currentRules: api.currentRules(),
        });
        assert.equal(api.rules.has('old-id'), false);
        const result = await restoreRules({
            api,
            directory,
            currentRules: api.currentRules(),
        });
        assert.equal(result.restored, 1);
        assert.equal(api.rules.get('old-id').tombstone, 0);
        assert.equal(api.rules.get('old-id').id, 'old-id');
        const again = await restoreRules({
            api,
            directory,
            currentRules: api.currentRules(),
        });
        assert.equal(again.restored, 0);
    });
});

test('restore throws on edited created rule before touching any rule', async () => {
    await withDirectory(async directory => {
        const original = makeRule('old-id');
        const api = fakeApi([original]);
        await applyRules({
            api,
            proposal: proposal([makeRule(null, 'payee-2')], ['old-id']),
            directory,
            currentRules: api.currentRules(),
        });
        const created = api.currentRules()[0];
        created.actions[0].value = 'user-edit';
        api.rules.set(created.id, created);
        await assert.rejects(
            () =>
                restoreRules({
                    api,
                    directory,
                    currentRules: api.currentRules(),
                }),
            /created-rule-edited/
        );
        assert.equal(api.rules.has(created.id), true);
        assert.equal(api.rules.has('old-id'), false);
    });
});

test('retry rejects changes to unrelated original rules before mutation', async () => {
    await withDirectory(async directory => {
        const original = makeRule('unrelated', 'other-payee');
        const api = fakeApi([original]);
        const wanted = proposal();
        await applyRules({
            api,
            proposal: wanted,
            directory,
            currentRules: api.currentRules(),
        });
        api.rules.set('unrelated', makeRule('unrelated', 'changed-payee'));
        await assert.rejects(
            () =>
                applyRules({
                    api,
                    proposal: wanted,
                    directory,
                    currentRules: api.currentRules(),
                }),
            /unrelated-rule-changed/
        );
        assert.equal(api.calls.create, 1);
    });
});

test('apply rejects schedule rule deletion before journal or mutation', async () => {
    await withDirectory(async directory => {
        const schedule = {
            ...makeRule('scheduled'),
            actions: [{ op: 'link-schedule', value: 'sched' }],
        };
        const api = fakeApi([schedule]);
        await assert.rejects(
            () =>
                applyRules({
                    api,
                    proposal: proposal([], ['scheduled']),
                    directory,
                    currentRules: api.currentRules(),
                }),
            /Schedule rule cannot be deleted/
        );
        assert.equal(api.calls.delete, 0);
        await assert.rejects(
            fs.access(path.join(directory, 'cutover-rule-journal.json'))
        );
    });
});

test('Actual API supports apply, restore, and reapply with the journaled IDs', async () => {
    const require = createRequire(import.meta.url);
    const api = require('@actual-app/api');
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'actual-rule-model-')
    );
    let initialized = false;
    try {
        const internal = await api.init({ dataDir: directory, verbose: false });
        initialized = true;
        await internal.send('create-budget', {
            budgetName: 'Rule Model Test',
            avoidUpload: true,
            testMode: true,
        });
        const original = makeRule('aebea1cf-4d04-4c83-a64d-bfe6315d79ca');
        await api.createRule(original);
        const ruleJournalDirectory = path.join(directory, 'journal');
        const wanted = proposal([makeRule(null, 'payee-2')], [original.id]);
        await applyRules({
            api,
            proposal: wanted,
            directory: ruleJournalDirectory,
            currentRules: await api.getRules(),
        });
        const journal = JSON.parse(
            await fs.readFile(
                path.join(ruleJournalDirectory, 'cutover-rule-journal.json'),
                'utf8'
            )
        );
        const createdID = journal.plannedCreates[0].id;
        assert.equal(
            (await api.getRules()).some(item => item.id === createdID),
            true
        );
        assert.equal(
            (await api.getRules()).some(item => item.id === original.id),
            false
        );

        await restoreRules({
            api,
            directory: ruleJournalDirectory,
            currentRules: await api.getRules(),
        });
        assert.equal(
            (await api.getRules()).some(item => item.id === createdID),
            false
        );
        assert.equal(
            (await api.getRules()).some(item => item.id === original.id),
            true
        );

        await applyRules({
            api,
            proposal: wanted,
            directory: ruleJournalDirectory,
            currentRules: await api.getRules(),
        });
        assert.equal(
            (await api.getRules()).some(item => item.id === createdID),
            true
        );
        assert.equal(
            (await api.getRules()).some(item => item.id === original.id),
            false
        );
    } finally {
        if (initialized) await api.shutdown();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
