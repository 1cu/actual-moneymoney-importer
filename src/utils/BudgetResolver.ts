import fs from 'fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type Logger from './Logger.js';
import { DEFAULT_DATA_DIR } from './shared.js';

export interface BudgetResolverOptions {
    rootDir?: string;
    logResolution?: boolean;
    maxDirsToScan?: number;
}

export type BudgetMetadata = {
    id: string;
    groupId?: string;
    [key: string]: unknown;
};

export interface BudgetResolverResult {
    directory: string;
    metadata: BudgetMetadata;
    metadataPath: string;
}

const DEFAULT_MAX_DIRS_TO_SCAN = 100;

export class BudgetResolver {
    public constructor(private readonly logger: Logger) {}

    public logResolvedBudgetDirectory(result: BudgetResolverResult, syncId: string): void {
        const directoryName = path.basename(result.directory);
        const hints = [`Metadata path: ${result.metadataPath}`, `Local budget ID: ${result.metadata.id}`];

        this.logger.debug(`Using budget directory: ${directoryName} for syncId ${syncId}`, hints);
    }

    public async resolveBudgetDataDir(
        syncId: string,
        options: BudgetResolverOptions = {}
    ): Promise<BudgetResolverResult> {
        const { rootDir = DEFAULT_DATA_DIR, logResolution = true, maxDirsToScan = DEFAULT_MAX_DIRS_TO_SCAN } = options;

        let entries: Dirent[];
        try {
            entries = await fs.readdir(rootDir, { withFileTypes: true });
        } catch (error) {
            const maybeErrno = error as NodeJS.ErrnoException | undefined;
            if (maybeErrno?.code === 'ENOENT') {
                entries = [];
            } else {
                throw error;
            }
        }

        const inspectedDirs: string[] = [];
        const metadataDiagnostics: string[] = [];

        const sortedEntries = entries
            .filter((entry) => entry.isDirectory())
            .sort((left, right) => left.name.localeCompare(right.name));

        if (sortedEntries.length > maxDirsToScan) {
            this.logger.warn(
                `Found ${sortedEntries.length} directories, scanning first ${maxDirsToScan} (omitting ${
                    sortedEntries.length - maxDirsToScan
                })`
            );
        }

        for (const entry of sortedEntries.slice(0, maxDirsToScan)) {
            inspectedDirs.push(entry.name);
            const metadataPath = path.join(rootDir, entry.name, 'metadata.json');

            try {
                const metadataRaw = await fs.readFile(metadataPath, 'utf8');
                const parsed = JSON.parse(metadataRaw);

                if (!parsed || typeof parsed !== 'object') {
                    metadataDiagnostics.push(`${entry.name}: metadata is not an object`);
                    continue;
                }

                const record = parsed as Record<string, unknown>;
                const groupIdRaw = record.groupId;
                const groupId = typeof groupIdRaw === 'string' ? groupIdRaw.trim() : '';
                if (!groupId) {
                    metadataDiagnostics.push(`${entry.name}: metadata missing groupId`);
                    continue;
                }

                if (groupId !== syncId) {
                    metadataDiagnostics.push(
                        `${entry.name}: metadata groupId '${groupId}' does not match requested syncId '${syncId}'`
                    );
                    continue;
                }

                const idRaw = record.id;
                const id = typeof idRaw === 'string' ? idRaw.trim() : entry.name;

                if (!id) {
                    metadataDiagnostics.push(`${entry.name}: metadata missing id`);
                    continue;
                }

                const directory = path.join(rootDir, entry.name);
                const metadata: BudgetMetadata = {
                    ...(record as BudgetMetadata),
                    id,
                    groupId,
                };
                const result: BudgetResolverResult = {
                    directory,
                    metadata,
                    metadataPath,
                };

                if (logResolution) {
                    this.logResolvedBudgetDirectory(result, syncId);
                }

                return result;
            } catch (error) {
                const maybeErrno = error as NodeJS.ErrnoException | undefined;
                if (maybeErrno?.code === 'ENOENT' || maybeErrno?.code === 'EISDIR') {
                    metadataDiagnostics.push(`${entry.name}: metadata.json not found`);
                    continue;
                }

                if (error instanceof SyntaxError) {
                    metadataDiagnostics.push(`${entry.name}: metadata.json could not be parsed`);
                    continue;
                }

                throw error;
            }
        }

        const inspectedSummary = inspectedDirs.length > 0 ? inspectedDirs.join(', ') : '(none)';
        const metadataSummary =
            metadataDiagnostics.length > 0 ? ` Metadata issues: ${metadataDiagnostics.join('; ')}.` : '';

        throw new Error(
            `No Actual budget directory found for syncId '${syncId}'. ` +
                `Checked directories under '${rootDir}': ${inspectedSummary}.` +
                metadataSummary +
                ' Open the budget in Actual Desktop and sync it before retrying.'
        );
    }
}

export default BudgetResolver;
