import assert from 'node:assert/strict';
import test from 'node:test';
import PayeeTransformer from '../../dist/utils/PayeeTransformer.js';
import {
    OpenAIBackend,
    PayeeMapSchema,
} from '../../dist/utils/TransformationBackend.js';
import { zodResponseFormat } from 'openai/helpers/zod';

const makeLogger = () => ({
    debugMessages: [],
    errorMessages: [],
    debug(message, details) {
        this.debugMessages.push([message, details]);
    },
    error(message) {
        this.errorMessages.push(message);
    },
});

const makeBackendStub = ({ mappings, error, onCreate } = {}) => ({
    transformPayees: async (_prompt, _payees, _temperature) => {
        onCreate?.(_prompt, _payees, _temperature);

        if (error) {
            throw error;
        }

        const resolved = mappings !== undefined ? mappings : {};
        return resolved;
    },
    getLabel: () => 'test-model',
    getPromptExamples: () => '',
    isModelUnavailableError: (error) =>
        error.message.toLowerCase().includes('model') &&
        (error.message.toLowerCase().includes('does not exist') ||
            error.message.toLowerCase().includes('not found')),
    isTemperatureError: (error) =>
        error.message.includes('temperature') &&
        error.message.includes('does not support'),
});

const makeConfig = () => ({
    enabled: true,
    backend: 'openai',
    openAiApiKey: 'test-key',
    openAiModel: 'gpt-5-nano',
    temperature: 1,
    onTransformError: 'warn',
    payeeMatchThreshold: 0.7,
    maxExistingPayeesInPrompt: 100,
});

test('transformPayees returns an empty object for no payees', async () => {
    const logger = makeLogger();
    let createCalls = 0;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            onCreate: () => {
                createCalls++;
            },
        })
    );

    const result = await transformer.transformPayees([], []);

    assert.deepEqual(result, {});
    assert.equal(createCalls, 0);
});

test('transformPayees skips AI for local existing-payee matches', async () => {
    const logger = makeLogger();
    let createCalls = 0;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            onCreate: () => {
                createCalls++;
            },
        })
    );

    const result = await transformer.transformPayees(
        ['Netflix.com'],
        ['Netflix']
    );

    assert.deepEqual(result, {
        'Netflix.com': 'Netflix',
    });
    assert.equal(createCalls, 0);
});

test('transformPayees bounds the relevant existing-payee shortlist', async () => {
    const logger = makeLogger();
    let capturedPrompt;
    let capturedPayees;
    let capturedTemperature;
    const existingPayees = Array.from({ length: 150 }, (_, index) => {
        return `Alpha Market ${String(index + 1).padStart(3, '0')}`;
    });
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: {
                'Alpha Hyperstore': 'Alpha Market 001',
            },
            onCreate: (prompt, payees, temperature) => {
                capturedPrompt = prompt;
                capturedPayees = payees;
                capturedTemperature = temperature;
            },
        })
    );

    const result = await transformer.transformPayees(
        ['Alpha Hyperstore'],
        existingPayees
    );

    assert.equal(capturedTemperature, 1);
    assert.deepEqual(capturedPayees, ['Alpha Hyperstore']);
    assert.match(
        capturedPrompt,
        /Showing 100 relevant existing payees out of 150\./
    );
    assert.equal(
        capturedPrompt
            .split('\n')
            .filter((line) => line.trim().startsWith('Alpha Market ')).length,
        100
    );
    assert.deepEqual(result, {
        'Alpha Hyperstore': 'Alpha Market 001',
    });
});

test('transformPayees snaps transformed payees back to existing names', async () => {
    const logger = makeLogger();
    let capturedPayees;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: {
                'AMZN Mktp US*1234567890': 'Amazon.com',
            },
            onCreate: (_prompt, payees) => {
                capturedPayees = payees;
            },
        })
    );

    const result = await transformer.transformPayees(
        ['AMZN Mktp US*1234567890'],
        ['Amazon']
    );

    assert.deepEqual(capturedPayees, ['AMZN Mktp US*1234567890']);
    assert.deepEqual(result, {
        'AMZN Mktp US*1234567890': 'Amazon',
    });
});

test('transformPayees returns null on API errors', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            error: new Error('Connection refused'),
        })
    );

    const result = await transformer.transformPayees(['Coffee Shop'], []);

    assert.equal(result, null);
    assert.equal(logger.errorMessages.length, 1);
    assert.match(
        logger.errorMessages[0],
        /^Error in payee transformation: Connection refused$/
    );
});

test('transformPayees returns null when model is unavailable', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            error: new Error('The model does not exist'),
        })
    );

    const result = await transformer.transformPayees(['Coffee Shop'], []);

    assert.equal(result, null);
    assert.equal(logger.errorMessages.length, 1);
    assert.match(logger.errorMessages[0], /Model 'test-model' is unavailable/);
});

test('transformPayees returns raw payee names when backend returns no mappings', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: undefined,
        })
    );

    const result = await transformer.transformPayees(['Coffee Shop'], []);

    assert.deepEqual(result, { 'Coffee Shop': 'Coffee Shop' });
    assert.equal(logger.errorMessages.length, 0);
});

// ---------------------------------------------------------------------------
// OpenAIBackend unit tests
// ---------------------------------------------------------------------------

test('OpenAIBackend constructs API call correctly', async () => {
    const capturedOptions = [];
    const stubClient = {
        chat: {
            completions: {
                parse: async (options) => {
                    capturedOptions.push(options);
                    return {
                        choices: [{ message: { parsed: { mappings: [] } } }],
                    };
                },
            },
        },
    };

    const config = makeConfig();
    const backend = new OpenAIBackend(config, stubClient);

    const prompt = 'Clean up these payee names';
    const payees = ['Netflix.com', 'AMZN Mktp'];
    const temperature = 0.7;

    await backend.transformPayees(prompt, payees, temperature);

    assert.equal(capturedOptions.length, 1);
    const opts = capturedOptions[0];
    assert.equal(opts.model, 'gpt-5-nano');
    assert.deepEqual(opts.messages, [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Netflix.com\nAMZN Mktp' },
    ]);
    assert.deepEqual(
        opts.response_format,
        zodResponseFormat(PayeeMapSchema, 'payee_map')
    );
    assert.equal(opts.temperature, 0.7);
});

test('OpenAIBackend returns mapped record from parsed response', async () => {
    const stubClient = {
        chat: {
            completions: {
                parse: async () => ({
                    choices: [
                        {
                            message: {
                                parsed: {
                                    mappings: [
                                        {
                                            rawPayee: 'Netflix.com',
                                            cleanedPayee: 'Netflix',
                                        },
                                        {
                                            rawPayee: 'AMZN Mktp',
                                            cleanedPayee: 'Amazon',
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                }),
            },
        },
    };

    const config = makeConfig();
    const backend = new OpenAIBackend(config, stubClient);
    const result = await backend.transformPayees(
        'prompt',
        ['Netflix.com', 'AMZN Mktp'],
        0.5
    );

    assert.deepEqual(result, {
        'Netflix.com': 'Netflix',
        'AMZN Mktp': 'Amazon',
    });
});

test('OpenAIBackend throws when parsed content is null', async () => {
    const stubClient = {
        chat: {
            completions: {
                parse: async () => ({
                    choices: [{ message: { parsed: null } }],
                }),
            },
        },
    };

    const config = makeConfig();
    const backend = new OpenAIBackend(config, stubClient);

    await assert.rejects(
        () => backend.transformPayees('prompt', ['Netflix.com'], 0.5),
        { message: 'OpenAI returned no payee transformation result' }
    );
});
