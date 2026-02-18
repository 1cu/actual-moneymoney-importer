import fs from 'fs/promises';
import toml from 'toml';
import { checkDatabaseUnlocked } from 'moneymoney';
import { ArgumentsCamelCase, CommandModule } from 'yargs';
import ActualApi from '../utils/ActualApi.js';
import { includesRef, toRefList } from '../utils/cliArgs.js';
import CategoryMap from '../utils/CategoryMap.js';
import Logger, { LogLevel } from '../utils/Logger.js';
import {
    getBudgetBlocks,
    renderCategoryMappingLines,
    replaceCategoryMappingInConfig,
} from '../utils/categoryMappingConfigPatch.js';
import {
    ActualBudgetConfig,
    ActualServerConfig,
    getConfig,
    getConfigFile,
} from '../utils/config.js';

type MappingTarget = {
    server: ActualServerConfig;
    budget: ActualBudgetConfig;
};

type MapFormat = 'table' | 'json' | 'toml';

const printFallbackSnippet = (
    logger: Logger,
    canonicalMapping: Record<string, string>
) => {
    logger.info(
        'TOML snippet to paste manually:',
        renderCategoryMappingLines(canonicalMapping)
    );
};

const handleMapCommand = async (argv: ArgumentsCamelCase) => {
    const config = await getConfig(argv);
    const configPath = getConfigFile(argv);

    const logLevel = (argv.logLevel ??
        argv.loglevel ??
        LogLevel.INFO) as number;
    const logger = new Logger(logLevel);

    const serverRefs = toRefList(argv.server as string | string[] | undefined);
    const budgetRefs = toRefList(argv.budget as string | string[] | undefined);
    const outputFormat = ((argv.format as string | undefined) ??
        'table') as MapFormat;
    const writeConfig = (argv.writeConfig as boolean | undefined) ?? false;

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

    const reports: Array<{
        serverUrl: string;
        syncId: string;
        report: ReturnType<CategoryMap['getReport']>;
        canonicalMapping: Record<string, string>;
    }> = [];

    const targetsByServer = new Map<ActualServerConfig, ActualBudgetConfig[]>();
    for (const target of matchingTargets) {
        const budgets = targetsByServer.get(target.server) ?? [];
        budgets.push(target.budget);
        targetsByServer.set(target.server, budgets);
    }

    for (const [serverConfig, budgets] of targetsByServer.entries()) {
        const actualApi = new ActualApi(serverConfig, logger);
        await actualApi.init();

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
                    report: categoryMap.getReport(),
                    canonicalMapping: categoryMap.getCanonicalMapping({
                        includeSuggestions: true,
                    }),
                });
            }
        } finally {
            await actualApi.shutdown();
        }
    }

    printReports(reports, outputFormat);

    if (!writeConfig) {
        process.exit(0);
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
        logger.error(
            `Could not safely write category mapping to config: no budget blocks found.`
        );
        printFallbackSnippet(logger, report.canonicalMapping);
        process.exit(0);
    }

    const writeResult = replaceCategoryMappingInConfig(
        configText,
        report.syncId,
        report.canonicalMapping
    );

    if (!writeResult.ok) {
        logger.error(
            `Could not safely write category mapping to config: ${writeResult.reason}`
        );
        printFallbackSnippet(logger, report.canonicalMapping);
        process.exit(0);
    }

    const parsedAfterWrite = toml.parse(writeResult.content);
    const parsedBudgets = (
        parsedAfterWrite.actualServers as Array<{
            budgets: Array<{
                syncId: string;
                categoryMapping?: Record<string, string>;
            }>;
        }>
    ).flatMap((server) => server.budgets);

    const selectedBudget = parsedBudgets.find(
        (budget) => budget.syncId === report.syncId
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

    await fs.writeFile(configPath, writeResult.content, 'utf8');
    logger.info(`Updated category mapping in ${configPath}`);
    process.exit(0);
};

const selectTargets = (
    servers: ActualServerConfig[],
    serverRefs: string[] | undefined,
    budgetRefs: string[] | undefined
): MappingTarget[] => {
    const targets: MappingTarget[] = [];

    for (const server of servers) {
        if (!includesRef(serverRefs, server.serverUrl)) {
            continue;
        }

        for (const budget of server.budgets) {
            if (!includesRef(budgetRefs, budget.syncId)) {
                continue;
            }

            targets.push({ server, budget });
        }
    }

    return targets;
};

const printReports = (
    reports: Array<{
        serverUrl: string;
        syncId: string;
        report: ReturnType<CategoryMap['getReport']>;
        canonicalMapping: Record<string, string>;
    }>,
    format: MapFormat
) => {
    if (format === 'json') {
        console.log(JSON.stringify(reports, null, 4));
        return;
    }

    if (format === 'toml') {
        for (const report of reports) {
            console.log(`# ${report.serverUrl} / ${report.syncId}`);
            for (const line of renderCategoryMappingLines(
                report.canonicalMapping
            )) {
                console.log(line);
            }
            console.log('');
        }
        return;
    }

    for (const item of reports) {
        const report = item.report;
        console.log(`Server: ${item.serverUrl}`);
        console.log(`Budget: ${item.syncId}`);
        console.log(`Valid mappings: ${report.validMappings.length}`);
        console.log(`Invalid mappings: ${report.invalidMappings.length}`);
        console.log(`Unmapped categories: ${report.unmappedCategories.length}`);
        console.log(`Safe suggestions: ${report.suggestions.length}`);

        if (report.invalidMappings.length > 0) {
            console.log('Invalid mappings:');
            for (const invalid of report.invalidMappings) {
                console.log(
                    `- ${invalid.sourceRef} -> ${invalid.targetRef}: ${invalid.reason ?? 'Invalid mapping'}`
                );
            }
        }

        if (report.suggestions.length > 0) {
            console.log('Suggestions:');
            for (const suggestion of report.suggestions) {
                console.log(
                    `- ${suggestion.sourcePath} -> ${suggestion.targetPath} (${suggestion.reason})`
                );
            }
        }

        console.log('');
    }
};

const mapSubcommand: CommandModule = {
    command: 'map',
    describe: 'Validate and suggest MoneyMoney -> Actual category mappings',
    builder: (yargs) => {
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
                'Write canonical mapping plus safe suggestions to config TOML'
            );
    },
    handler: (argv) => handleMapCommand(argv),
};

export default {
    command: 'categories',
    describe: 'Category mapping tools',
    builder: (yargs) => {
        return yargs.command(mapSubcommand).strictCommands();
    },
    handler: () => {
        console.log('Use `actual-monmon categories map --help` for options.');
        process.exit(0);
    },
} as CommandModule;
