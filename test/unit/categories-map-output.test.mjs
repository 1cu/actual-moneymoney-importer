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

    assert.deepEqual(formatConfiguredMappingsSection(report, 120), [
        'Configured Mappings:',
        '',
        'None',
    ]);
    assert.deepEqual(formatInvalidMappingsSection(report, 120), [
        'Invalid Configured Mappings:',
        '',
        'None',
    ]);
    assert.deepEqual(formatSafeSuggestionsSection(report, 120), [
        'Safe Suggestions:',
        '',
        'None',
    ]);
    assert.deepEqual(formatUnresolvedMoneyMoneySection(report, 120), [
        'Unresolved MoneyMoney Categories:',
        '',
        'None',
    ]);
    assert.deepEqual(formatUnusedActualSection(report, 120), [
        'Unused Actual Categories:',
        '',
        'None',
    ]);
    assert.deepEqual(formatPlanningWarningsSection(report, 120), [
        'Planning Warnings:',
        '',
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

    const configuredLines = formatConfiguredMappingsSection(report, 120);
    const invalidLines = formatInvalidMappingsSection(report, 120);
    const suggestionsLines = formatSafeSuggestionsSection(report, 120);
    const unresolvedLines = formatUnresolvedMoneyMoneySection(report, 120);
    const unusedLines = formatUnusedActualSection(report, 120);

    assert.equal(configuredLines.some((line) => line.includes('╔')), true);
    assert.equal(
        configuredLines.some((line) => line.includes('MoneyMoney Path')),
        true
    );
    assert.equal(invalidLines.some((line) => line.includes('Reason')), true);
    assert.equal(suggestionsLines.some((line) => line.includes('Actual Path')), true);
    assert.equal(unresolvedLines.some((line) => line.includes('UUID')), true);
    assert.equal(unusedLines.some((line) => line.includes('ID')), true);
});

test('table report includes sections in expected order', () => {
    const report = makeReport();
    const lines = formatTableReport('server', 'budget', report, 120);

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

test('table output truncates only when max width is narrow', () => {
    const longPath = '😀😀😀😀😀😀😀😀😀😀 Very long category path '.repeat(3);
    const report = makeReport({
        safeSuggestions: [
            {
                sourcePath: longPath,
                targetPath: longPath,
                reason: 'exact-normalized',
            },
        ],
    });

    const narrow = formatSafeSuggestionsSection(report, 80).join('\n');
    const wide = formatSafeSuggestionsSection(report, 500).join('\n');

    assert.equal(narrow.includes('…'), true);
    assert.equal(wide.includes('…'), false);
});
