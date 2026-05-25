import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getConfig } from '../../dist/utils/config.js';

const makeConfig = () => `
[payeeTransformation]
enabled = false

[import]
importUncheckedTransactions = true
synchronizeClearedStatus = true
synchronizeCategories = false
categorySyncOnExisting = "ask"
importComments = false
commentPrefix = "MoneyMoney Comment: "

[import.transfers]
enabled = false
categoryRefs = ["Umbuchungen > Echte Umbuchungen"]
matchWindowDays = 0

[[actualServers]]
serverUrl = "http://example.com:5006"
serverPassword = "pw"

[[actualServers.budgets]]
syncId = "budget-id"
earliestImportDate = "2026-02-31"

[actualServers.budgets.e2eEncryption]
enabled = false
password = ""

[actualServers.budgets.accountMapping]
"Account" = "actual-account"
`;

test('getConfig surfaces detailed validation errors', async (t) => {
    const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), 'actual-mmi-config-load-')
    );
    const configPath = path.join(tempRoot, 'config.toml');

    t.after(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    await writeFile(configPath, makeConfig(), 'utf8');

    await assert.rejects(
        () => getConfig({ config: configPath }),
        (error) =>
            error instanceof Error &&
            error.message.includes('Invalid configuration file:') &&
            error.message.includes(
                'actualServers.0.budgets.0.earliestImportDate'
            ) &&
            error.message.includes('real calendar date')
    );
});

const makeConfigMissingKey = () => `
[payeeTransformation]
enabled = true

[import]
importUncheckedTransactions = true
synchronizeClearedStatus = true
synchronizeCategories = false
categorySyncOnExisting = "ask"
importComments = false
commentPrefix = "MoneyMoney Comment: "

[import.transfers]
enabled = false
categoryRefs = ["Umbuchungen > Echte Umbuchungen"]
matchWindowDays = 0

[[actualServers]]
serverUrl = "http://example.com:5006"
serverPassword = "pw"

[[actualServers.budgets]]
syncId = "budget-id"
earliestImportDate = "2026-02-15"

[actualServers.budgets.e2eEncryption]
enabled = false
password = ""

[actualServers.budgets.accountMapping]
"Account" = "actual-account"
`;

test('getConfig rejects when payeeTransformation enabled without openAiApiKey key', async (t) => {
    const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), 'actual-mmi-config-load-')
    );
    const configPath = path.join(tempRoot, 'config.toml');

    t.after(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    await writeFile(configPath, makeConfigMissingKey(), 'utf8');

    await assert.rejects(
        () => getConfig({ config: configPath }),
        (error) =>
            error instanceof Error &&
            error.message.includes('Invalid configuration file:') &&
            error.message.includes('OpenAI key must not be empty')
    );
});

const makeConfigEmptyKey = () => `
[payeeTransformation]
enabled = true
openAiApiKey = ""

[import]
importUncheckedTransactions = true
synchronizeClearedStatus = true
synchronizeCategories = false
categorySyncOnExisting = "ask"
importComments = false
commentPrefix = "MoneyMoney Comment: "

[import.transfers]
enabled = false
categoryRefs = ["Umbuchungen > Echte Umbuchungen"]
matchWindowDays = 0

[[actualServers]]
serverUrl = "http://example.com:5006"
serverPassword = "pw"

[[actualServers.budgets]]
syncId = "budget-id"
earliestImportDate = "2026-02-15"

[actualServers.budgets.e2eEncryption]
enabled = false
password = ""

[actualServers.budgets.accountMapping]
"Account" = "actual-account"
`;

test('getConfig rejects when payeeTransformation enabled with empty openAiApiKey', async (t) => {
    const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), 'actual-mmi-config-load-')
    );
    const configPath = path.join(tempRoot, 'config.toml');

    t.after(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    await writeFile(configPath, makeConfigEmptyKey(), 'utf8');

    await assert.rejects(
        () => getConfig({ config: configPath }),
        (error) =>
            error instanceof Error &&
            error.message.includes('Invalid configuration file:') &&
            error.message.includes('OpenAI key must not be empty')
    );
});
