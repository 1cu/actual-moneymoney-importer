import { describe, it, expect, vi, beforeEach } from 'vitest';
import Importer from '../src/utils/Importer.js';
import type { Config, ActualBudgetConfig } from '../src/utils/config.js';
import type ActualApi from '../src/utils/ActualApi.js';
import type { AccountMap } from '../src/utils/AccountMap.js';
import type PayeeTransformer from '../src/utils/PayeeTransformer.js';
import Logger, { LogLevel } from '../src/utils/Logger.js';
import { getTransactions } from 'moneymoney';

vi.mock('moneymoney', () => ({
    getTransactions: vi.fn(),
}));

const createMockTransaction = (overrides = {}) => ({
    id: 1,
    accountUuid: 'mm-account-1',
    name: 'Test Transaction',
    amount: 100,
    valueDate: new Date('2024-01-15'),
    bookingDate: new Date('2024-01-15'),
    booked: true,
    checkmark: true,
    categoryUuid: 'test-category',
    currency: 'EUR',
    ...overrides,
});

function createTestContext(
    overrides: {
        payeeEnabled?: boolean;
        config?: Partial<Config>;
        budgetConfig?: Partial<ActualBudgetConfig>;
    } = {}
) {
    const config: Config = {
        payeeTransformation: {
            enabled: overrides.payeeEnabled ?? false,
            skipModelValidation: false,
            openAiModel: 'gpt-4o-mini',
        },
        import: {
            importUncheckedTransactions: true,
            synchronizeClearedStatus: true,
        },
        actualServers: [],
        ...overrides.config,
    };

    const budgetConfig: ActualBudgetConfig = {
        syncId: 'test-budget',
        e2eEncryption: { enabled: false },
        accountMapping: {},
        ...overrides.budgetConfig,
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
        transformPayees: vi.fn().mockResolvedValue({}),
    } as unknown as PayeeTransformer;

    const importer = new Importer(
        config,
        budgetConfig,
        mockActualApi,
        new Logger(LogLevel.INFO),
        mockAccountMap,
        mockPayeeTransformer
    );

    return {
        config,
        budgetConfig,
        mockActualApi,
        mockAccountMap,
        mockPayeeTransformer,
        importer,
    };
}

