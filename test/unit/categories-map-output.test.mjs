import assert from 'node:assert/strict';
import test from 'node:test';
import {
    formatConfiguredMappingsSection,
    formatIgnoredMoneyMoneySection,
    formatInvalidMappingsSection,
    formatNextActionsSection,
    formatPlanningWarningsSection,
    formatSafeSuggestionsSection,
    formatStatusBar,
    formatTableReport,
    formatTomlReport,
    formatUnresolvedMoneyMoneySection,
    formatUnusedActualSection,
    handleUnsafeWriteConfigFailure,
} from '../../dist/commands/categories.command.js';

const makeReport = ({
    configuredMappings = [],
    invalidMappings = [],
    safeSuggestions = [],
    unresolvedMoneyMoneyCategories = [],
    unusedActualCategories = [],
    planningWarnings = [],
    ignoredMoneyMoneyCategories = [],
} = {}) => ({
    configuredMappings,
    invalidMappings,
    safeSuggestions,
    unresolvedMoneyMoneyCategories,
    unusedActualCategories,
    planningWarnings,
    ignoredMoneyMoneyCategories,
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
    assert.deepEqual(formatIgnoredMoneyMoneySection(report, 120), [
        'Intentionally Ignored:',
        '',
        'None',
    ]);
    const nextActions = formatNextActionsSection(report, 120).join('\n');
    assert.match(nextActions, /Next Actions:/);
    assert.match(
        nextActions,
        /Mapping is complete; ready for import with `actual-mmi import`\./
    );
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
        ignoredMoneyMoneyCategories: [
            {
                uuid: 'mm-ignored-1',
                path: 'Transfers > Internal',
                ref: 'path:Transfers > Internal',
            },
        ],
        planningWarnings: ['Planning is incomplete (this can be intentional).'],
    });

    const configuredLines = formatConfiguredMappingsSection(report, 120);
    const invalidLines = formatInvalidMappingsSection(report, 120);
    const suggestionsLines = formatSafeSuggestionsSection(report, 120);
    const unresolvedLines = formatUnresolvedMoneyMoneySection(report, 120);
    const unusedLines = formatUnusedActualSection(report, 120);
    const ignoredLines = formatIgnoredMoneyMoneySection(report, 120);

    assert.equal(
        configuredLines.some((line) => line.includes('╔')),
        true
    );
    assert.equal(
        configuredLines.some((line) => line.includes('MoneyMoney Path')),
        true
    );
    assert.equal(
        invalidLines.some((line) => line.includes('Reason')),
        true
    );
    assert.equal(
        suggestionsLines.some((line) => line.includes('Actual Path')),
        true
    );
    assert.equal(
        unresolvedLines.some((line) => line.includes('UUID')),
        true
    );
    assert.equal(
        unusedLines.some((line) => line.includes('ID')),
        true
    );
    assert.equal(
        ignoredLines.some((line) => line.includes('MoneyMoney Path')),
        true
    );
});

test('table report includes sections in expected order', () => {
    const report = makeReport();
    const lines = formatTableReport('server', 'budget', report, 120);

    const configuredIdx = lines.indexOf('Configured Mappings:');
    const invalidIdx = lines.indexOf('Invalid Configured Mappings:');
    const suggestionsIdx = lines.indexOf('Safe Suggestions:');
    const unresolvedIdx = lines.indexOf('Unresolved MoneyMoney Categories:');
    const ignoredIdx = lines.indexOf('Intentionally Ignored:');
    const unusedIdx = lines.indexOf('Unused Actual Categories:');
    const warningsIdx = lines.indexOf('Planning Warnings:');
    const actionsIdx = lines.indexOf('Next Actions:');

    assert.ok(configuredIdx > 0);
    assert.ok(invalidIdx > configuredIdx);
    assert.ok(suggestionsIdx > invalidIdx);
    assert.ok(unresolvedIdx > suggestionsIdx);
    assert.ok(ignoredIdx > unresolvedIdx);
    assert.ok(unusedIdx > ignoredIdx);
    assert.ok(warningsIdx > unusedIdx);
    assert.ok(actionsIdx > warningsIdx);
});

