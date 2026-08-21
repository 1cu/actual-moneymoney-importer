import fs from 'node:fs/promises';
import { checkDatabaseUnlocked } from 'moneymoney';
import toml from 'toml';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import ActualApi from '../utils/ActualApi.js';
import { selectTargets } from '../utils/actualTargets.js';
import CategoryMap, {
    type CanonicalMappingEntry,
} from '../utils/CategoryMap.js';
import {
    getBudgetBlocks,
    renderAnnotatedCategoryMappingLines,
    replaceCategoryMappingInConfig,
} from '../utils/categoryMappingConfigPatch.js';
import { type CommonArgs, toRefList } from '../utils/cliArgs.js';
import {
    type ActualBudgetConfig,
    type ActualServerConfig,
    getConfig,
    getConfigFile,
    resolveCategorySyncPolicy,
} from '../utils/config.js';
import Logger, { LogLevel } from '../utils/Logger.js';
import { renderTextTable, type TableColumnConfig } from '../utils/textTable.js';

type MapFormat = 'table' | 'json' | 'toml';
type CategoryMapItem = {
    serverUrl: string;
    syncId: string;
    budgetName: string | undefined;
    report: ReturnType<CategoryMap['getReport']>;
    canonicalMappingEntries: CanonicalMappingEntry[];
    canonicalMapping: Record<string, string>;
};

const printFallbackSnippet = (
    logger: Logger,
    entries: CanonicalMappingEntry[]
) => {
    logger.info(
        'TOML snippet to paste manually:',
        renderAnnotatedCategoryMappingLines(entries)
    );
};

export const handleUnsafeWriteConfigFailure = (
    logger: Logger,
    entries: CanonicalMappingEntry[],
    reason: string
) => {
    logger.error(
        `Could not safely write category mapping to config: ${reason}`
    );
    printFallbackSnippet(logger, entries);
    return 1 as const;
};

type CategoriesMapArgs = CommonArgs & {
    server?: string | string[];
    budget?: string | string[];
    format?: string;
    'write-config'?: boolean;
};

