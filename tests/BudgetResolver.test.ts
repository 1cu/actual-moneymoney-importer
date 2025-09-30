import path from 'node:path';
import type { Dirent } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BudgetResolver from '../src/utils/BudgetResolver.js';
import type { BudgetResolverResult } from '../src/utils/BudgetResolver.js';
import type Logger from '../src/utils/Logger.js';
import { LogLevel } from '../src/utils/Logger.js';
import { DEFAULT_DATA_DIR } from '../src/utils/shared.js';

const { readdirMock, readFileMock } = vi.hoisted(() => ({
    readdirMock: vi.fn<[], Promise<Dirent[]>>(),
    readFileMock: vi.fn<(filePath: string) => Promise<string>>(),
}));

vi.mock('fs/promises', () => ({
    default: {
        readdir: readdirMock,
        readFile: readFileMock,
    },
}));

const createLogger = () =>
    ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLevel: () => LogLevel.INFO,
    }) as unknown as Logger;

const createDirent = (name: string): Dirent =>
    ({
        name,
        isDirectory: () => true,
        isFile: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSymbolicLink: () => false,
        isSocket: () => false,
    }) as unknown as Dirent;

describe('BudgetResolver', () => {
    beforeEach(() => {
        readdirMock.mockReset();
        readFileMock.mockReset();
        readdirMock.mockResolvedValue([]);
        readFileMock.mockRejectedValue(new Error('unexpected file access'));
    });

    it('resolves a budget directory with matching metadata and logs diagnostics', async () => {
        const logger = createLogger();
        const resolver = new BudgetResolver(logger);

        readdirMock.mockResolvedValue([createDirent('alpha'), createDirent('target-directory')]);
        readFileMock.mockImplementation(async (filePath: string) => {
            if (filePath === path.join(DEFAULT_DATA_DIR, 'target-directory', 'metadata.json')) {
                return JSON.stringify({ id: 'custom-id', groupId: 'sync-id' });
            }

            return JSON.stringify({ id: 'alpha', groupId: 'different' });
        });

        const result = await resolver.resolveBudgetDataDir('sync-id');

        const expectedResult: BudgetResolverResult = {
            directory: path.join(DEFAULT_DATA_DIR, 'target-directory'),
            metadata: {
                id: 'custom-id',
                groupId: 'sync-id',
            },
            metadataPath: path.join(DEFAULT_DATA_DIR, 'target-directory', 'metadata.json'),
        };

        expect(result).toEqual(expectedResult);
        expect(logger.debug).toHaveBeenCalledWith(
            'Using budget directory: target-directory for syncId sync-id',
            expect.arrayContaining([
                `Metadata path: ${path.join(DEFAULT_DATA_DIR, 'target-directory', 'metadata.json')}`,
                'Local budget ID: custom-id',
            ])
        );
    });

    it('throws an actionable error when no metadata matches the requested sync id', async () => {
        const logger = createLogger();
        const resolver = new BudgetResolver(logger);

        readdirMock.mockResolvedValue([createDirent('alpha'), createDirent('beta')]);
        readFileMock.mockResolvedValue(JSON.stringify({ id: 'alpha', groupId: 'other-sync' }));

        const escapedRoot = DEFAULT_DATA_DIR.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');

        await expect(resolver.resolveBudgetDataDir('missing-sync')).rejects.toThrow(
            new RegExp(
                `No Actual budget directory found for syncId 'missing-sync'\\. ` +
                    `Checked directories under '${escapedRoot}': alpha, beta\\. Metadata issues: ` +
                    `alpha: metadata groupId 'other-sync' does not match requested syncId 'missing-sync'; ` +
                    `beta: metadata groupId 'other-sync' does not match requested syncId 'missing-sync'\\.` +
                    ' Open the budget in Actual Desktop and sync it before retrying\\.'
            )
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('limits directory scanning and warns when exceeding the configured cap', async () => {
        const logger = createLogger();
        const resolver = new BudgetResolver(logger);
        const rootDir = path.join(DEFAULT_DATA_DIR, 'nested');

        readdirMock.mockResolvedValue([
            createDirent('dir-first'),
            createDirent('dir-second'),
            createDirent('dir-third'),
        ]);
        readFileMock.mockImplementation(async (filePath: string) => {
            const directoryName = path.basename(path.dirname(filePath));
            if (directoryName === 'dir-second') {
                return JSON.stringify({ id: 'dir-second', groupId: 'sync-id' });
            }

            return JSON.stringify({ id: directoryName, groupId: 'other' });
        });

        const result = await resolver.resolveBudgetDataDir('sync-id', {
            rootDir,
            maxDirsToScan: 2,
        });

        expect(result.directory).toBe(path.join(rootDir, 'dir-second'));
        expect(logger.warn).toHaveBeenCalledWith('Found 3 directories, scanning first 2 (omitting 1)');
        expect(readFileMock).toHaveBeenCalledTimes(2);
    });

    it('suppresses logging when logResolution is disabled', async () => {
        const logger = createLogger();
        const resolver = new BudgetResolver(logger);

        readdirMock.mockResolvedValue([createDirent('target-directory')]);
        readFileMock.mockResolvedValue(JSON.stringify({ id: 'target-directory', groupId: 'sync-id' }));

        await resolver.resolveBudgetDataDir('sync-id', { logResolution: false });

        expect(logger.debug).not.toHaveBeenCalled();
    });
});
