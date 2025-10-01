import { describe, it, expect, vi, beforeEach } from 'vitest';
import Importer from '../src/utils/Importer.js';
import type { Config, ActualBudgetConfig } from '../src/utils/config.js';
import type { ActualApi } from '../src/utils/ActualApi.js';
import type { AccountMap } from '../src/utils/AccountMap.js';
import type { PayeeTransformer } from '../src/utils/PayeeTransformer.js';
import Logger, { LogLevel } from '../src/utils/Logger.js';
import { getTransactions as moneyMoneyTransactionsMock } from 'moneymoney';

vi.mock('moneymoney', () => ({
    getTransactions: vi.fn(),
}));

describe('Importer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('imports transactions successfully', async () => {
        const config: Config = {
            payeeTransformation: {
                enabled: false,
                skipModelValidation: false,
                openAiModel: 'gpt-3.5-turbo',
            },
            import: {
                importUncheckedTransactions: true,
                synchronizeClearedStatus: true,
            },
            actualServers: [],
        };

        const budgetConfig: ActualBudgetConfig = {
            syncId: 'test-budget',
            e2eEncryption: { enabled: false },
        };

        const mockActualApi = {
            getTransactions: vi.fn().mockResolvedValue([]),
            importTransactions: vi.fn().mockResolvedValue({
                added: [],
                updated: [],
                errors: [],
            }),
        } as unknown as ActualApi;

        const mockAccountMap = {
            getMap: vi.fn().mockReturnValue(
                new Map([
                    [
                        { uuid: 'mm-account-1', name: 'Test Account', balance: [[100]] },
                        { id: 'actual-account-1', name: 'Test Account' },
                    ],
                ])
            ),
        } as unknown as AccountMap;

        const mockPayeeTransformer = {
            transformPayees: vi.fn().mockResolvedValue([]),
        } as unknown as PayeeTransformer;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        const mockTransactions = [
            {
                id: 'transaction-1',
                uuid: 'transaction-1',
                accountUuid: 'mm-account-1',
                name: 'Test Transaction',
                amount: 100,
                valueDate: new Date('2024-01-15'),
                booked: true,
                cleared: true,
            },
        ];

        moneyMoneyTransactionsMock.mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Verify the method was called with correct parameters
        expect(mockAccountMap.getMap).toHaveBeenCalledWith(['mm-account-1']);
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith('actual-account-1', expect.any(Array));
    });

    it('handles empty MoneyMoney transactions', async () => {
        const config: Config = {
            payeeTransformation: {
                enabled: false,
                skipModelValidation: false,
                openAiModel: 'gpt-3.5-turbo',
            },
            import: {
                importUncheckedTransactions: true,
                synchronizeClearedStatus: true,
            },
            actualServers: [],
        };

        const budgetConfig: ActualBudgetConfig = {
            syncId: 'test-budget',
            e2eEncryption: { enabled: false },
        };

        const mockActualApi = {
            getTransactions: vi.fn().mockResolvedValue([]),
            importTransactions: vi.fn().mockResolvedValue({
                added: [],
                updated: [],
                errors: [],
            }),
        } as unknown as ActualApi;

        const mockAccountMap = {
            getMap: vi.fn().mockReturnValue(
                new Map([
                    [
                        { uuid: 'mm-account-1', name: 'Test Account', balance: [[100]] },
                        { id: 'actual-account-1', name: 'Test Account' },
                    ],
                ])
            ),
        } as unknown as AccountMap;

        const mockPayeeTransformer = {
            transformPayees: vi.fn().mockResolvedValue([]),
        } as unknown as PayeeTransformer;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        moneyMoneyTransactionsMock.mockResolvedValue([]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
        expect(mockPayeeTransformer.transformPayees).not.toHaveBeenCalled();
    });

    it('handles payee transformation', async () => {
        const config: Config = {
            payeeTransformation: {
                enabled: true,
                skipModelValidation: false,
                openAiModel: 'gpt-3.5-turbo',
            },
            import: {
                importUncheckedTransactions: true,
                synchronizeClearedStatus: true,
            },
            actualServers: [],
        };

        const budgetConfig: ActualBudgetConfig = {
            syncId: 'test-budget',
            e2eEncryption: { enabled: false },
        };

        const mockActualApi = {
            getTransactions: vi.fn().mockResolvedValue([]),
            importTransactions: vi.fn().mockResolvedValue({
                added: [],
                updated: [],
                errors: [],
            }),
        } as unknown as ActualApi;

        const mockAccountMap = {
            getMap: vi.fn().mockReturnValue(
                new Map([
                    [
                        { uuid: 'mm-account-1', name: 'Test Account', balance: [[100]] },
                        { id: 'actual-account-1', name: 'Test Account' },
                    ],
                ])
            ),
        } as unknown as AccountMap;

        const mockPayeeTransformer = {
            transformPayees: vi.fn().mockResolvedValue([]),
        } as unknown as PayeeTransformer;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        const mockTransactions = [
            {
                id: 'transaction-1',
                uuid: 'transaction-1',
                accountUuid: 'mm-account-1',
                name: 'Test Transaction',
                amount: 100,
                valueDate: new Date('2024-01-15'),
                booked: true,
                cleared: true,
            },
        ];

        moneyMoneyTransactionsMock.mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Verify the complete import workflow including payee transformation
        expect(mockAccountMap.getMap).toHaveBeenCalled();
        expect(mockPayeeTransformer.transformPayees).toHaveBeenCalledWith(['Test Transaction', 'Starting balance']);
        expect(mockActualApi.getTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.objectContaining({
                from: expect.any(Date),
                to: expect.any(Date),
            })
        );
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    date: '2024-01-15',
                    amount: 10000, // MoneyMoney uses cents
                    payee_name: 'Test Transaction',
                    cleared: true,
                }),
            ])
        );
    });

    it('handles dry run mode', async () => {
        const config: Config = {
            payeeTransformation: {
                enabled: false,
                skipModelValidation: false,
                openAiModel: 'gpt-3.5-turbo',
            },
            import: {
                importUncheckedTransactions: true,
                synchronizeClearedStatus: true,
            },
            actualServers: [],
        };

        const budgetConfig: ActualBudgetConfig = {
            syncId: 'test-budget',
            e2eEncryption: { enabled: false },
        };

        const mockActualApi = {
            getTransactions: vi.fn().mockResolvedValue([]),
            importTransactions: vi.fn().mockResolvedValue({
                added: [],
                updated: [],
                errors: [],
            }),
        } as unknown as ActualApi;

        const mockAccountMap = {
            getMap: vi.fn().mockReturnValue(
                new Map([
                    [
                        { uuid: 'mm-account-1', name: 'Test Account', balance: [[100]] },
                        { id: 'actual-account-1', name: 'Test Account' },
                    ],
                ])
            ),
        } as unknown as AccountMap;

        const mockPayeeTransformer = {
            transformPayees: vi.fn().mockResolvedValue([]),
        } as unknown as PayeeTransformer;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        const mockTransactions = [
            {
                id: 'transaction-1',
                uuid: 'transaction-1',
                accountUuid: 'mm-account-1',
                name: 'Test Transaction',
                amount: 100,
                valueDate: new Date('2024-01-15'),
                booked: true,
                cleared: true,
            },
        ];

        moneyMoneyTransactionsMock.mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: true,
        });

        expect(mockAccountMap.getMap).toHaveBeenCalledWith(['mm-account-1']);
        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
        expect(mockPayeeTransformer.transformPayees).not.toHaveBeenCalled();
    });
});
