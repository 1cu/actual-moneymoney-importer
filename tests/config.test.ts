import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/utils/config.js';

// Helper function to create base config
const createBaseConfig = (overrides = {}) => ({
    payeeTransformation: { enabled: false },
    import: { importUncheckedTransactions: true },
    actualServers: [
        {
            serverUrl: 'http://localhost:5006',
            serverPassword: 'test-password',
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
            const validConfig = createBaseConfig({
                actualServers: [{
                    ...createBaseConfig().actualServers[0],
                    budgets: [{
                        ...createBaseConfig().actualServers[0].budgets[0],
                        accountMapping: { 'test-account': 'actual-account-id' }
                    }]
                }]
            });
            expect(() => configSchema.parse(validConfig)).not.toThrow();
        });

        it('should allow undefined password when encryption is disabled', () => {
            const validConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: false,
                                    // password is undefined
                                },
                                accountMapping: {
                                    'test-account': 'actual-account-id',
                                },
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(validConfig)).not.toThrow();
        });

        it('should require non-empty password when encryption is enabled', () => {
            const invalidConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: true,
                                    password: '',
                                },
                                accountMapping: {
                                    'test-account': 'actual-account-id',
                                },
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(invalidConfig)).toThrow();
        });

        it('should reject whitespace-only password when encryption is enabled', () => {
            const invalidConfig = {
                payeeTransformation: { enabled: false },
                import: { importUncheckedTransactions: true },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: true,
                                    password: '   ',
                                },
                                accountMapping: {
                                    'test-account': 'actual-account-id',
                                },
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(invalidConfig)).toThrow();
        });

        it('should require password when encryption is enabled (undefined password)', () => {
            const invalidConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: true,
                                    // password is undefined
                                },
                                accountMapping: {
                                    'test-account': 'actual-account-id',
                                },
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(invalidConfig)).toThrow();
        });

        it('should accept valid password when encryption is enabled', () => {
            const validConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: true,
                                    password: 'valid-encryption-password',
                                },
                                accountMapping: {
                                    'test-account': 'actual-account-id',
                                },
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(validConfig)).not.toThrow();
        });

        it('should handle multiple budgets with different encryption settings', () => {
            const validConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id-1',
                                e2eEncryption: {
                                    enabled: false,
                                    password: '',
                                },
                                accountMapping: {
                                    'test-account-1': 'actual-account-id-1',
                                },
                            },
                            {
                                syncId: 'test-sync-id-2',
                                e2eEncryption: {
                                    enabled: true,
                                    password: 'valid-encryption-password',
                                },
                                accountMapping: {
                                    'test-account-2': 'actual-account-id-2',
                                },
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(validConfig)).not.toThrow();
        });
    });

    describe('Basic Config Validation', () => {
        it('should validate a minimal valid configuration', () => {
            const validConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: false,
                                    password: '',
                                },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(validConfig)).not.toThrow();
        });

        it('should reject configuration with missing required fields', () => {
            const invalidConfig = {
                payeeTransformation: {
                    enabled: false,
                },
                import: {
                    importUncheckedTransactions: true,
                },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        // missing serverPassword
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: {
                                    enabled: false,
                                    password: '',
                                },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(invalidConfig)).toThrow();
        });
    });

    describe('URL Validation', () => {
        it('should reject invalid serverUrl formats', () => {
            const invalidConfig = createBaseConfig({
                actualServers: [{ ...createBaseConfig().actualServers[0], serverUrl: 'not-a-valid-url' }]
            });
            expect(() => configSchema.parse(invalidConfig)).toThrow();
        });

        it('should accept valid serverUrl formats', () => {
            const validConfigs = ['http://localhost:5006', 'https://example.com', 'https://subdomain.example.com:8080'];
            validConfigs.forEach((serverUrl) => {
                const config = createBaseConfig({
                    actualServers: [{ ...createBaseConfig().actualServers[0], serverUrl }]
                });
                expect(() => configSchema.parse(config)).not.toThrow();
            });
        });
    });

    describe('Date Validation', () => {
        it('should reject invalid earliestImportDate formats', () => {
            const invalidDates = ['not-a-date', '2024-13-01', '2024-01-32', '2024/01/01', '01-01-2024'];
            invalidDates.forEach((invalidDate) => {
                const config = createBaseConfig({
                    actualServers: [{
                        ...createBaseConfig().actualServers[0],
                        budgets: [{
                            ...createBaseConfig().actualServers[0].budgets[0],
                            earliestImportDate: invalidDate
                        }]
                    }]
                });
                expect(() => configSchema.parse(config)).toThrow();
            });
        });

        it('should accept valid earliestImportDate formats', () => {
            const validDates = ['2024-01-01', '2023-12-31', '2024-02-29'];
            validDates.forEach((validDate) => {
                const config = createBaseConfig({
                    actualServers: [{
                        ...createBaseConfig().actualServers[0],
                        budgets: [{
                            ...createBaseConfig().actualServers[0].budgets[0],
                            earliestImportDate: validDate
                        }]
                    }]
                });
                expect(() => configSchema.parse(config)).not.toThrow();
            });
        });
    });

    describe('Multiple Servers', () => {
        it('should accept multiple actualServers entries', () => {
            const config = {
                payeeTransformation: { enabled: false },
                import: { importUncheckedTransactions: true },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password-1',
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
                        budgets: [
                            {
                                syncId: 'test-sync-id-2',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(config)).not.toThrow();
        });
    });

    describe('Payee Transformation', () => {
        it('should accept payeeTransformation.enabled: true with API key', () => {
            const config = {
                payeeTransformation: {
                    enabled: true,
                    openAiApiKey: 'sk-test-key',
                },
                import: { importUncheckedTransactions: true },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should reject payeeTransformation.enabled: true without API key', () => {
            const config = {
                payeeTransformation: {
                    enabled: true,
                    // missing openAiApiKey
                },
                import: { importUncheckedTransactions: true },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
                        budgets: [
                            {
                                syncId: 'test-sync-id',
                                e2eEncryption: { enabled: false, password: '' },
                                accountMapping: {},
                            },
                        ],
                    },
                ],
            };

            expect(() => configSchema.parse(config)).toThrow();
        });
    });

    describe('Account Mapping', () => {
        it('should accept valid accountMapping structures', () => {
            const config = {
                payeeTransformation: { enabled: false },
                import: { importUncheckedTransactions: true },
                actualServers: [
                    {
                        serverUrl: 'http://localhost:5006',
                        serverPassword: 'test-password',
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
            };

            expect(() => configSchema.parse(config)).not.toThrow();
        });

        it('should reject malformed accountMapping structures', () => {
            const invalidMappings = [
                { 'mm-account-1': 123 }, // number instead of string
                { 'mm-account-1': null }, // null value
                { 'mm-account-1': undefined }, // undefined value
            ];

            invalidMappings.forEach((invalidMapping) => {
                const config = {
                    payeeTransformation: { enabled: false },
                    import: { importUncheckedTransactions: true },
                    actualServers: [
                        {
                            serverUrl: 'http://localhost:5006',
                            serverPassword: 'test-password',
                            budgets: [
                                {
                                    syncId: 'test-sync-id',
                                    e2eEncryption: { enabled: false, password: '' },
                                    accountMapping: invalidMapping,
                                },
                            ],
                        },
                    ],
                };

                expect(() => configSchema.parse(config)).toThrow();
            });
        });
    });
});
