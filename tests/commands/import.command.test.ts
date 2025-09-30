import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/utils/AccountMap.js', () => ({
    AccountMap: vi.fn().mockImplementation(() => ({
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        getMap: vi.fn().mockReturnValue(new Map()),
    })),
}));

vi.mock('../../src/utils/ActualApi.js', () => ({
    default: vi.fn().mockImplementation(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        loadBudget: vi.fn().mockResolvedValue(undefined),
        importTransactions: vi.fn().mockResolvedValue({ added: [], updated: [], errors: [] }),
        shutdown: vi.fn().mockResolvedValue(undefined),
    })),
}));

vi.mock('../../src/utils/Importer.js', () => ({
    default: vi.fn().mockImplementation(() => ({
        importTransactions: vi.fn().mockResolvedValue(undefined),
    })),
}));

vi.mock('../../src/utils/PayeeTransformer.js', () => ({
    default: vi.fn().mockImplementation(() => ({
        transformPayees: vi.fn().mockResolvedValue(new Map()),
    })),
}));

vi.mock('../../src/utils/config.js', () => ({
    loadConfig: vi.fn().mockResolvedValue({
        config: {
            actualServers: [{ serverUrl: 'http://localhost:5000', serverPassword: 'test' }],
            payeeTransformation: { enabled: false },
        },
    }),
}));

vi.mock('moneymoney', () => ({
    checkDatabaseUnlocked: vi.fn().mockResolvedValue(true),
}));

describe('import command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should be defined', async () => {
        const { default: commandModule } = await import('../../src/commands/import.command.js');

        expect(commandModule).toBeDefined();
        expect(commandModule.command).toBe('import');
        expect(commandModule.describe).toBeDefined();
        expect(commandModule.handler).toBeDefined();
    });

    it('should have proper command structure', async () => {
        const { default: commandModule } = await import('../../src/commands/import.command.js');

        expect(commandModule.command).toBe('import');
        expect(commandModule.describe).toBe('Import data from MoneyMoney');
        expect(commandModule.builder).toBeDefined();
        expect(commandModule.handler).toBeDefined();
    });
});
