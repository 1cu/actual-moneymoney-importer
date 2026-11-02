// Pure, review-only suggestions for a MoneyMoney to Actual rule cutover.
const key = value =>
    typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';

const ordinary = tx =>
    tx &&
    !tx.transfer_id &&
    !tx.is_parent &&
    !tx.is_child &&
    !tx.starting_balance &&
    !tx.starting_balance_flag &&
    !String(tx.imported_id ?? '').endsWith('-start') &&
    key(tx.imported_payee) !== 'starting balance';

const values = condition =>
    condition?.op === 'oneOf' && Array.isArray(condition.value)
        ? condition.value
        : [condition?.value];

const hasAction = (rule, field) =>
    rule.actions?.some(action => action.op === 'set' && action.field === field);

const mayMatch = (condition, value) => {
    if (condition.op === 'is' || condition.op === 'oneOf') {
        return values(condition).includes(value);
    }
    if (condition.op === 'contains') {
        return key(value).includes(key(condition.value));
    }
    // Unknown operators need review before a new rule can safely coexist.
    return true;
};

const ruleMayMatch = (rule, field, value) => {
    const conditions =
        rule.conditions?.filter(condition => condition.field === field) ?? [];
    return (
        conditions.length === 0 ||
        conditions.some(condition => mayMatch(condition, value))
    );
};

const ruleFor = (stage, conditions, field, value) => ({
    stage,
    conditionsOp: 'and',
    conditions,
    actions: [{ field, op: 'set', value }],
});

const recent = (tx, asOf) => {
    const date = new Date(`${tx.date}T00:00:00Z`);
    const end = new Date(`${asOf}T00:00:00Z`);
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 6);
    return Number.isFinite(date.valueOf()) && date >= start && date <= end;
};

const mmRuleEntries = categories =>
    categories.flatMap(category => {
        const raw = category.rules ?? category.rule ?? '';
        const texts = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
        return texts
            .map(text => String(text).trim())
            .filter(Boolean)
            .map(text => ({
                sourceCategory: category.uuid ?? null,
                text,
            }));
    });

const literalHint = text => {
    // Only a quoted or plain merchant token is evidence, never a rule conversion.
    const match = text.match(
        /(?:^|\s)(?:payee|merchant|name)\s*(?:=|:|is)\s*["']?([^"'()*?^$|]{3,})["']?$/i
    );
    return match?.[1]?.trim() || null;
};

