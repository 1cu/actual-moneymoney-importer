import assert from 'node:assert/strict';
import test from 'node:test';
import {
    formatConfiguredMappingsSection,
    formatInvalidMappingsSection,
    formatPlanningWarningsSection,
    formatSafeSuggestionsSection,
    formatTableReport,
    formatTomlReport,
    formatUnresolvedMoneyMoneySection,
    formatUnusedActualSection,
} from '../../dist/commands/categories.command.js';

const makeReport = ({
    configuredMappings = [],
    invalidMappings = [],
    safeSuggestions = [],
    unresolvedMoneyMoneyCategories = [],
    unusedActualCategories = [],
    planningWarnings = [],
} = {}) => ({
    configuredMappings,
    invalidMappings,
    safeSuggestions,
    unresolvedMoneyMoneyCategories,
    unusedActualCategories,
    planningWarnings,
});

test('section formatters show None for empty sections', () => {
    const report = makeReport();

    assert.deepEqual(formatConfiguredMappingsSection(report), [
        'Configured Mappings:',
        'None',
    ]);
    assert.deepEqual(formatInvalidMappingsSection(report), [
        'Invalid Configured Mappings:',
        'None',
    ]);
    assert.deepEqual(formatSafeSuggestionsSection(report), [
        'Safe Suggestions:',
        'None',
    ]);
    assert.deepEqual(formatUnresolvedMoneyMoneySection(report), [
        'Unresolved MoneyMoney Categories:',
        'None',
    ]);
    assert.deepEqual(formatUnusedActualSection(report), [
        'Unused Actual Categories:',
        'None',
    ]);
    assert.deepEqual(formatPlanningWarningsSection(report), [
        'Planning Warnings:',
        'None',
    ]);
});

test('formatters include expected headers and rows', () => {
    const report = makeReport({
        configuredMappings: [
            {
                sourceRef: 'mm-1',
                targetRef: 'actual-1',
                sourcePath: 'A > B',
                targetPath: 'C > D',
            },
        ],
        invalidMappings: [
            {
                sourceRef: 'mm-x',
                targetRef: 'actual-x',
                reason: 'not found',
            },
        ],
        safeSuggestions: [
            {
                sourcePath: 'X > Y',
                targetPath: 'M > N',
                reason: 'exact-normalized',
            },
        ],
        unresolvedMoneyMoneyCategories: [
            {
                uuid: 'uuid-1',
                path: 'P > Q',
            },
        ],
        unusedActualCategories: [
            {
                id: 'actual-unused',
                path: 'G > H',
            },
        ],
        planningWarnings: ['Planning is incomplete (this can be intentional).'],
    });

    assert.equal(
        formatConfiguredMappingsSection(report)[1],
        'MoneyMoney Path | Actual Path | Source Ref | Target Ref'
    );
    assert.equal(
        formatInvalidMappingsSection(report)[1],
        'Source Ref | Target Ref | Reason'
    );
    assert.equal(
        formatSafeSuggestionsSection(report)[1],
        'MoneyMoney Path | Actual Path | Reason'
    );
    assert.equal(formatUnresolvedMoneyMoneySection(report)[1], 'UUID | Path');
    assert.equal(formatUnusedActualSection(report)[1], 'ID | Path');
});

test('table report includes sections in expected order', () => {
    const report = makeReport();
    const lines = formatTableReport('server', 'budget', report);

    const configuredIdx = lines.indexOf('Configured Mappings:');
    const invalidIdx = lines.indexOf('Invalid Configured Mappings:');
    const suggestionsIdx = lines.indexOf('Safe Suggestions:');
    const unresolvedIdx = lines.indexOf('Unresolved MoneyMoney Categories:');
    const unusedIdx = lines.indexOf('Unused Actual Categories:');
    const warningsIdx = lines.indexOf('Planning Warnings:');

    assert.ok(configuredIdx > 0);
    assert.ok(invalidIdx > configuredIdx);
    assert.ok(suggestionsIdx > invalidIdx);
    assert.ok(unresolvedIdx > suggestionsIdx);
    assert.ok(unusedIdx > unresolvedIdx);
    assert.ok(warningsIdx > unusedIdx);
});

test('toml formatter includes preamble counts and incompleteness note when needed', () => {
    const report = makeReport({
        unresolvedMoneyMoneyCategories: [{ uuid: 'u', path: 'P' }],
        unusedActualCategories: [{ id: 'a', path: 'Q' }],
        planningWarnings: ['Planning is incomplete (this can be intentional).'],
    });

    const lines = formatTomlReport('server', 'budget', report, {
        'mm-1': 'actual-1',
    });

    assert.deepEqual(lines.slice(0, 4), [
        '# server / budget',
        '# Unresolved MoneyMoney categories: 1',
        '# Unused Actual categories: 1',
        '# Planning is incomplete (this can be intentional).',
    ]);
});
