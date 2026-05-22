import assert from 'node:assert/strict';
import test from 'node:test';
import PayeeTransformer from '../../dist/utils/PayeeTransformer.js';

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

const makeOpenAIStub = ({ response, error, onCreate } = {}) => ({
    chat: {
        completions: {
            create: async (options) => {
                onCreate?.(options);

                if (error) {
                    throw error;
                }

                return (
                    response ?? {
                        choices: [
                            {
                                message: {
                                    content: '{}',
                                },
                            },
                        ],
                    }
                );
            },
        },
    },
});

const makeConfig = () => ({
    enabled: true,
    openAiApiKey: 'test-key',
    openAiModel: 'gpt-5-nano',
    temperature: 1,
    onTransformError: 'warn',
});

test('transformPayees returns an empty object for no payees', async () => {
    const logger = makeLogger();
    let createCalls = 0;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeOpenAIStub({
            onCreate: () => {
                createCalls++;
            },
        })
    );

    const result = await transformer.transformPayees([], []);

    assert.deepEqual(result, {});
    assert.equal(createCalls, 0);
});

test('transformPayees skips OpenAI for local existing-payee matches', async () => {
    const logger = makeLogger();
    let createCalls = 0;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeOpenAIStub({
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
    let capturedOptions;
    const existingPayees = Array.from({ length: 150 }, (_, index) => {
        return `Alpha Market ${String(index + 1).padStart(3, '0')}`;
    });
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeOpenAIStub({
            response: {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                'Alpha Hyperstore': 'Alpha Market 001',
                            }),
                        },
                    },
                ],
            },
            onCreate: (options) => {
                capturedOptions = options;
            },
        })
    );

    const result = await transformer.transformPayees(
        ['Alpha Hyperstore'],
        existingPayees
    );

    assert.equal(capturedOptions.model, 'gpt-5-nano');
    assert.equal(capturedOptions.temperature, 1);
    assert.equal(capturedOptions.messages[1].content, 'Alpha Hyperstore');
    assert.match(
        capturedOptions.messages[0].content,
        /Showing 100 relevant existing payees out of 150\./
    );
    assert.equal(
        capturedOptions.messages[0].content
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
    let capturedOptions;
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeOpenAIStub({
            response: {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                'AMZN Mktp US*1234567890': 'Amazon.com',
                            }),
                        },
                    },
                ],
            },
            onCreate: (options) => {
                capturedOptions = options;
            },
        })
    );

    const result = await transformer.transformPayees(
        ['AMZN Mktp US*1234567890'],
        ['Amazon']
    );

    assert.equal(
        capturedOptions.messages[1].content,
        'AMZN Mktp US*1234567890'
    );
    assert.deepEqual(result, {
        'AMZN Mktp US*1234567890': 'Amazon',
    });
});

test('transformPayees returns null for malformed JSON', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeOpenAIStub({
            response: {
                choices: [
                    {
                        message: {
                            content: 'not-json',
                        },
                    },
                ],
            },
        })
    );

    const result = await transformer.transformPayees(['Coffee Shop'], []);

    assert.equal(result, null);
    assert.match(logger.errorMessages[0], /^Failed to parse JSON response:/);
    assert.match(logger.debugMessages[1][0], /Raw response: not-json/);
});

test('transformPayees returns null when OpenAI fails', async () => {
    const logger = makeLogger();
    const transformer = new PayeeTransformer(
        makeConfig(),
        logger,
        makeOpenAIStub({
            error: new Error('The model does not exist'),
        })
    );

    const result = await transformer.transformPayees(['Coffee Shop'], []);

    assert.equal(result, null);
    assert.equal(logger.errorMessages.length, 1);
    assert.match(
        logger.errorMessages[0],
        /OpenAI model 'gpt-5-nano' is unavailable/
    );
});