export function buildProposal({
    transactions = [],
    payees = [],
    rules = [],
    categories = [],
    moneyMoneyCategories = [],
    categoryMappings = {},
    asOf = new Date().toISOString().slice(0, 10),
} = {}) {
    const payeeIDs = new Set(payees.map(payee => payee.id));
    const categoryIDs = new Set(categories.map(category => category.id));
    const observations = new Map();
    const audit = {
        aliases: [],
        categoryFallbacks: [],
        skipped: [],
        moneyMoneyRules: [],
        ruleInventory: [],
    };
    const create = [];
    const deleteIDs = [];

    for (const tx of transactions) {
        const raw = key(tx.imported_payee);
        if (!ordinary(tx) || !raw) continue;
        const entry = observations.get(raw) ?? {
            names: new Set(),
            payees: new Set(),
            txs: [],
        };
        entry.names.add(tx.imported_payee.trim());
        entry.payees.add(tx.payee ?? null);
        entry.txs.push(tx);
        observations.set(raw, entry);
    }

    for (const [raw, observed] of observations) {
        const names = [...observed.names].sort();
        const payeesForRaw = [...observed.payees];
        if (payeesForRaw.length !== 1 || !payeeIDs.has(payeesForRaw[0])) {
            audit.skipped.push({
                kind: 'alias',
                raw,
                reason: 'ambiguous-payee',
                payees: payeesForRaw,
            });
            continue;
        }
        const payee = payeesForRaw[0];
        if (
            rules.some(
                rule =>
                    rule.stage === 'pre' &&
                    hasAction(rule, 'payee') &&
                    names.some(name =>
                        ruleMayMatch(rule, 'imported_payee', name)
                    )
            )
        ) {
            audit.skipped.push({ kind: 'alias', raw, reason: 'existing-rule' });
            continue;
        }
        const conditions = [
            { field: 'imported_payee', op: 'oneOf', value: names },
        ];
        create.push(ruleFor('pre', conditions, 'payee', payee));
        audit.aliases.push({ raw, names, payee, count: observed.txs.length });
    }

    const byPayee = new Map();
    for (const tx of transactions) {
        if (!ordinary(tx) || !recent(tx, asOf) || !payeeIDs.has(tx.payee))
            continue;
        const entry = byPayee.get(tx.payee) ?? [];
        entry.push(tx);
        byPayee.set(tx.payee, entry);
    }
    for (const [payee, txs] of byPayee) {
        const categorized = txs.filter(tx => tx.category);
        const distinct = [...new Set(categorized.map(tx => tx.category))];
        if (
            categorized.length < 3 ||
            distinct.length !== 1 ||
            !categoryIDs.has(distinct[0])
        ) {
            audit.skipped.push({
                kind: 'category',
                payee,
                reason: 'insufficient-or-ambiguous-history',
            });
            continue;
        }
        if (
            rules.some(
                rule =>
                    ruleMayMatch(rule, 'payee', payee) &&
                    !rule.actions?.some(
                        action => action.op === 'link-schedule'
                    ) &&
                    hasAction(rule, 'category')
            )
        ) {
            audit.skipped.push({
                kind: 'category',
                payee,
                reason: 'existing-category-rule',
            });
            continue;
        }
        const category = distinct[0];
        create.push(
            ruleFor(
                'post',
                [
                    { field: 'payee', op: 'is', value: payee },
                    { field: 'category', op: 'is', value: null },
                ],
                'category',
                category
            )
        );
        audit.categoryFallbacks.push({
            payee,
            category,
            count: categorized.length,
        });
    }

    for (const rule of rules) {
        audit.ruleInventory.push({
            id: rule.id ?? null,
            stage: rule.stage ?? null,
            conditions: (rule.conditions ?? []).map(({ field, op }) => ({
                field,
                op,
            })),
            actions: (rule.actions ?? []).map(({ field, op }) => ({
                field: field ?? null,
                op,
            })),
        });
        if (
            rule.id &&
            rule.stage === 'pre' &&
            rule.conditionsOp !== 'or' &&
            rule.conditions?.length === 1 &&
            rule.actions?.length === 1
        ) {
            const condition = rule.conditions[0];
            const action = rule.actions[0];
            const names = values(condition);
            if (
                condition.field === 'imported_payee' &&
                (condition.op === 'is' || condition.op === 'oneOf') &&
                names.length > 0 &&
                names.every(name => /lidl/i.test(name)) &&
                action.op === 'set' &&
                action.field === 'payee' &&
                observations.get(key(names[0]))?.payees.size === 1 &&
                observations.get(key(names[0]))?.payees.has(action.value) &&
                names.every(name =>
                    observations.get(key(name))?.payees.has(action.value)
                )
            ) {
                deleteIDs.push(rule.id);
            }
        }
    }

    for (const source of mmRuleEntries(moneyMoneyCategories)) {
        const target = categoryMappings[source.sourceCategory] ?? null;
        const literal = literalHint(source.text);
        const matches = literal
            ? transactions.filter(
                  tx =>
                      ordinary(tx) &&
                      key(tx.imported_payee) === key(literal) &&
                      recent(tx, asOf)
              )
            : [];
        audit.moneyMoneyRules.push({
            ...source,
            targetCategory: categoryIDs.has(target) ? target : null,
            status: 'manual-review',
            fields: [
                ...new Set(
                    source.text.match(
                        /\b(?:payee|merchant|name|amount|account|date|purpose|notes|transfer)\b/gi
                    ) ?? []
                ),
            ],
            operators: [
                ...new Set(
                    source.text.match(
                        />=|<=|!=|=|>|<|\bcontains\b|\bmatches\b/gi
                    ) ?? []
                ),
            ],
            unsupportedFields:
                source.text.match(
                    /\b(?:amount|account|date|purpose|notes|regex|wildcard|transfer)\b/gi
                ) ?? [],
            literalMerchant: literal,
            recentMatches: matches.length,
            observedPayees: [
                ...new Set(matches.map(tx => tx.payee).filter(Boolean)),
            ],
            conflict: Boolean(
                target &&
                    matches.some(tx => tx.category && tx.category !== target)
            ),
        });
    }
    return { create, delete: deleteIDs, audit };
}
