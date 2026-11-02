#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const save = async (p, value) =>
    fs.writeFile(p, JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = value =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
const orderedRules = rules =>
    [...rules].sort((a, b) => a.id.localeCompare(b.id));

export function ledgerFingerprint(sourceDir) {
    const code =
        'import sqlite3,sys,json,hashlib\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nrows={t:c.execute("SELECT * FROM "+t+" ORDER BY id").fetchall() for t in ["transactions","schedules","categories"]}\nprint(hashlib.sha256(json.dumps(rows,default=str,sort_keys=True).encode()).hexdigest())';
    const result = spawnSync(
        'python3',
        ['-c', code, path.join(sourceDir, 'db.sqlite')],
        { encoding: 'utf8' }
    );
    if (result.status !== 0)
        throw Error('Could not fingerprint historical ledger');
    return result.stdout.trim();
}

export function replaceSetting(content, section, key, value) {
    let current = '';
    let count = 0;
    const lines = content.split('\n').map(line => {
        const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (heading) current = heading[1];
        if (current === section && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
            count++;
            return `${key} = ${JSON.stringify(value)}`;
        }
        return line;
    });
    if (count !== 1)
        throw new Error(`Expected exactly one ${section}.${key} setting`);
    return lines.join('\n');
}

async function preview(values) {
    const { parseConfigContent } = await import('../dist/utils/config.js');
    const { default: CategoryMap } = await import(
        '../dist/utils/CategoryMap.js'
    );
    const { default: Logger } = await import('../dist/utils/Logger.js');
    const { withOfflineBudget, previewProposal } = await import(
        './cutover-offline.mjs'
    );
    const { buildProposal } = await import('./cutover-candidates.mjs');
    const { format } = await import('date-fns');
    const { buildTransactionNotes } = await import('../dist/utils/shared.js');
    const config = parseConfigContent(await fs.readFile(values.config, 'utf8'));
    if (
        config.actualServers.length !== 1 ||
        config.actualServers[0].budgets.length !== 1
    )
        throw Error('Select a config containing exactly one server and budget');
    const budget = config.actualServers[0].budgets[0];
    const mm = await json(values['money-money']);
    const source = await json(path.join(values['source-dir'], 'metadata.json'));
    if (source.groupId !== budget.syncId)
        throw Error('Source snapshot does not match configured budget');
    const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10);
    await withOfflineBudget(
        {
            sourceDir: values['source-dir'],
            workDir: path.join(values.output, 'offline'),
        },
        async ({ api, internal }) => {
            const accounts = await api.getAccounts();
            const payees = await api.getPayees();
            const categories = (await api.getCategories()).filter(
                c => c.group_id
            );
            const groups = await api.getCategoryGroups();
            const rules = await api.getRules();
            const schedules = await api.getSchedules();
            const transactions = [];
            const matchedAccounts = [];
            for (const [ref, target] of Object.entries(budget.accountMapping)) {
                const a =
                    mm.accounts.find(a => a.uuid === ref) ??
                    mm.accounts.find(a => a.accountNumber === ref) ??
                    mm.accounts.find(a => a.name === ref);
                const t =
                    accounts.find(a => a.id === target) ??
                    accounts.find(a => a.name === target);
                if (!a || !t) throw Error('An account mapping did not resolve');
                matchedAccounts.push({ moneyMoneyId: a.uuid, actualId: t.id });
                transactions.push(...(await api.getTransactions(t.id)));
            }
            const map = new CategoryMap(budget, {}, new Logger(0));
            map.loadFromData(mm.categories, categories, groups);
            const categoryMappings = Object.fromEntries(
                mm.categories
                    .map(c => [
                        c.uuid,
                        map.getMappedActualCategoryId(c.uuid).actualCategoryId,
                    ])
                    .filter(([, v]) => v)
            );
            const mmById = new Map(
                mm.transactions.map(t => [`${t.accountUuid}-${t.id}`, t])
            );
            for (const tx of transactions) {
                const raw = mmById.get(tx.imported_id);
                if (raw)
                    tx.rawImport = {
                        imported_payee: raw.name?.trim() ?? '',
                        date: format(new Date(raw.valueDate), 'yyyy-MM-dd'),
                        amount: Math.round(raw.amount * 100),
                        notes: buildTransactionNotes(
                            raw,
                            config.import.importComments,
                            config.import.commentPrefix
                        ),
                    };
            }
            const proposal = buildProposal({
                transactions,
                payees,
                rules,
                categories,
                moneyMoneyCategories: mm.categories,
                categoryMappings,
                asOf,
            });
            await save(path.join(values.output, 'proposal.json'), proposal);
            await save(
                path.join(values.output, 'baseline-rules.json'),
                orderedRules(rules)
            );
            await save(path.join(values.output, 'baseline-data.json'), {
                accounts,
                schedules,
                categories,
                groups,
                payees,
                transactions,
            });
            await save(path.join(values.output, 'manifest.json'), {
                asOf,
                configPath: path.resolve(values.config),
                sourceDir: path.resolve(values['source-dir']),
                syncId: budget.syncId,
                rulesHash: hash(orderedRules(rules)),
                schedulesHash: hash(
                    [...schedules].sort((a, b) => a.id.localeCompare(b.id))
                ),
                configHash: hash(await fs.readFile(values.config, 'utf8')),
                matchedAccounts,
            });
            const report = await previewProposal({
                api,
                internal,
                transactions,
                proposal,
                asOf,
                keepRawPayees: values['keep-raw-payees'] ?? false,
            });
            await save(path.join(values.output, 'report.json'), report);
            const { writeReport } = await import('./cutover-report.mjs');
            await writeReport({
                directory: values.output,
                report,
                proposal,
                baseline: await json(
                    path.join(values.output, 'baseline-data.json')
                ),
            });
            const manifestPath = path.join(values.output, 'manifest.json');
            const manifest = await json(manifestPath);
            manifest.proofHash = hash({ proposal, report });
            await save(manifestPath, manifest);
            console.log(
                JSON.stringify(
                    {
                        output: values.output,
                        proposedRules: proposal.create.length,
                        proposedRemovals: proposal.delete.length,
                        safeToApply: report.safeToApply,
                        reportPath: path.join(values.output, 'report.json'),
                    },
                    null,
                    2
                )
            );
        }
    );
}