test('unsafe write failures return a non-zero exit code', () => {
    const calls = {
        error: [],
        info: [],
    };
    const logger = {
        error: (...args) => calls.error.push(args),
        info: (...args) => calls.info.push(args),
    };

    const exitCode = handleUnsafeWriteConfigFailure(
        logger,
        [],
        'no budget blocks found.'
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(calls.error, [
        [
            'Could not safely write category mapping to config: no budget blocks found.',
        ],
    ]);
    assert.equal(calls.info.length, 1);
    assert.deepEqual(calls.info[0][1], [
        '# Tool-managed block: running actual-mmi categories map --write-config rewrites this section.',
        '# Keys use "path:" refs by default. Fall back to "uuid:" or "id:" for ambiguous categories.',
        '[actualServers.budgets.categoryMapping]',
        '# No mappings generated.',
    ]);
});

test('next actions prioritizes invalid mappings over unresolved categories', () => {
    const report = makeReport({
        invalidMappings: [
            { sourceRef: 'a', targetRef: 'b', reason: 'invalid' },
        ],
        unresolvedMoneyMoneyCategories: [{ uuid: 'u', path: 'P > Q' }],
    });

    const lines = formatNextActionsSection(report, 120).join('\n');
    assert.match(lines, /Fix invalid category refs in config first/);
    assert.doesNotMatch(lines, /\d+ categor(y|ies) unresolved/);
});

test('next actions shows unresolved guidance when no invalid mappings exist', () => {
    const report = makeReport({
        unresolvedMoneyMoneyCategories: [{ uuid: 'u', path: 'P > Q' }],
    });

    const lines = formatNextActionsSection(report, 120).join('\n');
    assert.match(lines, /\d+ categor(y|ies) unresolved/);
    assert.doesNotMatch(lines, /Fix invalid category refs in config first/);
});

test('next actions shows complete guidance when no invalid or unresolved remain', () => {
    const report = makeReport();

    const lines = formatNextActionsSection(report, 120).join('\n');
    assert.match(
        lines,
        /Mapping is complete; ready for import with `actual-mmi import`\./
    );
    assert.doesNotMatch(lines, /Fix invalid category refs in config first/);
    assert.doesNotMatch(lines, /Review unresolved categories/);
});

test('next actions shows suggestion guidance when safe suggestions exist', () => {
    const report = makeReport({
        safeSuggestions: [
            { sourcePath: 'A', targetPath: 'B', reason: 'exact-normalized' },
        ],
    });

    const lines = formatNextActionsSection(report, 120).join('\n');
    assert.match(
        lines,
        /Run .+actual-mmi categories map --write-config.+accept 1 safe suggestion/
    );
    assert.doesNotMatch(lines, /Fix invalid category refs in config first/);
    assert.doesNotMatch(lines, /\d+ categor(y|ies) unresolved/);
});

test('toml formatter includes preamble counts and incompleteness note when needed', () => {
    const report = makeReport({
        unresolvedMoneyMoneyCategories: [{ uuid: 'u', path: 'P' }],
        unusedActualCategories: [{ id: 'a', path: 'Q' }],
        planningWarnings: ['Planning is incomplete (this can be intentional).'],
    });

    const lines = formatTomlReport('server', 'budget', report, [
        {
            sourceUuid: 'mm-1',
            targetId: 'actual-1',
            sourcePath: 'A > B',
            targetPath: 'C > D',
            origin: 'configured',
        },
    ]);

    assert.deepEqual(lines.slice(0, 4), [
        '# server / budget',
        '# Unresolved MoneyMoney categories: 1',
        '# Unused Actual categories: 1',
        '# Planning is incomplete (this can be intentional).',
    ]);
    assert.ok(lines.some((line) => line.includes('# MoneyMoney: A > B')));
    assert.ok(lines.some((line) => line.includes('# Actual: C > D')));
    assert.ok(
        lines.some((line) => line.includes('"path:A > B" = "path:C > D"'))
    );
});

test('toml formatter includes ignored count when configured', () => {
    const report = makeReport({
        ignoredMoneyMoneyCategories: [
            {
                uuid: 'mm-ig',
                path: 'Transfers > Transfer',
                ref: 'path:Transfers > Transfer',
            },
        ],
    });

    const lines = formatTomlReport('server', 'budget', report, [
        {
            sourceUuid: 'mm-1',
            targetId: 'actual-1',
            sourcePath: 'A > B',
            targetPath: 'C > D',
            origin: 'configured',
        },
    ]);

    assert.ok(
        lines.some((line) =>
            line.includes('# Intentionally ignored MoneyMoney categories: 1')
        )
    );
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

test('formatStatusBar includes ignored count', () => {
    const report = makeReport({
        configuredMappings: [
            {
                sourceRef: 'mm-1',
                targetRef: 'actual-1',
                sourcePath: 'A',
                targetPath: 'B',
            },
        ],
        ignoredMoneyMoneyCategories: [
            { uuid: 'mm-ig-1', path: 'X > Y', ref: 'path:X > Y' },
            { uuid: 'mm-ig-2', path: 'P > Q', ref: 'path:P > Q' },
        ],
    });

    const result = formatStatusBar(report);
    assert.equal(result.includes('🫷 2 ignored'), true);
});
