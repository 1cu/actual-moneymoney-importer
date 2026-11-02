import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const journalName = 'cutover-rule-journal.json';
const fields = rule => ({
    stage: rule.stage,
    conditionsOp: rule.conditionsOp,
    conditions: rule.conditions,
    actions: rule.actions,
});
const generatedTypes = {
    imported_payee: 'string',
    payee: 'id',
    category: 'id',
};
const sameRule = (left, right) => {
    const actual = fields(left);
    const expected = fields(right);
    for (const part of ['conditions', 'actions']) {
        actual[part] = actual[part].map((item, index) => {
            if (
                expected[part][index]?.type !== undefined ||
                item.type !== generatedTypes[item.field]
            )
                return item;
            const { type: _generatedType, ...semantic } = item;
            return semantic;
        });
    }
    return isDeepStrictEqual(actual, expected);
};
const byId = rules => new Map(rules.map(rule => [rule.id, rule]));
const journalPath = directory => path.join(directory, journalName);

async function readJournal(directory) {
    try {
        return JSON.parse(await fs.readFile(journalPath(directory), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeJournal(directory, journal) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${journalName}.${randomUUID()}`);
    try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(journal, null, 2));
            await file.sync();
        } finally {
            await file.close();
        }
        await fs.rename(temporary, journalPath(directory));
        const parent = await fs.open(directory, 'r');
        try {
            await parent.sync();
        } finally {
            await parent.close();
        }
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

function validateProposal(proposal, currentRules) {
    if (!Array.isArray(proposal.create) || !Array.isArray(proposal.delete)) {
        throw new Error('Invalid rule proposal');
    }
    const existing = byId(currentRules);
    if (new Set(proposal.delete).size !== proposal.delete.length) {
        throw new Error('Duplicate rule deletion ID');
    }
    const deletedOriginals = proposal.delete.map(id => {
        const rule = existing.get(id);
        if (!rule) throw new Error(`Rule to delete is missing: ${id}`);
        if (rule.actions?.some(action => action.op === 'link-schedule')) {
            throw new Error(`Schedule rule cannot be deleted: ${id}`);
        }
        return rule;
    });
    for (const candidate of proposal.create) {
        if (
            candidate.id ||
            !Array.isArray(candidate.conditions) ||
            !Array.isArray(candidate.actions) ||
            (candidate.stage !== 'pre' &&
                candidate.stage !== 'post' &&
                candidate.stage !== null) ||
            !['and', 'or'].includes(candidate.conditionsOp)
        ) {
            throw new Error('Invalid rule creation candidate');
        }
    }
    return {
        version: 1,
        plannedCreates: proposal.create.map(rule => ({
            id: randomUUID(),
            rule: { ...rule },
        })),
        deletedOriginals,
        baselineRules: currentRules.map(rule => ({
            id: rule.id,
            ...fields(rule),
        })),
    };
}

function checkJournal(journal, proposal) {
    if (
        journal.version !== 1 ||
        !Array.isArray(journal.plannedCreates) ||
        !Array.isArray(journal.deletedOriginals) ||
        !Array.isArray(journal.baselineRules)
    ) {
        throw new Error('Invalid cutover rule journal');
    }
    if (
        !isDeepStrictEqual(
            journal.plannedCreates.map(item => fields(item.rule)),
            proposal.create.map(fields)
        ) ||
        !isDeepStrictEqual(
            journal.deletedOriginals.map(rule => rule.id),
            proposal.delete
        )
    ) {
        throw new Error('Rule proposal differs from existing journal');
    }
}

function applyDrift(journal, currentRules) {
    const existing = byId(currentRules);
    const drift = [];
    for (const { id, rule } of journal.plannedCreates) {
        const current = existing.get(id);
        if (current && !sameRule(current, rule))
            drift.push({ id, reason: 'created-rule-edited' });
        if (
            [...existing.values()].some(
                other => other.id !== id && sameRule(other, rule)
            )
        ) {
            drift.push({ id, reason: 'equivalent-rule-already-exists' });
        }
    }
    for (const rule of journal.deletedOriginals) {
        const current = existing.get(rule.id);
        if (current && !sameRule(current, rule))
            drift.push({ id: rule.id, reason: 'deleted-rule-edited' });
    }
    return drift;
}

function unrelatedDrift(journal, currentRules) {
    const existing = byId(currentRules);
    const deletedIDs = new Set(journal.deletedOriginals.map(rule => rule.id));
    return journal.baselineRules
        .filter(
            rule =>
                !deletedIDs.has(rule.id) &&
                (!existing.has(rule.id) ||
                    !sameRule(existing.get(rule.id), rule))
        )
        .map(rule => ({ id: rule.id, reason: 'unrelated-rule-changed' }));
}

export async function applyRules({ api, proposal, directory, currentRules }) {
    let journal = await readJournal(directory);
    if (journal) checkJournal(journal, proposal);
    else {
        journal = validateProposal(proposal, currentRules);
        const drift = [
            ...applyDrift(journal, currentRules),
            ...unrelatedDrift(journal, currentRules),
        ];
        if (drift.length)
            throw new Error(
                `Rule drift before apply: ${JSON.stringify(drift)}`
            );
        await writeJournal(directory, journal);
    }
    const drift = [
        ...applyDrift(journal, currentRules),
        ...unrelatedDrift(journal, currentRules),
    ];
    if (drift.length)
        throw new Error(`Rule drift before apply: ${JSON.stringify(drift)}`);
    const existing = byId(currentRules);
    let created = 0;
    let deleted = 0;
    for (const { id, rule } of journal.plannedCreates) {
        if (existing.has(id)) continue;
        const result = await api.createRule({ ...rule, id, tombstone: 0 });
        if (result?.id !== id)
            throw new Error(`Actual did not preserve rule ID ${id}`);
        created++;
    }
    for (const rule of journal.deletedOriginals) {
        if (!existing.has(rule.id)) continue;
        if ((await api.deleteRule(rule.id)) === false) {
            throw new Error(`Actual refused to delete rule ${rule.id}`);
        }
        deleted++;
    }
    return { created, deleted, journal: journalPath(directory) };
}

export async function restoreRules({ api, directory, currentRules }) {
    const journal = await readJournal(directory);
    if (!journal) throw new Error('Cutover rule journal is missing');
    if (journal.version !== 1) throw new Error('Invalid cutover rule journal');
    const existing = byId(currentRules);
    const drift = applyDrift(journal, currentRules);
    if (drift.length)
        throw new Error(`Rule drift before restore: ${JSON.stringify(drift)}`);
    let removed = 0;
    let restored = 0;
    for (const { id } of journal.plannedCreates) {
        if (!existing.has(id)) continue;
        if ((await api.deleteRule(id)) === false)
            throw new Error(`Actual refused to delete created rule ${id}`);
        removed++;
    }
    for (const rule of journal.deletedOriginals) {
        if (existing.has(rule.id)) continue;
        const result = await api.createRule({ ...rule, tombstone: 0 });
        if (result?.id !== rule.id)
            throw new Error(`Actual did not restore rule ID ${rule.id}`);
        restored++;
    }
    return { removed, restored, journal: journalPath(directory) };
}
