import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../../dist/index.js');

const runCli = (args = []) => {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
        encoding: 'utf8',
    });

    return {
        ...result,
        output: `${result.stdout}${result.stderr}`,
    };
};

const makeValidConfig = (serverUrl) => `
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
serverUrl = "${serverUrl}"
serverPassword = "pw"

[[actualServers.budgets]]
syncId = "budget-id"

[actualServers.budgets.e2eEncryption]
enabled = false
password = ""

[actualServers.budgets.accountMapping]
"Account" = "actual-account"
`;

test('validate creates nested config directories when missing', async (t) => {
    const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), 'actual-mmi-validate-')
    );
    const configPath = path.join(tempRoot, 'deep', 'nested', 'config.toml');

    t.after(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    const firstRun = runCli(['validate', '--config', configPath]);

    assert.equal(firstRun.status, 0);
    assert.match(firstRun.output, /Configuration file not found\./);
    assert.match(firstRun.output, /Created default configuration file at:/);

    const createdConfig = await readFile(configPath, 'utf8');
    assert.match(createdConfig, /\[payeeTransformation\]/);

    const secondRun = runCli(['validate', '--config', configPath]);

    assert.equal(secondRun.status, 0);
    assert.match(secondRun.output, /Configuration file is valid\./);
});

test('validate warns on cleartext HTTP Actual URLs but allows localhost', async (t) => {
    const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), 'actual-mmi-validate-http-')
    );
    const remoteConfigPath = path.join(tempRoot, 'remote.toml');
    const localConfigPath = path.join(tempRoot, 'local.toml');

    t.after(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    await writeFile(
        remoteConfigPath,
        makeValidConfig('http://example.com:5006'),
        'utf8'
    );
    await writeFile(
        localConfigPath,
        makeValidConfig('http://localhost:5006'),
        'utf8'
    );

    const remoteRun = runCli(['validate', '--config', remoteConfigPath]);
    assert.equal(remoteRun.status, 0);
    assert.match(remoteRun.output, /cleartext HTTP/);

    const localRun = runCli(['validate', '--config', localConfigPath]);
    assert.equal(localRun.status, 0);
    assert.doesNotMatch(localRun.output, /cleartext HTTP/);
});