async function apply(values, restore = false) {
    const { parseConfigContent } = await import('../dist/utils/config.js');
    const { default: ActualApi } = await import('../dist/utils/ActualApi.js');
    const { default: Logger } = await import('../dist/utils/Logger.js');
    const actual = await import('@actual-app/api');
    const manifest = await json(path.join(values.output, 'manifest.json'));
    const configPath = manifest.configPath;
    const configText = await fs.readFile(configPath, 'utf8');
    const config = parseConfigContent(configText);
    const server = config.actualServers.find(s =>
        s.budgets.some(b => b.syncId === manifest.syncId)
    );
    if (!server) throw Error('Configured budget changed');
    const proposal = await json(path.join(values.output, 'proposal.json'));
    if (!restore) {
        const report = await json(path.join(values.output, 'report.json'));
        if (manifest.proofHash !== hash({ proposal, report }))
            throw Error('Proposal or report changed since preview');
        if (report.safeToApply !== true)
            throw Error(
                'Offline report does not establish safeToApply; inspect report before cutover'
            );
        if (hash(configText) !== manifest.configHash)
            throw Error('Config changed since preview');
    }
    const { DEFAULT_DATA_DIR } = await import('../dist/utils/shared.js');
    const sourceMetadata = await json(
        path.join(manifest.sourceDir, 'metadata.json')
    );
    if (
        sourceMetadata.groupId !== manifest.syncId ||
        (await fs.realpath(manifest.sourceDir)) !==
            (await fs.realpath(path.join(DEFAULT_DATA_DIR, sourceMetadata.id)))
    )
        throw Error(
            'Source must be the configured live cache for safe cutover'
        );
    const today = new Date();
    const localDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (sourceMetadata.lastScheduleRun !== localDay)
        throw Error(
            'Run a normal Actual sync today before applying; cutover will not advance schedules'
        );
    const configBackup = path.join(values.output, 'config.before.toml');
    if (!restore) {
        try {
            await fs.writeFile(configBackup, configText, {
                mode: 0o600,
                flag: 'wx',
            });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    const beforeLedger = ledgerFingerprint(manifest.sourceDir);
    const wrapper = new ActualApi(server, new Logger(0));
    await wrapper.init();
    try {
        await wrapper.loadBudget(manifest.syncId);
        const rules = await actual.getRules();
        const schedules = await actual.getSchedules();
        if (
            hash([...schedules].sort((a, b) => a.id.localeCompare(b.id))) !==
            manifest.schedulesHash
        )
            throw Error('Schedules changed since preview; regenerate preview');
        if (restore) {
            const originalConfig = parseConfigContent(
                await fs.readFile(
                    path.join(values.output, 'config.before.toml'),
                    'utf8'
                )
            );
            if (
                config.import.categorySync !== 'off' &&
                config.import.categorySync !==
                    originalConfig.import.categorySync
            )
                throw Error(
                    'Category policy changed after cutover; restore stopped'
                );
            const { restoreRules } = await import('./cutover-apply.mjs');
            await restoreRules({
                api: actual,
                directory: values.output,
                currentRules: rules,
            });
            let restored = replaceSetting(
                configText,
                'import',
                'categorySync',
                originalConfig.import.categorySync
            );
            restored = replaceSetting(
                restored,
                'payeeTransformation',
                'enabled',
                originalConfig.payeeTransformation.enabled
            );
            await fs.writeFile(configPath, restored, { mode: 0o600 });
            await wrapper.sync();
            console.log(
                'Restored cutover rules and configuration; historical transactions were not reapplied.'
            );
            return;
        }
        if (hash(orderedRules(rules)) !== manifest.rulesHash)
            throw Error('Rules changed since preview; regenerate preview');
        const backupPath = path.join(values.output, 'budget.before.zip');
        try {
            await fs.access(backupPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fs.writeFile(backupPath, await actual.exportBudget(), {
                mode: 0o600,
                flag: 'wx',
            });
        }
        await fs.access(configBackup);
        const { applyRules } = await import('./cutover-apply.mjs');
        await applyRules({
            api: actual,
            proposal,
            directory: values.output,
            currentRules: rules,
        });
        await wrapper.sync();
        if (ledgerFingerprint(manifest.sourceDir) !== beforeLedger)
            throw Error(
                'Historical ledger or schedule/category definitions changed; config switch stopped. Inspect journal.'
            );
        let next = replaceSetting(configText, 'import', 'categorySync', 'off');
        next = replaceSetting(next, 'payeeTransformation', 'enabled', false);
        const tmp = `${configPath}.cutover-tmp`;
        await fs.writeFile(tmp, next, { mode: 0o600 });
        await fs.rename(tmp, configPath);
        console.log(
            'Rules and configuration updated. Backup and journal are in the output directory.'
        );
    } finally {
        await wrapper.shutdown();
    }
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            config: {
                type: 'string',
                default: path.join(os.homedir(), '.actually/config.toml'),
            },
            'source-dir': { type: 'string' },
            'money-money': { type: 'string' },
            output: { type: 'string' },
            'as-of': { type: 'string' },
            'keep-raw-payees': { type: 'boolean', default: false },
        },
    });
    const command = positionals[0];
    if (!values.output)
        throw Error(
            '--output is required (private directory outside repository)'
        );
    values.output = path.resolve(values.output);
    const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
    if (values.output === repo || values.output.startsWith(repo + path.sep))
        throw Error('Private output must be outside repository');
    await fs.mkdir(values.output, { recursive: true, mode: 0o700 });
    await fs.chmod(values.output, 0o700);
    if (command === 'collect-money-money') {
        const mm = await import('moneymoney');
        const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10);
        const from = new Date(asOf);
        from.setUTCMonth(from.getUTCMonth() - 6);
        const accounts = await mm.getAccounts(),
            categories = await mm.getCategories(),
            transactions = await mm.getTransactions({
                from,
                to: new Date(asOf),
            });
        await save(path.join(values.output, 'money-money.json'), {
            asOf,
            accounts,
            categories,
            transactions,
        });
        console.log(
            `MoneyMoney snapshot saved privately (${transactions.length} transactions).`
        );
    } else if (command === 'preview') {
        if (!values['source-dir'] || !values['money-money'])
            throw Error('preview requires --source-dir and --money-money');
        await preview(values);
    } else if (command === 'apply' || command === 'restore') {
        await apply(values, command === 'restore');
    } else throw Error('Use collect-money-money, preview, apply or restore');
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(e => {
        console.error(e.message);
        process.exitCode = 1;
    });