const handleMapCommand = async (
    argv: ArgumentsCamelCase<CategoriesMapArgs>
) => {
    const config = await getConfig(argv);
    const configPath = getConfigFile(argv);

    const logLevel = argv.logLevel ?? argv.loglevel ?? LogLevel.INFO;
    const logger = new Logger(logLevel);

    const serverRefs = toRefList(argv.server);
    const budgetRefs = toRefList(argv.budget);
    const outputFormat = (argv.format ?? 'table') as MapFormat;
    const writeConfig = argv.writeConfig ?? false;

    const matchingTargets = selectTargets(
        config.actualServers,
        serverRefs,
        budgetRefs
    );

    if (matchingTargets.length === 0) {
        throw new Error('No matching server/budget targets found.');
    }

    const isUnlocked = await checkDatabaseUnlocked();
    if (!isUnlocked) {
        throw new Error(
            'MoneyMoney database is locked. Please unlock it and try again.'
        );
    }

    let shutdownFailed = false;

    const reports: CategoryMapItem[] = [];

    const targetsByServer = new Map<ActualServerConfig, ActualBudgetConfig[]>();
    for (const target of matchingTargets) {
        const budgets = targetsByServer.get(target.server) ?? [];
        budgets.push(target.budget);
        targetsByServer.set(target.server, budgets);
    }

    for (const [serverConfig, budgets] of targetsByServer.entries()) {
        const actualApi = new ActualApi(serverConfig, logger);
        await actualApi.init();

        const budgetNameBySyncId = new Map<string, string>();
        try {
            const userFiles = await actualApi.getUserFiles();
            for (const file of userFiles) {
                budgetNameBySyncId.set(file.fileId, file.name);
            }
        } catch (err) {
            // Non-fatal: budget names will fall back to syncId
            logger.debug(
                `Could not resolve budget names for server ${serverConfig.serverUrl}: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        try {
            for (const budgetConfig of budgets) {
                await actualApi.loadBudget(budgetConfig.syncId);

                const categoryMap = new CategoryMap(
                    budgetConfig,
                    actualApi,
                    logger
                );
                await categoryMap.load();

                reports.push({
                    serverUrl: serverConfig.serverUrl,
                    syncId: budgetConfig.syncId,
                    budgetName: budgetNameBySyncId.get(budgetConfig.syncId),
                    report: categoryMap.getReport(),
                    canonicalMappingEntries:
                        categoryMap.getCanonicalMappingEntries({
                            includeSuggestions: true,
                        }),
                    canonicalMapping: categoryMap.getCanonicalMapping({
                        includeSuggestions: true,
                    }),
                });
            }
        } finally {
            try {
                await actualApi.shutdown();
            } catch (shutdownError) {
                shutdownFailed = true;
                logger.warn(
                    `Failed to shutdown Actual API: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`
                );
            }
        }
    }

    const categorySyncPolicy = resolveCategorySyncPolicy(config.import);

    printReports(reports, outputFormat, categorySyncPolicy);

    if (!writeConfig) {
        process.exit(shutdownFailed ? 1 : 0);
    }

    if (matchingTargets.length !== 1 || reports.length !== 1) {
        throw new Error(
            '--write-config requires exactly one selected budget (use --server and --budget).'
        );
    }

    const report = reports[0];
    if (!report) {
        throw new Error('No report generated for selected budget.');
    }

    const configText = await fs.readFile(configPath, 'utf8');

    if (getBudgetBlocks(configText).length === 0) {
        process.exit(
            handleUnsafeWriteConfigFailure(
                logger,
                report.canonicalMappingEntries,
                'no budget blocks found.'
            )
        );
    }

    logger.warn(
        'The [actualServers.budgets.categoryMapping] block is tool-managed. Future --write-config runs overwrite manual edits in that block.'
    );

    const writeResult = replaceCategoryMappingInConfig(
        configText,
        report.syncId,
        report.canonicalMappingEntries
    );

    if (!writeResult.ok) {
        process.exit(
            handleUnsafeWriteConfigFailure(
                logger,
                report.canonicalMappingEntries,
                writeResult.reason
            )
        );
    }

    const parsedAfterWrite = toml.parse(writeResult.content);
    const parsedBudgets = (
        parsedAfterWrite.actualServers as Array<{
            budgets: Array<{
                syncId: string;
                categoryMapping?: Record<string, string>;
            }>;
        }>
    ).flatMap(server => server.budgets);

    const selectedBudget = parsedBudgets.find(
        budget => budget.syncId === report.syncId
    );

    if (!selectedBudget) {
        throw new Error('Post-write validation failed: budget not found.');
    }

    const writtenMappingCount = Object.keys(
        selectedBudget.categoryMapping ?? {}
    ).length;
    const intendedMappingCount = Object.keys(report.canonicalMapping).length;

    if (writtenMappingCount !== intendedMappingCount) {
        throw new Error(
            `Post-write validation failed: expected ${intendedMappingCount} mapping entries but found ${writtenMappingCount}.`
        );
    }

    const tempPath = `${configPath}.tmp`;
    const stat = await fs.stat(configPath);
    await fs.writeFile(tempPath, writeResult.content, 'utf8');
    await fs.chmod(tempPath, stat.mode);
    await fs.rename(tempPath, configPath);
    logger.info(
        `Updated category mapping in ${configPath} (${report.canonicalMappingEntries.length} entries, annotated for readability).`
    );
    process.exit(shutdownFailed ? 1 : 0);
};

const printReports = (
    reports: CategoryMapItem[],
    format: MapFormat,
    categorySyncPolicy: 'off' | 'new' | 'all'
) => {
    if (format === 'json') {
        console.log(JSON.stringify(reports, null, 4));
        return;
    }

    if (format === 'toml') {
        for (const report of reports) {
            for (const line of formatTomlReport(
                report.serverUrl,
                report.syncId,
                report.report,
                report.canonicalMappingEntries
            )) {
                console.log(line);
            }
            console.log('');
        }
        return;
    }

    const maxWidth = (process.stdout.columns ?? 142) - 2;

    for (const item of reports) {
        const report = item.report;

        // --- Status bar ---
        console.log(formatStatusBar(report));
        console.log();

        // --- Warning banner ---
        if (categorySyncPolicy === 'off') {
            console.log(formatSyncOffBanner(maxWidth));
            console.log();
        }

        // --- Sections (only non-empty) ---
        const sections = buildTableSections(
            item.serverUrl,
            item.syncId,
            item.budgetName,
            report,
            maxWidth,
            categorySyncPolicy
        );

        for (const section of sections) {
            console.log(section.header);
            for (const line of section.lines) {
                console.log(line);
            }
            if (section.lines.length > 0) {
                console.log();
            }
        }
    }
};

const formatSectionWithRows = ({
    title,
    headers,
    rows,
    columns,
    maxWidth,
}: {
    title: string;
    headers: string[];
    rows: string[][];
    columns: TableColumnConfig[];
    maxWidth: number;
}) => {
    const lines = [title, ''];
    if (rows.length === 0) {
        lines.push('None');
        return lines;
    }

    lines.push(
        ...renderTextTable([headers, ...rows], {
            columns,
            maxWidth,
        })
    );
    return lines;
};

export const formatConfiguredMappingsSection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.configuredMappings.map(mapping => {
        return [
            mapping.sourcePath ?? mapping.sourceRef,
            mapping.targetPath ?? mapping.targetRef,
            mapping.sourceRef,
            mapping.targetRef,
        ];
    });

    return formatSectionWithRows({
        title: 'Configured Mappings:',
        headers: ['MoneyMoney Path', 'Actual Path', 'Source Ref', 'Target Ref'],
        rows,
        columns: [
            { width: 28, alignment: 'left', truncatePriority: 1 },
            { width: 28, alignment: 'left', truncatePriority: 2 },
            { width: 24, alignment: 'left', truncatePriority: 3 },
            { width: 24, alignment: 'left', truncatePriority: 4 },
        ],
        maxWidth,
    });
};

export const formatInvalidMappingsSection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.invalidMappings.map(mapping => {
        return [
            mapping.sourceRef,
            mapping.targetRef,
            mapping.reason ?? 'Invalid mapping',
        ];
    });

    return formatSectionWithRows({
        title: 'Invalid Configured Mappings:',
        headers: ['Source Ref', 'Target Ref', 'Reason'],
        rows,
        columns: [
            { width: 24, alignment: 'left', truncatePriority: 3 },
            { width: 24, alignment: 'left', truncatePriority: 4 },
            { width: 40, alignment: 'left', truncatePriority: 2 },
        ],
        maxWidth,
    });
};

export const formatSafeSuggestionsSection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.safeSuggestions.map(suggestion => {
        return [
            suggestion.sourcePath,
            suggestion.targetPath,
            suggestion.reason,
        ];
    });

    return formatSectionWithRows({
        title: 'Safe Suggestions:',
        headers: ['MoneyMoney Path', 'Actual Path', 'Reason'],
        rows,
        columns: [
            { width: 32, alignment: 'left', truncatePriority: 1 },
            { width: 32, alignment: 'left', truncatePriority: 2 },
            { width: 18, alignment: 'left', truncatePriority: 4 },
        ],
        maxWidth,
    });
};

export const formatUnresolvedMoneyMoneySection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.unresolvedMoneyMoneyCategories.map(category => {
        return [category.uuid, category.path];
    });

    return formatSectionWithRows({
        title: 'Unresolved MoneyMoney Categories:',
        headers: ['UUID', 'Path'],
        rows,
        columns: [
            { width: 36, alignment: 'left', truncatePriority: 4 },
            { width: 48, alignment: 'left', truncatePriority: 1 },
        ],
        maxWidth,
    });
};

export const formatIgnoredMoneyMoneySection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.ignoredMoneyMoneyCategories.map(category => {
        return [category.path, category.ref];
    });

    return formatSectionWithRows({
        title: 'Intentionally Ignored:',
        headers: ['MoneyMoney Path', 'Config Ref'],
        rows,
        columns: [
            { width: 42, alignment: 'left', truncatePriority: 1 },
            { width: 42, alignment: 'left', truncatePriority: 2 },
        ],
        maxWidth,
    });
};

export const formatUnusedActualSection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.unusedActualCategories.map(category => {
        return [category.id, category.path];
    });

    return formatSectionWithRows({
        title: 'Unused Actual Categories:',
        headers: ['ID', 'Path'],
        rows,
        columns: [
            { width: 36, alignment: 'left', truncatePriority: 4 },
            { width: 48, alignment: 'left', truncatePriority: 1 },
        ],
        maxWidth,
    });
};

export const formatPlanningWarningsSection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    const rows = report.planningWarnings.map(warning => [warning]);

    return formatSectionWithRows({
        title: 'Planning Warnings:',
        headers: ['Message'],
        rows,
        columns: [{ width: 80, alignment: 'left', truncatePriority: 1 }],
        maxWidth,
    });
};

export const formatNextActionsSection = (
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number,
    syncOff: boolean
) => {
    let action: string;

    if (report.invalidMappings.length > 0) {
        action =
            'Fix invalid category refs in config first, then rerun `actual-mmi categories map`.';
    } else if (report.safeSuggestions.length > 0) {
        if (syncOff) {
            action = `${report.safeSuggestions.length} safe suggestion${report.safeSuggestions.length !== 1 ? 's' : ''} available. Enable categorySync to apply them, then run \`--write-config\`.`;
        } else {
            action = `Run \`actual-mmi categories map --write-config\` to accept ${report.safeSuggestions.length} safe suggestion${report.safeSuggestions.length !== 1 ? 's' : ''} and write them to the config file.`;
        }
    } else if (report.unresolvedMoneyMoneyCategories.length > 0) {
        action = `${report.unresolvedMoneyMoneyCategories.length} categor${report.unresolvedMoneyMoneyCategories.length !== 1 ? 'ies' : 'y'} unresolved (this may be intentional). Add mappings or mark as ignored with \`ignoredMoneyMoneyCategoryRefs\` in the config.`;
    } else if (syncOff) {
        action =
            'Mapping is complete but categorySync is off; mappings will not be applied during import.';
    } else {
        action =
            'Mapping is complete; ready for import with `actual-mmi import`.';
    }

    return formatSectionWithRows({
        title: 'Next Actions:',
        headers: ['Action'],
        rows: [[action]],
        columns: [{ width: 92, alignment: 'left', truncatePriority: 1 }],
        maxWidth,
    });
};

export const formatStatusBar = (
    report: ReturnType<CategoryMap['getReport']>
) => {
    const mapped = report.configuredMappings.length;
    const suggestions = report.safeSuggestions.length;
    const invalid = report.invalidMappings.length;
    const unresolved = report.unresolvedMoneyMoneyCategories.length;
    const ignored = report.ignoredMoneyMoneyCategories.length;

    const parts: string[] = [];
    if (mapped > 0) parts.push(`  ✅ ${mapped} mapped`);
    if (suggestions > 0) parts.push(`💡 ${suggestions} suggestions`);
    if (invalid > 0) parts.push(`❌ ${invalid} invalid`);
    if (unresolved > 0) parts.push(`⚠️  ${unresolved} unresolved`);
    if (ignored > 0) parts.push(`🫷 ${ignored} ignored`);
    if (parts.length === 0) parts.push('  No categories configured');

    return parts.join('  |  ');
};

export const formatSyncOffBanner = (maxWidth: number) => {
    const width = Math.max(maxWidth, 40);
    const top = `╔${'═'.repeat(width)}╗`;
    const bottom = `╚${'═'.repeat(width)}╝`;
    const empty = `║${' '.repeat(width)}║`;
    const lines = [
        `║  ⚠️  CATEGORY SYNC IS DISABLED${' '.repeat(Math.max(0, width - 32))}║`,
        empty,
        `║  categorySync is "off" — these mappings will not be applied during import.${' '.repeat(Math.max(0, width - 73))}║`,
        `║  Set categorySync = "new" or "all" in [import] to enable category sync.${' '.repeat(Math.max(0, width - 74))}║`,
    ];
    return [top, ...lines, bottom].join('\n');
};

type TableSection = {
    header: string;
    lines: string[];
};

export const buildTableSections = (
    serverUrl: string,
    syncId: string,
    budgetName: string | undefined,
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number,
    categorySyncPolicy: 'off' | 'new' | 'all'
): TableSection[] => {
    const sections: TableSection[] = [];
    const syncOff = categorySyncPolicy === 'off';

    // Header
    const budgetLabel = budgetName ? `${budgetName} (${syncId})` : syncId;
    sections.push({
        header: `Server: ${serverUrl}`,
        lines: ['', `Budget: ${budgetLabel}`],
    });

    // Configured mappings (only if any)
    if (report.configuredMappings.length > 0) {
        const formatted = formatConfiguredMappingsSection(report, maxWidth);
        const title = `Configured Mappings (${report.configuredMappings.length}):`;
        sections.push({ header: title, lines: formatted.slice(1) });
    }

    // Invalid mappings (only if any)
    if (report.invalidMappings.length > 0) {
        const formatted = formatInvalidMappingsSection(report, maxWidth);
        const title = `Invalid Mappings (${report.invalidMappings.length}):`;
        sections.push({ header: title, lines: formatted.slice(1) });
    }

    // Safe suggestions (only if any)
    if (report.safeSuggestions.length > 0) {
        const formatted = formatSafeSuggestionsSection(report, maxWidth);
        const title = `Safe Suggestions (${report.safeSuggestions.length}):`;
        const hint = '  Run --write-config to accept these.';
        sections.push({
            header: title,
            lines: [...formatted.slice(1), '', hint],
        });
    }

    // Unresolved MoneyMoney categories (only if any)
    if (report.unresolvedMoneyMoneyCategories.length > 0) {
        const formatted = formatUnresolvedMoneyMoneySection(report, maxWidth);
        const title = `Unresolved MoneyMoney Categories (${report.unresolvedMoneyMoneyCategories.length}):`;
        sections.push({ header: title, lines: formatted.slice(1) });
    }

    // Intentionally ignored MoneyMoney categories (only if any)
    if (report.ignoredMoneyMoneyCategories.length > 0) {
        const formatted = formatIgnoredMoneyMoneySection(report, maxWidth);
        const title = `Intentionally Ignored (${report.ignoredMoneyMoneyCategories.length}):`;
        sections.push({ header: title, lines: formatted.slice(1) });
    }

    // Unused Actual categories (only if any)
    if (report.unusedActualCategories.length > 0) {
        const formatted = formatUnusedActualSection(report, maxWidth);
        const title = `Unused Actual Categories (${report.unusedActualCategories.length}):`;
        sections.push({ header: title, lines: formatted.slice(1) });
    }

    // Planning warnings (only if any)
    if (report.planningWarnings.length > 0) {
        const formatted = formatPlanningWarningsSection(report, maxWidth);
        sections.push({
            header: formatted[0] ?? 'Planning Warnings:',
            lines: formatted.slice(1),
        });
    }

    // Next actions (always)
    const nextFormatted = formatNextActionsSection(report, maxWidth, syncOff);
    sections.push({
        header: nextFormatted[0] ?? 'Next Actions:',
        lines: nextFormatted.slice(1),
    });

    return sections;
};

/**
 * Legacy flat format: always renders all sections regardless of content.
 *
 * The actual CLI output uses {@link buildTableSections} instead, which
 * only shows sections that have entries. This function is kept for
 * backwards-compatible test coverage of the individual section formatters.
 */
export const formatTableReport = (
    serverUrl: string,
    syncId: string,
    report: ReturnType<CategoryMap['getReport']>,
    maxWidth: number
) => {
    return [
        `Server: ${serverUrl}`,
        `Budget: ${syncId}`,
        '',
        ...formatConfiguredMappingsSection(report, maxWidth),
        '',
        ...formatInvalidMappingsSection(report, maxWidth),
        '',
        ...formatSafeSuggestionsSection(report, maxWidth),
        '',
        ...formatUnresolvedMoneyMoneySection(report, maxWidth),
        '',
        ...formatIgnoredMoneyMoneySection(report, maxWidth),
        '',
        ...formatUnusedActualSection(report, maxWidth),
        '',
        ...formatPlanningWarningsSection(report, maxWidth),
        '',
        ...formatNextActionsSection(report, maxWidth, false),
    ];
};

export const formatTomlReport = (
    serverUrl: string,
    syncId: string,
    report: ReturnType<CategoryMap['getReport']>,
    canonicalMappingEntries: CanonicalMappingEntry[]
) => {
    const lines = [
        `# ${serverUrl} / ${syncId}`,
        `# Unresolved MoneyMoney categories: ${report.unresolvedMoneyMoneyCategories.length}`,
        `# Unused Actual categories: ${report.unusedActualCategories.length}`,
    ];

    if (report.ignoredMoneyMoneyCategories.length > 0) {
        lines.push(
            `# Intentionally ignored MoneyMoney categories: ${report.ignoredMoneyMoneyCategories.length}`
        );
    }

    if (report.planningWarnings.length > 0) {
        lines.push('# Planning is incomplete (this can be intentional).');
    }

    lines.push(...renderAnnotatedCategoryMappingLines(canonicalMappingEntries));
    return lines;
};

const mapSubcommand: CommandModule = {
    command: 'map',
    describe: 'Validate and suggest MoneyMoney -> Actual category mappings',
    builder: yargs => {
        return yargs
            .string('server')
            .alias('server', 's')
            .describe('server', 'Filter by Actual server URL')
            .string('budget')
            .alias('budget', 'b')
            .describe('budget', 'Filter by Actual budget syncId')
            .string('format')
            .choices('format', ['table', 'json', 'toml'])
            .default('format', 'table')
            .describe('format', 'Output format for stdout report')
            .boolean('write-config')
            .describe(
                'write-config',
                'Write annotated category mapping (configured + safe suggestions) to config TOML'
            );
    },
    handler: argv => handleMapCommand(argv),
};

export default {
    command: 'categories',
    describe: 'Category mapping tools',
    builder: yargs => {
        return yargs.command(mapSubcommand).strictCommands();
    },
    handler: () => {
        console.log('Use `actual-mmi categories map --help` for options.');
        process.exit(0);
    },
} as CommandModule;
