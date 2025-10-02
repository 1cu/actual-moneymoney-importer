import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';

import type Logger from '../src/utils/Logger.js';
import { LogLevel } from '../src/utils/Logger.js';

const listMock = vi.fn();
const createMock = vi.fn();

class MockOpenAI {
    public models = {
        list: listMock,
    };

    public chat = {
        completions: {
            create: createMock,
        },
    };

    public constructor(public readonly options: { apiKey: string; timeout?: number }) {}
}

vi.mock('openai', () => ({
    default: MockOpenAI,
}));

let dataDir: string;

vi.mock('../src/utils/shared.js', async () => {
    const actual = await vi.importActual('../src/utils/shared.js');

    return {
        ...actual,
        get DEFAULT_DATA_DIR() {
            return dataDir;
        },
    };
});

const createLogger = () =>
    ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLevel: () => LogLevel.DEBUG,
    }) as unknown as Logger;

const importTransformer = async () => {
    const module = await import('../src/utils/PayeeTransformer.js');
    return module.default;
};

beforeEach(async () => {
    listMock.mockReset();
    createMock.mockReset();

    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'actual-moneymoney-test-'));

    createMock.mockImplementation(async (config: { messages: Array<{ role?: string; content: string }> }) => {
        let userMessage = '';
        for (let i = config.messages.length - 1; i >= 0; i--) {
            const message = config.messages[i];
            if (message && message.role === 'user') {
                userMessage = message.content;
                break;
            }
        }
        if (!userMessage && config.messages.length > 0) {
            const lastMessage = config.messages[config.messages.length - 1];
            userMessage = lastMessage?.content ?? '';
        }
        const payees: string[] = userMessage.split('\n').filter(Boolean);
        const result: Record<string, string> = Object.fromEntries(
            payees.map((payee: string) => [payee, `${payee}-normalized`])
        );

        return {
            choices: [
                {
                    message: {
                        content: JSON.stringify(result),
                    },
                },
            ],
        };
    });

    listMock.mockResolvedValue({
        data: [{ id: 'gpt-3.5-turbo' }, { id: 'gpt-4o-mini' }],
    });
});

afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    // Reset module state between tests to clear static caches
    vi.resetModules();
});

describe('PayeeTransformer', () => {
    it('skips model validation when configured', async () => {
        const PayeeTransformer = await importTransformer();
        const transformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'custom-model',
                skipModelValidation: true,
            },
            createLogger()
        );

        const result = await transformer.transformPayees(['Example Vendor']);

        expect(result).toEqual({
            'Example Vendor': 'Example Vendor-normalized',
        });
        expect(listMock).not.toHaveBeenCalled();
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('caches model list between transformer instances', async () => {
        const PayeeTransformer = await importTransformer();

        const firstTransformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            createLogger()
        );

        await firstTransformer.transformPayees(['Vendor A']);

        const secondTransformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            createLogger()
        );

        await secondTransformer.transformPayees(['Vendor B']);

        // Each transformer instance has its own model cache, but with in-memory caching,
        // the second call will use the cached result, so only 1 API call is made
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('memoizes transformed payees within the same run', async () => {
        const PayeeTransformer = await importTransformer();

        const transformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            createLogger()
        );

        await transformer.transformPayees(['Vendor C']);
        listMock.mockClear();
        createMock.mockClear();

        const result = await transformer.transformPayees(['Vendor C']);

        expect(result).toEqual({ 'Vendor C': 'Vendor C-normalized' });
        expect(createMock).not.toHaveBeenCalled();
    });

    it('uses in-memory cache for model list', async () => {
        const PayeeTransformer = await importTransformer();
        const transformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            createLogger()
        );

        // First call should fetch models
        await transformer.transformPayees(['Vendor A']);
        expect(listMock).toHaveBeenCalledTimes(1);

        // Second call should use cached models
        listMock.mockClear();
        await transformer.transformPayees(['Vendor B']);
        expect(listMock).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
        const PayeeTransformer = await importTransformer();
        const logger = createLogger();
        const transformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            logger
        );

        // Mock API error
        createMock.mockRejectedValueOnce(new Error('API Error'));

        const result = await transformer.transformPayees(['Vendor Error']);

        expect(result).toBeNull();
        expect(logger.error).toHaveBeenCalledWith('Payee transformation failed: API Error', ['Payees(count): 1']);
    });

    it('handles empty OpenAI payload by falling back to original payee names', async () => {
        const PayeeTransformer = await importTransformer();
        const logger = createLogger();
        const transformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            logger
        );

        // Mock OpenAI to return empty payload
        createMock.mockImplementation(async () => ({
            choices: [
                {
                    message: {
                        content: JSON.stringify({}),
                    },
                },
            ],
        }));

        const result = await transformer.transformPayees(['Vendor A', 'Vendor B']);

        expect(result).toEqual({
            'Vendor A': 'Vendor A',
            'Vendor B': 'Vendor B',
        });

        // The current implementation doesn't log warnings for empty payloads
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('handles duplicate keys in OpenAI payload by using the last value', async () => {
        const PayeeTransformer = await importTransformer();
        const logger = createLogger();
        const transformer = new PayeeTransformer(
            {
                enabled: true,
                openAiApiKey: 'key',
                openAiModel: 'gpt-3.5-turbo',
                skipModelValidation: false,
            },
            logger
        );

        // Mock OpenAI to return payload with duplicate keys
        // Note: JSON.parse will keep the last value for duplicate keys
        createMock.mockImplementation(async () => ({
            choices: [
                {
                    message: {
                        content: '{"Vendor A": "Normalized A", "Vendor A": "Normalized B"}',
                    },
                },
            ],
        }));

        const result = await transformer.transformPayees(['Vendor A', 'Vendor B']);

        // The current implementation uses the last value for duplicate keys
        expect(result).toEqual({
            'Vendor A': 'Normalized B',
            'Vendor B': 'Vendor B',
        });

        // The current implementation doesn't log warnings for duplicate keys
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
