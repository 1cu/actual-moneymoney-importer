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

const makeBackendStub = ({
    mappings,
    error,
    onCreate,
    promptExamples,
} = {}) => ({
    transformPayees: async (_prompt, _payees, _temperature) => {
        onCreate?.(_prompt, _payees, _temperature);

        if (error) {
            throw error;
        }

        const resolved = mappings !== undefined ? mappings : {};
        return resolved;
    },
    getLabel: () => 'test-model',
    getPromptExamples: () => promptExamples ?? '',
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

test('transformPayees logs raw backend request and response', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: {
                'Example Store, 800-5550100 Us': 'Example Store',
            },
        })
    );

    await transformer.transformPayees(
        ['Example Store, 800-5550100 Us'],
        ['Example Store']
    );

    const requestLog = logger.debugMessages.find(
        ([message]) => message === 'Raw payee transformation request'
    );
    const responseLog = logger.debugMessages.find(
        ([message]) => message === 'Raw payee transformation response'
    );

    assert.ok(requestLog, 'Expected raw request debug log');
    assert.ok(responseLog, 'Expected raw response debug log');
    assert.match(
        requestLog[1].join('\n'),
        /User message \(1 payees\): Example Store, 800-5550100 Us/
    );
    assert.match(responseLog[1].join('\n'), /"Example Store"/);
});

test('transformPayees raw logs shorten existing payees but keep raw payees and response complete', async () => {
    const logger = makeLogger();
    const rawPayees = Array.from(
        { length: 6 },
        (_, index) => `Example Store ${index + 1}, 800-555010${index} Us`
    );
    const existingPayees = Array.from(
        { length: 12 },
        (_, index) => `Example Store ${index + 1}`
    );
    const mappings = Object.fromEntries(
        rawPayees.map((payee) => [payee, payee.split(',')[0]])
    );
    const transformer = new PayeeTransformer(
        { ...makeConfig(), payeeMatchThreshold: 1 },
        logger,
        makeBackendStub({
            mappings,
            promptExamples: `
Examples (input separated by newline, output shown as JSON):

Input:
Example Store, 800-5550100 Us
Output:
{"Example Store, 800-5550100 Us": "Example Store"}`,
        })
    );

    await transformer.transformPayees(rawPayees, existingPayees);

    const requestLog = logger.debugMessages.find(
        ([message]) => message === 'Raw payee transformation request'
    );
    const responseLog = logger.debugMessages.find(
        ([message]) => message === 'Raw payee transformation response'
    );

    assert.ok(requestLog, 'Expected raw request debug log');
    assert.ok(responseLog, 'Expected raw response debug log');

    const requestDetails = requestLog[1].join('\n');
    const responseDetails = responseLog[1].join('\n');

    assert.match(requestDetails, /Base system message:/);
    assert.match(
        requestDetails,
        /Existing payees in prompt \(first 10 of 12\):/
    );
    assert.match(
        requestDetails,
        /\.\.\. 2 more existing payees omitted from log/
    );
    assert.match(
        requestDetails,
        /System message preview \(10 of 12 existing payees included\):/
    );
    assert.match(requestDetails, /Examples \(input separated/);
    assert.match(requestDetails, /User message \(6 payees\):/);
    assert.match(requestDetails, /Example Store 6, 800-5550105 Us/);
    assert.match(responseDetails, /Response JSON \(6 mappings\):/);
    assert.match(responseDetails, /Example Store 6, 800-5550105 Us/);
});

test('transformPayees prompt requires exact raw keys and includes noisy suffix example', async () => {
    const logger = makeLogger();
    let capturedPrompt;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: {},
            promptExamples: `
Examples (input separated by newline, output shown as JSON):

Input:
Example Store, 800-5550100 Us
Output:
{"Example Store, 800-5550100 Us": "Example Store"}`,
            onCreate: (prompt) => {
                capturedPrompt = prompt;
            },
        })
    );

    await transformer.transformPayees(['Coffee Shop Terminal 123'], []);

    assert.match(
        capturedPrompt,
        /The JSON object keys MUST be copied exactly from the input lines\./
    );
    assert.match(capturedPrompt, /Only clean the JSON values\./);
    assert.match(capturedPrompt, /Example Store, 800-5550100 Us/);
    assert.match(
        capturedPrompt,
        /"Example Store, 800-5550100 Us": "Example Store"/
    );
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

test('transformPayees matches AI response keys case-insensitively', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: {
                'netflix.com': 'Netflix',
                'AMZN MKTP': 'Amazon',
            },
        })
    );

    const result = await transformer.transformPayees(
        ['NETFLIX.COM', 'Amzn Mktp', 'Spotify'],
        []
    );

    assert.equal(logger.errorMessages.length, 0);
    assert.deepEqual(result, {
        'NETFLIX.COM': 'Netflix',
        'Amzn Mktp': 'Amazon',
        Spotify: 'Spotify',
    });
});

test('transformPayees accepts unambiguous normalized-prefix AI response keys', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: {
                'Example Store': 'Example Store',
            },
        })
    );

    const result = await transformer.transformPayees(
        ['Example Store, 800-5550100 Us'],
        ['Example Store']
    );

    assert.equal(logger.errorMessages.length, 0);
    assert.deepEqual(result, {
        'Example Store, 800-5550100 Us': 'Example Store',
    });
});

test('transformPayees keeps raw name when AI response key not found', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeBackendStub({
            mappings: { 'Some Other': 'Cleaned' },
        })
    );

    const result = await transformer.transformPayees(['Coffee Shop'], []);

    assert.equal(logger.errorMessages.length, 0);
    assert.deepEqual(result, { 'Coffee Shop': 'Coffee Shop' });
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