describe('Importer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('imports transactions successfully', async () => {
        const { importer, mockAccountMap, mockActualApi, mockPayeeTransformer } = createTestContext();

        const mockTransactions = [createMockTransaction()];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Verify the method was called with correct parameters
        expect(mockAccountMap.getMap).toHaveBeenCalledWith(['mm-account-1']);
        expect(getTransactions).toHaveBeenCalledWith(
            expect.objectContaining({
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
            })
        );
        expect(mockPayeeTransformer.transformPayees).not.toHaveBeenCalled();
        expect(mockActualApi.importTransactions).toHaveBeenCalledTimes(1);
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    date: '2024-01-15',
                    amount: 10000,
                    payee_name: 'Test Transaction',
                    cleared: true,
                    imported_id: expect.any(String) as string,
                }),
            ])
        );
    });

    it('handles empty MoneyMoney transactions', async () => {
        const { importer, mockActualApi, mockPayeeTransformer } = createTestContext();

        vi.mocked(getTransactions).mockResolvedValue([]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(getTransactions).toHaveBeenCalledWith(
            expect.objectContaining({
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
            })
        );
        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
        expect(mockPayeeTransformer.transformPayees).not.toHaveBeenCalled();
    });

    it('handles payee transformation', async () => {
        const { config, budgetConfig, mockAccountMap, mockActualApi } = createTestContext({
            payeeEnabled: true,
        });

        const mockPayeeTransformer = {
            transformPayees: vi.fn().mockResolvedValue({
                'Test Transaction': 'Transformed Test Transaction',
                'Starting balance': 'Starting balance',
            }),
        } as unknown as PayeeTransformer;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        const mockTransactions = [createMockTransaction()];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

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
                from: expect.any(Date) as Date,
                to: expect.any(Date) as Date,
            })
        );
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    date: '2024-01-15',
                    amount: 10000, // MoneyMoney uses cents
                    payee_name: 'Transformed Test Transaction',
                    cleared: true,
                    imported_id: expect.any(String) as string,
                }),
            ])
        );
    });

    it('handles dry run mode', async () => {
        const { importer, mockAccountMap, mockActualApi, mockPayeeTransformer } = createTestContext();

        const mockTransactions = [createMockTransaction()];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: true,
        });

        expect(mockAccountMap.getMap).toHaveBeenCalledWith(['mm-account-1']);
        expect(getTransactions).toHaveBeenCalledWith(
            expect.objectContaining({
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
            })
        );
        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
        expect(mockPayeeTransformer.transformPayees).not.toHaveBeenCalled();
    });

    it('filters duplicate transactions using imported_id', async () => {
        const { importer, mockActualApi } = createTestContext();

        // Mock existing transactions with imported_id
        const existingTransaction = {
            id: 'existing-1',
            imported_id: 'mm-account-1-1', // This matches the first transaction's generated ID
            date: '2024-01-15',
            amount: 10000,
            payee_name: 'Test Transaction',
        };
        mockActualApi.getTransactions = vi.fn().mockResolvedValue([existingTransaction]);

        const mockTransactions = [
            createMockTransaction({ id: 1, name: 'Test Transaction' }),
            createMockTransaction({ id: 2, name: 'New Transaction' }),
        ];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Should only import the new transaction, not the duplicate
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    payee_name: 'New Transaction',
                }),
            ])
        );
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.not.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Test Transaction',
                }),
            ])
        );
    });

    it('creates starting balance transaction when no prior history exists', async () => {
        const { importer, mockActualApi } = createTestContext();

        // Mock no existing transactions
        mockActualApi.getTransactions = vi.fn().mockResolvedValue([]);

        const mockTransactions = [createMockTransaction()];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Should include both the original transaction and a starting balance
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Test Transaction',
                }),
                expect.objectContaining({
                    payee_name: 'Starting balance',
                }),
            ])
        );
    });

    it('handles PayeeTransformer errors gracefully', async () => {
        const { config, budgetConfig, mockAccountMap, mockActualApi } = createTestContext({
            payeeEnabled: true,
        });

        const mockPayeeTransformer = {
            transformPayees: vi.fn().mockRejectedValue(new Error('OpenAI API error')),
        } as unknown as PayeeTransformer;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        const mockTransactions = [createMockTransaction()];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        // Should not throw, but should fall back to original payees
        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Should still import transactions with original payee names
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Test Transaction',
                }),
            ])
        );
    });

    it('filters unchecked transactions when importUncheckedTransactions is false', async () => {
        const { importer, mockActualApi } = createTestContext({
            config: {
                import: {
                    importUncheckedTransactions: false,
                    synchronizeClearedStatus: true,
                },
            },
        });

        const mockTransactions = [
            createMockTransaction({ id: 1, booked: true, name: 'Booked Transaction' }),
            createMockTransaction({ id: 2, booked: false, name: 'Unbooked Transaction' }),
            createMockTransaction({ id: 3, booked: true, name: 'Another Booked Transaction' }),
        ];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Should import only booked transactions (id: 1 and 3)
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Booked Transaction',
                }),
                expect.objectContaining({
                    payee_name: 'Another Booked Transaction',
                }),
            ])
        );
        // Should not import unbooked transactions (id: 2)
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.not.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Unbooked Transaction',
                }),
            ])
        );
    });

    it('includes transactions on exact date boundaries', async () => {
        const { importer, mockActualApi } = createTestContext();

        const mockTransactions = [
            createMockTransaction({ id: 1, valueDate: new Date('2024-01-01') }),
            createMockTransaction({ id: 2, valueDate: new Date('2024-01-31') }),
            createMockTransaction({ id: 3, valueDate: new Date('2024-01-15') }),
        ];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Should import all transactions including boundary dates
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({ date: '2024-01-01' }),
                expect.objectContaining({ date: '2024-01-15' }),
                expect.objectContaining({ date: '2024-01-31' }),
            ])
        );
    });

    it('handles multiple account mappings', async () => {
        const { config, budgetConfig, mockActualApi, mockPayeeTransformer } = createTestContext();

        const mockAccountMap = {
            getMap: vi.fn().mockReturnValue(
                new Map([
                    [
                        { uuid: 'mm-account-1', name: 'Account 1', balance: [[100]] },
                        { id: 'actual-account-1', name: 'Account 1' },
                    ],
                    [
                        { uuid: 'mm-account-2', name: 'Account 2', balance: [[200]] },
                        { id: 'actual-account-2', name: 'Account 2' },
                    ],
                ])
            ),
        } as unknown as AccountMap;

        const importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );

        const mockTransactions = [
            createMockTransaction({ id: 1, accountUuid: 'mm-account-1' }),
            createMockTransaction({ id: 2, accountUuid: 'mm-account-2' }),
        ];

        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1', 'mm-account-2'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        // Should import transactions for both accounts
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Test Transaction',
                }),
            ])
        );
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-2',
            expect.arrayContaining([
                expect.objectContaining({
                    payee_name: 'Test Transaction',
                }),
            ])
        );
    });
});
