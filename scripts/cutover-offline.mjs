import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

const denyNetwork = () => {
    throw new Error('Offline preview blocked a network call');
};

/** Open an isolated, consistent copy of an existing Actual local budget. */
export async function withOfflineBudget({ sourceDir, workDir }, callback) {
    const source = await fs.realpath(sourceDir);
    const work = path.resolve(workDir);
    if (
        work === source ||
        source.startsWith(`${work}${path.sep}`) ||
        work.startsWith(`${source}${path.sep}`)
    ) {
        throw new Error('Work directory must be separate from source budget');
    }
    const sourceMetadata = await fs.readFile(
        path.join(source, 'metadata.json'),
        'utf8'
    );
    const metadata = JSON.parse(sourceMetadata);
    if (!/^[\w-]+$/.test(metadata.id) || !metadata.id)
        throw new Error('Invalid budget ID');
    const entries = await fs.readdir(work).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    if (entries.length) throw new Error('Work directory must be empty');
    const budgetDir = path.join(work, metadata.id);
    await fs.mkdir(budgetDir, { recursive: true });
    const backup = file => {
        const sourceFile = path.join(source, file);
        const destFile = path.join(budgetDir, file);
        const code =
            'import sqlite3,sys\ns=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True)\nd=sqlite3.connect(sys.argv[2])\ns.backup(d)\nd.close()\ns.close()';
        const result = spawnSync(
            'python3',
            ['-c', code, sourceFile, destFile],
            { encoding: 'utf8' }
        );
        if (result.error || result.status !== 0)
            throw new Error(
                `SQLite backup failed for ${file}: ${result.error?.message ?? result.stderr}`
            );
    };
    backup('db.sqlite');
    const currentMetadata = await fs.readFile(
        path.join(source, 'metadata.json'),
        'utf8'
    );
    if (currentMetadata !== sourceMetadata) {
        throw new Error('Source budget metadata changed during snapshot');
    }
    const localMetadata = { ...metadata };
    for (const key of [
        'cloudFileId',
        'groupId',
        'userId',
        'lastUploaded',
        'lastSyncedTimestamp',
        'lastScheduleRun',
        'encryptKeyId',
    ])
        delete localMetadata[key];
    await fs.writeFile(
        path.join(budgetDir, 'metadata.json'),
        JSON.stringify(localMetadata)
    );

    const originals = [
        [globalThis, 'fetch'],
        [http, 'request'],
        [http, 'get'],
        [https, 'request'],
        [https, 'get'],
        [net, 'connect'],
        [net, 'createConnection'],
        [net.Socket.prototype, 'connect'],
        [tls, 'connect'],
    ].map(([object, key]) => [object, key, object[key]]);
    for (const [object, key] of originals) object[key] = denyNetwork;
    let api;
    let initialized = false;
    try {
        api = await import('@actual-app/api');
        const internal = await api.init({ dataDir: work, verbose: false });
        initialized = true;
        const loaded = await api.loadBudget(metadata.id);
        if (loaded?.error)
            throw new Error(`Offline budget load failed: ${loaded.error}`);
        return await callback({ api, internal });
    } finally {
        try {
            if (initialized) await api.shutdown();
        } finally {
            for (const [object, key, original] of originals.reverse())
                object[key] = original;
        }
    }
}

const monthOf = date => String(date).slice(0, 7);
const rollingStart = (asOf, months) => {
    const [year, month, day] = asOf.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1 - months, 1));
    const lastDay = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
    ).getUTCDate();
    first.setUTCDate(Math.min(day, lastDay) + 1);
    return first.toISOString().slice(0, 10);
};
const shiftMonth = (month, delta) => {
    const [year, m] = month.split('-').map(Number);
    const date = new Date(Date.UTC(year, m - 1 + delta, 1));
    return date.toISOString().slice(0, 7);
};
const summary = (rows, asOf, months) => {
    const start = rollingStart(asOf, months);
    const end = asOf;
    const categories = {};
    const schedules = {};
    for (const row of rows) {
        if (row.date < start || row.date > end) continue;
        const category = row.category ?? 'uncategorized';
        const schedule = row.schedule ?? 'unscheduled';
        categories[category] = (categories[category] ?? 0) + row.amount;
        schedules[schedule] = (schedules[schedule] ?? 0) + row.amount;
    }
    return { months, start, end, categories, schedules };
};

