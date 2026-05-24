import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { renderTextTable } from '../../dist/utils/textTable.js';

test('renderTextTable aligns emoji content using display width', () => {
    const rows = [
        ['Name', 'Amount'],
        ['💳⛽️ Tanken', '12.30'],
        ['Lebensmittel', '99.90'],
    ];

    const lines = renderTextTable(rows, {
        columns: [
            { width: 10, alignment: 'left' },
            { width: 8, alignment: 'right' },
        ],
    });

    const bodyRows = lines.filter((line) => line.startsWith('║'));
    assert.equal(bodyRows.length >= 3, true);
    const rowWidths = bodyRows.map((line) => stringWidth(line));
    assert.equal(new Set(rowWidths).size, 1);
});
test('renderTextTable truncates with ellipsis when max width is exceeded', () => {
    const rows = [
        ['Col A', 'Col B'],
        ['Very long text that should be truncated', 'Other long value'],
    ];

    const lines = renderTextTable(rows, {
        columns: [
            { width: 10, alignment: 'left', truncatePriority: 1 },
            { width: 10, alignment: 'left', truncatePriority: 2 },
        ],
        maxWidth: 30,
    });

    assert.equal(lines.join('\n').includes('…'), true);
});

test('renderTextTable respects truncation priority', () => {
    const rows = [
        ['Path', 'ID'],
        [
            'This path should truncate before the id does',
            'id-123456789012345678901234567890',
        ],
    ];

    const lines = renderTextTable(rows, {
        columns: [
            { width: 20, alignment: 'left', truncatePriority: 1 },
            { width: 30, alignment: 'left', truncatePriority: 4 },
        ],
        maxWidth: 50,
    });

    const table = lines.join('\n');
    assert.equal(
        table.includes('This path should truncate before the id does'),
        false
    );
    assert.equal(table.includes('id-1234567890'), true);
});
