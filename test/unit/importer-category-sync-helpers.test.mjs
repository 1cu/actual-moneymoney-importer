import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConflictPromptText } from '../../dist/utils/Importer.js';

const stripAnsi = (value) =>
    value.replace(new RegExp('\\u001B\\[[0-?]*[ -/]*[@-~]', 'gu'), ''); // eslint-disable-line no-control-regex

test('buildConflictPromptText groups transaction details, choices, and prompt label', () => {
    const prompt = stripAnsi(
        buildConflictPromptText({
            transactionName: 'Apple.com Bill, Cork IE',
            valueDate: new Date('2026-02-19'),
            amount: -5.99,
            currentCategory: 'Kommunikation & Medien > App Store Abos',
            targetCategory: 'Kommunikation & Medien > Apple Services',
        })
    );

    assert.match(prompt, /^Category conflict/m);
    assert.match(prompt, /Transaction:\s+Apple\.com Bill, Cork IE/);
    assert.match(prompt, /Date:\s+2026-02-19/);
    assert.match(prompt, /Amount:\s+-5\.99/);
    assert.match(
        prompt,
        /Keep current:\s+Kommunikation & Medien > App Store Abos/
    );
    assert.match(
        prompt,
        /Change to:\s+Kommunikation & Medien > Apple Services/
    );
    assert.match(
        prompt,
        /Choose:\s+\[y\] update\s+\[n\] keep\s+\[A\] update all\s+\[N\] keep all\s+\[q\] quit/
    );
    assert.match(prompt, /Your choice:\s*$/);
});