/** Replay proposed rules with Actual's own engine; all mutation stays in the scratch budget. */
export async function previewProposal({
    api,
    internal,
    transactions,
    proposal,
    asOf,
    keepRawPayees = false,
}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf))
        throw new Error('asOf must be YYYY-MM-DD');
    const input = (current, useRaw, rawPayee) => {
        const raw = (
            current.rawImport?.imported_payee ?? current.imported_payee
        )?.trim();
        const payee = useRaw && raw ? rawPayee : (current.payee ?? null);
        return {
            ...current,
            ...current.rawImport,
            category: null,
            schedule: null,
            payee,
            ...(useRaw && raw ? { payee_name: raw } : {}),
        };
    };
    const baseline = [];
    for (const transaction of transactions) {
        const special =
            transaction.transfer_id ||
            transaction.is_parent ||
            transaction.is_child ||
            transaction.starting_balance_flag ||
            transaction.imported_payee === 'Starting balance';
        baseline.push(
            special
                ? transaction
                : await internal.send('rules-run', {
                      transaction: input(transaction, false),
                  })
        );
    }
    const payeeByName = new Map(
        (await api.getPayees()).map(payee => [
            payee.name.toLocaleLowerCase(),
            payee.id,
        ])
    );
    const categories = await api.getCategories();
    const templateDefinitions = {};
    const originalTemplates = [];
    for (const category of categories) {
        const stored = await internal.send(
            'budget/get-category-automations',
            category.id
        );
        const before = stored[category.id] ?? [];
        const after = proposal.templates?.[category.id] ?? before;
        if (!before.length && !after.length) continue;
        templateDefinitions[category.id] = {
            categoryName: category.name,
            before,
            after,
        };
        for (let offset = 0; offset < 12; offset++) {
            const month = shiftMonth(monthOf(asOf), offset);
            const value = await internal.send(
                'budget/dry-run-category-template',
                { month, categoryId: category.id, templates: before }
            );
            originalTemplates.push({ month, categoryId: category.id, value });
        }
    }
    const existingRules = await api.getRules();
    const deleteIds = proposal.delete ?? [];
    for (const id of deleteIds) {
        if (!existingRules.some(rule => rule.id === id))
            throw new Error(`Unknown rule ${id}`);
        await api.deleteRule(id);
    }
    for (const rule of proposal.create ?? []) {
        const result = await api.createRule(rule);
        if (result?.error)
            throw new Error(
                `Invalid proposed rule: ${JSON.stringify(result.error)}`
            );
    }
    const details = [];
    const unresolvedAliases = new Set();
    for (const [index, current] of transactions.entries()) {
        const special =
            current.transfer_id ||
            current.is_parent ||
            current.is_child ||
            current.starting_balance_flag ||
            current.imported_payee === 'Starting balance';
        const raw = (
            current.rawImport?.imported_payee ?? current.imported_payee
        )?.trim();
        const existingRawPayee = raw
            ? payeeByName.get(raw.toLocaleLowerCase())
            : current.payee;
        let rawPayee = existingRawPayee;
        if (!special && raw && !rawPayee) {
            rawPayee = await api.createPayee({ name: raw });
            payeeByName.set(raw.toLocaleLowerCase(), rawPayee);
        }
        // Rules may create payees in this isolated budget; this mirrors Actual import resolution.
        const proposed = special
            ? current
            : await internal.send('rules-run', {
                  transaction: input(current, true, rawPayee),
              });
        if (!special && raw && !existingRawPayee && proposed.payee === rawPayee)
            unresolvedAliases.add(raw);
        details.push({
            id: current.id,
            date: current.date,
            amount: current.amount,
            importedPayee: raw ?? null,
            source: current.rawImport ? 'money-money' : 'actual-stored',
            special: Boolean(special),
            current: {
                category: current.category ?? null,
                payee: current.payee ?? null,
                schedule: current.schedule ?? null,
            },
            baseline: {
                category: baseline[index].category ?? null,
                payee: baseline[index].payee ?? null,
                schedule: baseline[index].schedule ?? null,
            },
            proposed: {
                category: proposed.category ?? null,
                payee: proposed.payee ?? null,
                schedule: proposed.schedule ?? null,
            },
        });
    }
    const windows = [1, 2, 3].map(months => {
        const current = summary(transactions, asOf, months);
        const proposed = summary(
            details.map(row => ({ ...row, ...row.proposed })),
            asOf,
            months
        );
        const delta = (a, b) =>
            Object.fromEntries(
                [...new Set([...Object.keys(a), ...Object.keys(b)])]
                    .map(key => [key, (b[key] ?? 0) - (a[key] ?? 0)])
                    .filter(([, value]) => value)
            );
        return {
            months,
            start: current.start,
            end: current.end,
            categoryDelta: delta(current.categories, proposed.categories),
            scheduleDelta: delta(current.schedules, proposed.schedules),
        };
    });
    const budgetDifferences = [];
    for (const { month, categoryId, value: before } of originalTemplates) {
        const definition = templateDefinitions[categoryId];
        const after = await internal.send('budget/dry-run-category-template', {
            month,
            categoryId,
            templates: definition.after,
        });
        budgetDifferences.push({
            month,
            categoryId,
            categoryName: definition.categoryName,
            before,
            after,
            delta: after.budgeted - before.budgeted,
        });
    }
    const recentStart = rollingStart(asOf, 3);
    const recent = details.filter(
        row => row.date >= recentStart && row.date <= asOf && !row.special
    );
    const scheduleParity = recent.every(
        row => row.baseline.schedule === row.proposed.schedule
    );
    const payeeParity = recent.every(
        row => row.baseline.payee === row.proposed.payee
    );
    const observedScheduleDifferences = details.filter(
        row => row.current.schedule !== row.proposed.schedule
    ).length;
    const historicalScheduleDifferences = details.filter(
        row => row.baseline.schedule !== row.proposed.schedule
    ).length;
    const budgetParity = budgetDifferences.every(
        row =>
            row.delta === 0 &&
            JSON.stringify(row.before.perTemplate) ===
                JSON.stringify(row.after.perTemplate)
    );
    const rawFallbacks = recent.filter(
        row => row.source === 'actual-stored'
    ).length;
    const unresolvedRecentAliases = recent.filter(row =>
        unresolvedAliases.has(row.importedPayee)
    ).length;
    return {
        safeToApply:
            scheduleParity &&
            (keepRawPayees || payeeParity) &&
            budgetParity &&
            (keepRawPayees || unresolvedRecentAliases === 0) &&
            rawFallbacks === 0,
        unresolvedPayeePolicy: keepRawPayees ? 'keep-raw' : 'require-canonical',
        parity: {
            scheduleParity,
            payeeParity,
            budgetParity,
            budgetParityScope: 'cutover-with-historical-ledger-unchanged',
            templateCategoryMonths: budgetDifferences.length,
            rawFallbacks,
            unresolvedRecentAliases,
            observedScheduleDifferences,
            historicalScheduleDifferences,
        },
        details,
        windows,
        budgetDifferences,
        templateDefinitions,
        unresolvedAliases: [...unresolvedAliases].sort(),
    };
}
