import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeReport } from '../../scripts/cutover-report.mjs';

test('private report resolves names, excludes special rows, and escapes HTML and CSV cells', async t => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'cutover-report-')
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const baseline = {
        accounts: [],
        categories: [
            { id: 'old', name: 'Alt & <b>' },
            { id: 'new', name: 'Neu' },
        ],
        payees: [{ id: 'p', name: 'Bekannt' }],
        schedules: [{ id: 's', name: 'Monatlich' }],
        transactions: [
            { id: '1', date: '2026-10-10' },
            { id: '2', date: '2026-10-11', transfer_id: 'transfer' },
            { id: '3', date: '2026-09-10' },
        ],
    };
    const report = {
        safeToApply: false,
        parity: {
            scheduleParity: false,
            budgetParityScope: 'cutover-with-historical-ledger-unchanged',
        },
        windows: [
            { months: 1, start: '2026-10-03', end: '2026-11-02' },
            { months: 2, start: '2026-09-03', end: '2026-11-02' },
            { months: 3, start: '2026-08-03', end: '2026-11-02' },
        ],
        details: [
            {
                id: '1',
                date: '2026-10-10',
                importedPayee: '=HYPERLINK("x")\n<script>alert(1)</script>',
                current: { category: 'old', payee: 'p', schedule: 's' },
                proposed: { category: 'new', payee: 'p', schedule: null },
            },
            {
                id: '2',
                date: '2026-10-11',
                importedPayee: 'Transfer',
                current: { category: 'old', payee: 'p', schedule: 's' },
                proposed: { category: 'new', payee: 'p', schedule: null },
            },
            {
                id: '3',
                date: '2026-09-10',
                importedPayee: '-danger',
                current: { category: null, payee: 'p', schedule: null },
                proposed: { category: null, payee: 'p', schedule: null },
            },
        ],
        budgetDifferences: [],
    };
    const proposal = {
        audit: {
            moneyMoneyRules: [
                {
                    text: '<img src=x onerror=alert(1)>',
                    targetCategory: 'new',
                    status: 'manual-review',
                },
            ],
            aliases: [{ names: ['Alias & Co'], payee: 'p', count: 1 }],
            categoryFallbacks: [],
            skipped: [],
        },
    };
    const { htmlPath, csvPath } = await writeReport({
        directory,
        report,
        proposal,
        baseline,
    });
    const page = await fs.readFile(htmlPath, 'utf8');
    const comparison = await fs.readFile(csvPath, 'utf8');
    assert.match(page, /Alt &amp; &lt;b&gt;/);
    assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(page, /<script>alert\(1\)<\/script>|<img src=x/);
    assert.match(page, /Geeignete Buchungen: 1; unverändert: 0; geändert: 1/);
    assert.match(
        page,
        /Geeignete Buchungen: 2; unverändert: 1; geändert: 1; künftig ohne Kategorie: 1/
    );
    assert.match(page, /Monatlich/);
    assert.doesNotMatch(page, /<td>Transfer<\/td>/);
    assert.match(
        comparison,
        /"'=HYPERLINK\(""x""\)\n<script>alert\(1\)<\/script>"/
    );
    assert.match(comparison, /"'-danger"/);
    assert.doesNotMatch(comparison, /Transfer/);
    assert.equal((await fs.stat(htmlPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(csvPath)).mode & 0o777, 0o600);
});
