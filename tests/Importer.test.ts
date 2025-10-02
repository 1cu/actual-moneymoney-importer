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

describe('Importer', () => {
    let mockActualApi: ActualApi;
    let mockAccountMap: AccountMap;
    let mockPayeeTransformer: PayeeTransformer;
    let importer: Importer;
    let config: Config;
    let budgetConfig: ActualBudgetConfig;

    beforeEach(() => {
        vi.clearAllMocks();

        config = {
            payeeTransformation: {
                enabled: false,
                skipModelValidation: false,
                openAiModel: 'gpt-4o-mini',
            },
            import: {
                importUncheckedTransactions: true,
                synchronizeClearedStatus: true,
            },
            actualServers: [],
        };

        budgetConfig = {
            syncId: 'test-budget',
            e2eEncryption: { enabled: false },
            accountMapping: {},
        };

        mockActualApi = {
            getTransactions: vi.fn().mockResolvedValue([]),
            importTransactions: vi.fn().mockResolvedValue({
                added: [],
                updated: [],
                errors: [],
            }),
        } as unknown as ActualApi;

        mockAccountMap = {
            getMap: vi.fn().mockReturnValue(
                new Map([
                    [
                        { uuid: 'mm-account-1', name: 'Test Account', balance: [[100]] },
                        { id: 'actual-account-1', name: 'Test Account' },
                    ],
                ])
            ),
        } as unknown as AccountMap;

        mockPayeeTransformer = {
            transformPayees: vi.fn().mockResolvedValue({}),
        } as unknown as PayeeTransformer;

        importer = new Importer(
            config,
            budgetConfig,
            mockActualApi,
            new Logger(LogLevel.INFO),
            mockAccountMap,
            mockPayeeTransformer
        );
    });

    it('imports transactions successfully', async () => {
        const mockTransactions = [createMockTransaction()];
        vi.mocked(getTransactions).mockResolvedValue(mockTransactions);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockAccountMap.getMap).toHaveBeenCalledWith(['mm-account-1']);
        expect(getTransactions).toHaveBeenCalledWith(
            expect.objectContaining({
                from: new Date('2024-01-01'),
                to: new Date('2024-01-31'),
            })
        );
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([
                expect.objectContaining({
                    date: '2024-01-15',
                    amount: 10000,
                    payee_name: 'Test Transaction',
                    cleared: true,
                }),
            ])
        );
    });

    it('handles empty MoneyMoney transactions', async () => {
        vi.mocked(getTransactions).mockResolvedValue([]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
    });

    it('handles payee transformation when enabled', async () => {
        config.payeeTransformation.enabled = true;
        mockPayeeTransformer.transformPayees = vi.fn().mockResolvedValue({
            'Test Transaction': 'Transformed Test Transaction',
        });

        vi.mocked(getTransactions).mockResolvedValue([createMockTransaction()]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockPayeeTransformer.transformPayees).toHaveBeenCalled();
        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([expect.objectContaining({ payee_name: 'Transformed Test Transaction' })])
        );
    });

    it('handles dry run mode', async () => {
        vi.mocked(getTransactions).mockResolvedValue([createMockTransaction()]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: true,
        });

        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
        expect(mockPayeeTransformer.transformPayees).not.toHaveBeenCalled();
    });

    it('filters duplicate transactions using imported_id', async () => {
        mockActualApi.getTransactions = vi.fn().mockResolvedValue([
            {
                id: 'existing-1',
                imported_id: 'mm-account-1-1',
                date: '2024-01-15',
                amount: 10000,
                payee_name: 'Test Transaction',
            },
        ]);

        vi.mocked(getTransactions).mockResolvedValue([
            createMockTransaction({ id: 1, name: 'Test Transaction' }),
            createMockTransaction({ id: 2, name: 'New Transaction' }),
        ]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([expect.objectContaining({ payee_name: 'New Transaction' })])
        );
    });

    it('creates starting balance transaction when no prior history exists', async () => {
        mockActualApi.getTransactions = vi.fn().mockResolvedValue([]);
        vi.mocked(getTransactions).mockResolvedValue([createMockTransaction()]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([expect.objectContaining({ payee_name: 'Starting balance', amount: 0 })])
        );
    });

    it('handles PayeeTransformer errors gracefully', async () => {
        config.payeeTransformation.enabled = true;
        mockPayeeTransformer.transformPayees = vi.fn().mockRejectedValue(new Error('OpenAI error'));
        vi.mocked(getTransactions).mockResolvedValue([createMockTransaction()]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockPayeeTransformer.transformPayees).toHaveBeenCalled();
    });

    it('filters unchecked transactions when importUncheckedTransactions is false', async () => {
        config.import.importUncheckedTransactions = false;
        vi.mocked(getTransactions).mockResolvedValue([
            createMockTransaction({ booked: true, checkmark: true }),
            createMockTransaction({ booked: false, checkmark: false }),
        ]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockActualApi.importTransactions).toHaveBeenCalledWith(
            'actual-account-1',
            expect.arrayContaining([expect.objectContaining({ cleared: true })])
        );
    });

    it('handles malformed MoneyMoney transactions gracefully', async () => {
        vi.mocked(getTransactions).mockResolvedValue([
            {
                id: 1,
                name: 'Missing amount',
                accountUuid: 'mm-account-1',
                amount: null as unknown as number,
                valueDate: new Date(),
                bookingDate: new Date(),
                booked: true,
                checkmark: true,
                categoryUuid: 'test',
                currency: 'EUR',
            },
            {
                id: 2,
                amount: 100,
                name: 'Missing accountUuid',
                accountUuid: null as unknown as string,
                valueDate: new Date(),
                bookingDate: new Date(),
                booked: true,
                checkmark: true,
                categoryUuid: 'test',
                currency: 'EUR',
            },
        ]);

        await importer.importTransactions({
            accountRefs: ['mm-account-1'],
            from: new Date('2024-01-01'),
            to: new Date('2024-01-31'),
            isDryRun: false,
        });

        expect(mockActualApi.importTransactions).not.toHaveBeenCalled();
    });
});
