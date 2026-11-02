import fs from 'node:fs/promises';
import path from 'node:path';

const text = value => String(value ?? '');
const html = value =>
    text(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
const csv = value => {
    let cell = text(value);
    if (/^[\s]*[=+@-]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
};
const table = (headings, rows) =>
    `<table><thead><tr>${headings.map(item => `<th>${html(item)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(item => `<td>${html(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const list = values => values.map(text).join(', ') || '—';

const special = tx =>
    tx?.transfer_id ||
    tx?.is_parent ||
    tx?.is_child ||
    tx?.starting_balance ||
    tx?.starting_balance_flag ||
    String(tx?.imported_id ?? '').endsWith('-start') ||
    tx?.imported_payee === 'Starting balance';

export async function writeReport({ directory, report, proposal, baseline }) {
    const categories = new Map(
        (baseline.categories ?? []).map(item => [item.id, item.name])
    );
    const payees = new Map(
        (baseline.payees ?? []).map(item => [item.id, item.name])
    );
    const schedules = new Map(
        (baseline.schedules ?? []).map(item => [item.id, item.name])
    );
    const transactionById = new Map(
        (baseline.transactions ?? []).map(item => [item.id, item])
    );
    const label = (map, id, empty) =>
        id == null ? empty : (map.get(id) ?? 'Unbekannter Eintrag');
    const category = id => label(categories, id, 'Ohne Kategorie');
    const payee = id => label(payees, id, 'Ohne Empfänger');
    const schedule = id => label(schedules, id, 'Kein Zeitplan');
    const eligible = (report.details ?? []).filter(row => {
        const source = transactionById.get(row.id);
        return source && !special(source) && !row.special;
    });

    const windowSections = (report.windows ?? [])
        .filter(window => [1, 2, 3].includes(window.months))
        .map(window => {
            const rows = eligible.filter(
                row => row.date >= window.start && row.date <= window.end
            );
            const unchanged = rows.filter(
                row =>
                    row.current?.category === row.proposed?.category &&
                    row.current?.payee === row.proposed?.payee &&
                    row.current?.schedule === row.proposed?.schedule
            ).length;
            const uncategorized = rows.filter(
                row => row.proposed?.category == null
            ).length;
            const changes = rows.length - unchanged;
            const categoriesInWindow = [
                ...new Set(
                    rows.flatMap(row => [
                        row.current?.category ?? null,
                        row.proposed?.category ?? null,
                    ])
                ),
            ];
            const schedulesInWindow = [
                ...new Set(
                    rows.flatMap(row => [
                        row.current?.schedule ?? null,
                        row.proposed?.schedule ?? null,
                    ])
                ),
            ];
            return `<section><h2>${html(window.months)} Monat${window.months > 1 ? 'e' : ''}: ${html(window.start)} bis ${html(window.end)}</h2><p>Geeignete Buchungen: ${rows.length}; unverändert: ${unchanged}; geändert: ${changes}; künftig ohne Kategorie: ${uncategorized}.</p><h3>Kategorien: gespeichert und prognostiziert</h3>${table(
                ['Kategorie', 'Gespeichert', 'Prognose'],
                categoriesInWindow.map(id => [
                    category(id),
                    rows.filter(row => (row.current?.category ?? null) === id)
                        .length,
                    rows.filter(row => (row.proposed?.category ?? null) === id)
                        .length,
                ])
            )}<h3>Zeitpläne: gespeichert und prognostiziert</h3>${table(
                ['Zeitplan', 'Gespeichert', 'Prognose'],
                schedulesInWindow.map(id => [
                    schedule(id),
                    rows.filter(row => (row.current?.schedule ?? null) === id)
                        .length,
                    rows.filter(row => (row.proposed?.schedule ?? null) === id)
                        .length,
                ])
            )}</section>`;
        })
        .join('\n');

    const lastThree = report.windows?.find(window => window.months === 3);
    const recent = lastThree
        ? eligible.filter(
              row => row.date >= lastThree.start && row.date <= lastThree.end
          )
        : [];
    const detailRows = recent.map(row => [
        row.date,
        row.importedPayee || payee(row.current?.payee),
        category(row.current?.category),
        category(row.proposed?.category),
        schedule(row.current?.schedule),
        schedule(row.proposed?.schedule),
    ]);
    const headings = [
        'Datum',
        'Händler',
        'Kategorie gespeichert',
        'Kategorie Prognose',
        'Zeitplan bisher',
        'Zeitplan neu',
    ];
    const audit = proposal.audit ?? {};
    const moneyMoneyRows = (audit.moneyMoneyRules ?? []).map(rule => [
        rule.text,
        category(rule.targetCategory),
        rule.status ?? 'manuell prüfen',
        list(rule.fields ?? []),
        list(rule.operators ?? []),
        list(rule.unsupportedFields ?? []),
        rule.recentMatches ?? 0,
        rule.conflict ? 'Ja' : 'Nein',
    ]);
    const aliasRows = (audit.aliases ?? []).map(item => [
        list(item.names ?? [item.raw]),
        payee(item.payee),
        item.count ?? 0,
    ]);
    const fallbackRows = (audit.categoryFallbacks ?? []).map(item => [
        payee(item.payee),
        category(item.category),
        item.count ?? 0,
    ]);
    const skippedRows = (audit.skipped ?? []).map(item => [
        item.kind,
        item.raw ?? payee(item.payee),
        item.reason,
    ]);
    const parity = report.parity ?? {};
    const parityRows = [
        ['Zeitpläne', parity.scheduleParity],
        ['Empfänger', parity.payeeParity],
        ['Budgetvorlagen', parity.budgetParity],
        ['Ungeklärte Aliase (letzte 3 Monate)', parity.unresolvedRecentAliases],
        ['Rohdaten-Fallbacks (letzte 3 Monate)', parity.rawFallbacks],
    ].map(([name, value]) => [
        name,
        value === true ? 'Ja' : value === false ? 'Nein' : (value ?? '—'),
    ]);
    const budgetRows = (report.budgetDifferences ?? []).map(item => [
        item.month,
        item.categoryName ?? category(item.categoryId),
        item.before?.budgeted ?? '—',
        item.after?.budgeted ?? '—',
        item.delta ?? '—',
    ]);
    const document = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Actual Kategorien-Cutover</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #bbb;padding:.35rem;text-align:left;vertical-align:top}th{background:#eee}section{margin-top:2rem}</style></head><body><h1>Actual Kategorien-Cutover</h1><p><strong>Sicher zur Anwendung:</strong> ${report.safeToApply === true ? 'Ja' : 'Nein'}. Die Vorschau nutzt dieselben historischen Buchungen zur Regelerkennung und zur Prüfung. Dies ist keine unabhängige Validierung.</p><p><strong>Budget-Parität:</strong> Der historische Buchungsbestand bleibt unverändert; geprüft werden die Budgetvorlagen im Cutover-Szenario (${html(parity.budgetParityScope ?? 'Umfang unbekannt')}).</p>${windowSections}<section><h2>Buchungen der letzten 3 Monate</h2>${table(headings, detailRows)}</section><section><h2>Prüfergebnisse</h2>${table(['Prüfung', 'Ergebnis'], parityRows)}<h3>Budgetabweichungen</h3>${table(['Monat', 'Kategorie', 'Vorher', 'Nachher', 'Differenz'], budgetRows)}</section><section><h2>MoneyMoney-Regeln (vollständige Texte; keine automatische Vollübersetzung)</h2>${table(['Originaltext', 'Zielkategorie', 'Status', 'Felder', 'Operatoren', 'Nicht unterstützt', 'Treffer zuletzt', 'Konflikt'], moneyMoneyRows)}<h3>Alias-Vorschläge</h3>${table(['MoneyMoney-Name', 'Actual-Empfänger', 'Beobachtungen'], aliasRows)}<h3>Kategorie-Fallbacks</h3>${table(['Actual-Empfänger', 'Kategorie', 'Beobachtungen'], fallbackRows)}<h3>Übersprungene Vorschläge</h3>${table(['Typ', 'Name', 'Grund'], skippedRows)}</section></body></html>\n`;

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const htmlPath = path.join(directory, 'report.html');
    const csvPath = path.join(directory, 'comparison.csv');
    await fs.writeFile(htmlPath, document, { mode: 0o600 });
    await fs.writeFile(
        csvPath,
        `${[headings, ...detailRows].map(row => row.map(csv).join(',')).join('\r\n')}\r\n`,
        { mode: 0o600 }
    );
    await Promise.all([fs.chmod(htmlPath, 0o600), fs.chmod(csvPath, 0o600)]);
    return { htmlPath, csvPath };
}
