import { describe, expect, it } from 'vitest';
import { configSchema, type Config } from '../src/utils/config.js';

const createBaseConfig = (overrides: Partial<Config> = {}): Config => ({
    payeeTransformation: {
        enabled: false,
        openAiModel: 'gpt-4o-mini',
        skipModelValidation: false,
    },
    import: {
        importUncheckedTransactions: true,
        synchronizeClearedStatus: true,
    },
    actualServers: [
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'test-password',
            requestTimeoutMs: 45000,
            budgets: [
                {
                    syncId: 'test-sync-id',
                    e2eEncryption: { enabled: false, password: '' },
                    accountMapping: {},
                },
            ],
        },
    ],
    ...overrides,
});

describe('Config Validation', () => {
    describe('E2E Encryption Validation', () => {
        it('should allow empty password when encryption is disabled', () => {
            const config = createBaseConfig();
            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should require non-empty password when encryption is enabled', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: true, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).toThrow();
        });

        it('should accept valid password when encryption is enabled', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: true, password: 'valid-password' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });
    });

    describe('Server Configuration Validation', () => {
        it('should require serverUrl', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: '',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).toThrow();
        });

        it('should require serverPassword', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: '',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).toThrow();
        });

        it('should require at least one budget', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).toThrow();
        });

        it('should require syncId for budget', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: '',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).toThrow();
        });
    });

    describe('Payee Transformation Configuration', () => {
        it('should allow disabled payee transformation', () => {
            const config = createBaseConfig({
                payeeTransformation: {
                    enabled: false,
                    openAiModel: 'gpt-4o-mini',
                    skipModelValidation: false,
                },
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should require openAiApiKey when payee transformation is enabled', () => {
            const config = createBaseConfig({
                payeeTransformation: {
                    enabled: true,
                    openAiModel: 'gpt-4o-mini',
                    skipModelValidation: false,
                },
            });
            expect(() => configSchema.parse(config)).toThrow();
        });

        it('should accept valid payee transformation config', () => {
            const config = createBaseConfig({
                payeeTransformation: {
                    enabled: true,
                    openAiModel: 'gpt-4o-mini',
                    skipModelValidation: false,
                    openAiApiKey: 'valid-api-key',
                },
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });
    });

    describe('Import Configuration', () => {
        it('should allow default import settings', () => {
            const config = createBaseConfig({
                import: {
                    importUncheckedTransactions: true,
                    synchronizeClearedStatus: true,
                },
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should allow custom import settings', () => {
            const config = createBaseConfig({
                import: {
                    importUncheckedTransactions: false,
                    synchronizeClearedStatus: false,
                },
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });
    });

    describe('Account Mapping', () => {
        it('should allow empty account mapping', () => {
            const config = createBaseConfig();
            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should allow valid account mapping', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {
                                    'mm-account-1': 'actual-account-1',
                                    'mm-account-2': 'actual-account-2',
                                },
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });
    });

    describe('Multiple Servers', () => {
        it('should allow multiple servers', () => {
            const config = createBaseConfig({
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id-1',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                    {
                        serverUrl: 'http://localhost:5007',
                        serverPassword: 'test-password-2',
                        requestTimeoutMs: 45000,
                        budgets: [
                            {
                                syncId: 'test-sync-id-2',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            });
            expect(() => configSchema.parse(config)).not.toThrow();
        });
    });

    describe('Edge Cases', () => {
        it('should handle minimal valid config', () => {
            const config = createBaseConfig();
            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should reject empty actualServers array', () => {
            const config = createBaseConfig({ actualServers: [] });
            expect(() => configSchema.parse(config)).toThrow();
        });
    });
});
