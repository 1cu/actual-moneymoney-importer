import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Importer from '../../dist/utils/Importer.js';

const makeLogger = () => ({
    debugMessages: [],
    infoMessages: [],
    warnMessages: [],
    errorMessages: [],
    debug(message) {
        this.debugMessages.push(message);
    },
    info(message) {
        this.infoMessages.push(message);
    },
    warn(message) {
        this.warnMessages.push(message);
    },
    error(message) {
        this.errorMessages.push(message);
    },
});

const makeMonMonAccount = ({ uuid, name, accountNumber }) => ({
    uuid,
    name,
    accountNumber,
    balance: [[0]],
});

const makeActualAccount = ({ id, name }) => ({
    id,
    name,
    type: 'checking',
    offbudget: false,
});

const makeFullAccountMapping = (entries) => new Map(entries);

const makeTransaction = ({
    id,
    accountUuid,
    amount,
    categoryUuid = 'mm-transfer',
    accountNumber,
    valueDate = '2026-04-21',
    booked = true,
    name = 'Txn',
    purpose = 'Purpose',
    comment,
}) => ({
    id,
    accountUuid,
    amount,
    categoryUuid,
    accountNumber,
    valueDate: new Date(valueDate),
    bookingDate: new Date(valueDate),
    booked,
    name,
    purpose,
    comment,
});

const makeImporter = ({
    synchronizeClearedStatus = true,
    importComments = true,
    resolvedTransferCategoryUuids = new Set(['mm-transfer']),
    invalidTransferRefs = [],
    getTransactions = async () => [],
    getTransactionsByIds = async () => [],
    updateTransaction = async () => {},
    logger = makeLogger(),
} = {}) => {
    const actualApi = {
        getTransactions,
        getTransactionsByIds,
        updateTransaction,
    };
    const categoryMap = {
        resolveMoneyMoneyCategoryRefs: () => ({
            resolvedUuids: resolvedTransferCategoryUuids,
            invalidRefs: invalidTransferRefs,
        }),
        getActualCategoryPath: (categoryId) => categoryId,
    };
    const config = {
        import: {
            synchronizeClearedStatus,
            synchronizeCategories: false,
            categorySyncOnExisting: 'new',
            importComments,
            commentPrefix: 'Comment: ',
            transfers: {
                enabled: true,
                categoryRefs: ['Transfer'],
            },
        },
        payeeTransformation: {
            enabled: false,
        },
    };

    return new Importer(
        config,
        {},
        actualApi,
        logger,
        { getMap: () => new Map() },
        categoryMap
    );
};

test('buildTransferPlan does not seed delayed transfer when counterpart date is unknown', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        name: 'Example Sender',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
});

test('buildTransferPlan skips automatic transfer when mapped account numbers are ambiguous', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMonA = makeMonMonAccount({
        uuid: 'mm-target-a',
        name: 'Target A',
        accountNumber: 'DE-TARGET',
    });
    const targetMonMonB = makeMonMonAccount({
        uuid: 'mm-target-b',
        name: 'Target B',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActualA = makeActualAccount({
        id: 'actual-target-a',
        name: 'B',
    });
    const targetActualB = makeActualAccount({
        id: 'actual-target-b',
        name: 'C',
    });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: 'DE-TARGET',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMonA, targetActualA],
            [targetMonMonB, targetActualB],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMonA.uuid]: [],
            [targetMonMonB.uuid]: [],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActualA.id, []],
            [targetActualB.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActualA.id, 'payee-a'],
            [targetActualB.id, 'payee-b'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
});

test('buildTransferPlan suppresses unique same-run counterpart and carries metadata', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        name: 'Example Sender',
        purpose: 'Ruecklagen',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        name: 'Einzahlung',
        purpose: 'Ruecklagen',
        comment: 'memo',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [targetTx],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    const counterpart =
        plan.seedByImportedId.get('mm-source-100')?.sameRunCounterpart;
    assert.equal(plan.seedByImportedId.size, 1);
    assert.deepEqual([...plan.suppressedImportedIds], ['mm-target-200']);
    assert.equal(counterpart?.importedPayee, 'Einzahlung');
    assert.equal(counterpart?.notes, 'Ruecklagen | Comment: memo');
    assert.equal(counterpart?.cleared, true);
});

test('buildTransferPlan prefers the exact same-date same-run counterpart over nearby distractors', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        valueDate: '2026-04-21',
        purpose: 'Ruecklagen',
    });
    const exactTargetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        valueDate: '2026-04-21',
        purpose: 'Ruecklagen',
    });
    const distractorTx = makeTransaction({
        id: '201',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        valueDate: '2026-04-24',
        purpose: 'Something else',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [exactTargetTx, distractorTx],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [exactTargetTx, distractorTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    const counterpart =
        plan.seedByImportedId.get('mm-source-100')?.sameRunCounterpart;
    assert.equal(plan.seedByImportedId.size, 1);
    assert.deepEqual([...plan.suppressedImportedIds], ['mm-target-200']);
    assert.equal(counterpart?.importedId, 'mm-target-200');
});

test('buildTransferPlan suppresses same-run counterpart when source has hard target signal, even with different purpose', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Salary bonus',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [targetTx],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 1);
    assert.equal(
        plan.seedByImportedId.get('mm-source-100')?.sameRunCounterpart
            ?.importedId,
        'mm-target-200'
    );
    assert.deepEqual([...plan.suppressedImportedIds], ['mm-target-200']);
});

test('buildTransferPlan rejects unrelated same-run transactions without a positive signal', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        purpose: undefined,
        accountNumber: undefined,
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: undefined,
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.deepEqual([...plan.suppressedImportedIds], []);
});

test('buildTransferPlan skips same-run transfer when source and counterpart have different dates', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        valueDate: '2026-04-21',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        valueDate: '2026-04-24',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.deepEqual([...plan.suppressedImportedIds], []);
});

test('buildTransferPlan skips historical conversion when source and counterpart have different dates', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Ruecklagen',
        valueDate: '2026-04-24',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
            [sourceActual.id, 'payee-source'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 0);
});

test('buildTransferPlan skips ambiguous same-run counterpart matches', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
    });
    const targetTxA = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
    });
    const targetTxB = makeTransaction({
        id: '201',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [targetTxA, targetTxB],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTxA, targetTxB],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.deepEqual([...plan.suppressedImportedIds], []);
});

test('buildTransferPlan plans conversion when counterpart already exists as plain transaction', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = {
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        categoryUuid: 'mm-transfer',
        valueDate: new Date('2026-04-21'),
        bookingDate: new Date('2026-04-21'),
        booked: true,
        name: 'Txn',
        purpose: 'Ruecklagen',
    };
    const targetTx = {
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        valueDate: new Date('2026-04-21'),
        bookingDate: new Date('2026-04-21'),
        booked: true,
        name: 'Txn',
        purpose: 'Ruecklagen',
    };

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
            [sourceActual.id, 'payee-source'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.deepEqual([...plan.suppressedImportedIds], ['mm-source-100']);
    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 1);
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.get('mm-source-100')
            ?.existingCounterpartTransactionId,
        'actual-counterpart'
    );
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.get('mm-source-100')
            ?.sourceTransferPayeeId,
        'payee-source'
    );
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.get('mm-source-100')
            ?.sourceImportedId,
        'mm-source-100'
    );
});

test('buildTransferPlan prefers the exact same-date historical counterpart over nearby distractors', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const exactTargetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const distractorTx = makeTransaction({
        id: '201',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Ruecklagen',
        valueDate: '2026-04-24',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [exactTargetTx, distractorTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
            [sourceActual.id, 'payee-source'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 1);
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.get('mm-source-100')
            ?.existingCounterpartTransactionId,
        'actual-counterpart'
    );
});

test('buildTransferPlan claims a historical counterpart only once', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTxA = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const sourceTxB = makeTransaction({
        id: '101',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTxA, sourceTxB],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTxA, sourceTxB],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
            [sourceActual.id, 'payee-source'],
        ]),
    });

    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 1);
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.has('mm-source-100'),
        true
    );
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.has('mm-source-101'),
        false
    );
});

test('buildTransferPlan skips historical conversion when the counterpart is already part of a transfer', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [
                sourceActual.id,
                [
                    {
                        id: 'auto-created-counterpart',
                        imported_id: 'mm-source-100',
                        transfer_id: 'actual-counterpart',
                    },
                ],
            ],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
            [sourceActual.id, 'payee-source'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 0);
});

test('buildTransferPlan does not let a missing transfer payee claim the historical counterpart', () => {
    const importer = makeImporter();
    const sourceMonMonA = makeMonMonAccount({
        uuid: 'mm-source-a',
        name: 'Source A',
        accountNumber: 'DE-SOURCE-A',
    });
    const sourceMonMonB = makeMonMonAccount({
        uuid: 'mm-source-b',
        name: 'Source B',
        accountNumber: 'DE-SOURCE-B',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActualA = makeActualAccount({
        id: 'actual-source-a',
        name: 'A',
    });
    const sourceActualB = makeActualAccount({
        id: 'actual-source-b',
        name: 'B',
    });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTxA = makeTransaction({
        id: '100',
        accountUuid: sourceMonMonA.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const sourceTxB = makeTransaction({
        id: '101',
        accountUuid: sourceMonMonB.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Ruecklagen',
        valueDate: '2026-04-21',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMonA, sourceActualA],
            [sourceMonMonB, sourceActualB],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMonA,
                actualAccount: sourceActualA,
                newMonMonTransactions: [sourceTxA],
            },
            {
                monMonAccount: sourceMonMonB,
                actualAccount: sourceActualB,
                newMonMonTransactions: [sourceTxB],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMonA.uuid]: [sourceTxA],
            [sourceMonMonB.uuid]: [sourceTxB],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActualA.id, []],
            [sourceActualB.id, []],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
            [sourceActualB.id, 'payee-source-b'],
        ]),
    });

    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 1);
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.has('mm-source-a-100'),
        false
    );
    assert.equal(
        plan.existingCounterpartConversionsByImportedId.has('mm-source-b-101'),
        true
    );
});

test('buildTransferPlan skips conversion when source lacks transfer payee', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [sourceTx],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [targetTx],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [
                targetActual.id,
                [{ id: 'actual-counterpart', imported_id: 'mm-target-200' }],
            ],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.equal(plan.existingCounterpartConversionsByImportedId.size, 0);
});

test('applyExistingCounterpartConversions converts plain counterpart and stamps auto-created source counterpart', async () => {
    const getTransactions = mock.fn(async () => [
        {
            id: 'auto-created-counterpart',
            transfer_id: 'source-counterpart-transfer',
        },
        {
            id: 'actual-counterpart',
            transfer_id: 'auto-created-counterpart',
        },
    ]);
    const getTransactionsByIds = mock.fn(async () => [
        {
            id: 'actual-counterpart',
            transfer_id: 'auto-created-counterpart',
        },
    ]);
    const updateTransaction = mock.fn(async () => {});
    const importer = makeImporter({
        getTransactions,
        getTransactionsByIds,
        updateTransaction,
    });

    await importer.applyExistingCounterpartConversions({
        newMonMonTransactions: [
            makeTransaction({
                id: '100',
                accountUuid: 'mm-source',
                amount: -1440,
                accountNumber: 'DE-TARGET',
                name: 'Example Sender',
                purpose: 'Ruecklagen',
            }),
        ],

        transferPlan: {
            seedByImportedId: new Map(),
            suppressedImportedIds: new Set(),
            resolvedTransferCategoryUuids: new Set(),
            existingCounterpartConversionsByImportedId: new Map([
                [
                    'mm-source-100',
                    {
                        existingCounterpartTransactionId: 'actual-counterpart',
                        existingCounterpartAccountId: 'actual-target',
                        existingCounterpartAccountName: 'Target',
                        sourceActualAccountName: 'Source',
                        sourceTransferPayeeId: 'payee-source',
                        sourceImportedId: 'mm-source-100',
                        sourceImportedPayee: 'Example Sender',
                        sourceNotes: 'Ruecklagen',
                        sourceCleared: true,
                    },
                ],
            ]),
        },
    });

    assert.equal(updateTransaction.mock.callCount(), 2);
    assert.deepEqual(updateTransaction.mock.calls[0].arguments, [
        'actual-counterpart',
        { payee: 'payee-source' },
    ]);
    assert.deepEqual(updateTransaction.mock.calls[1].arguments, [
        'auto-created-counterpart',
        {
            imported_id: 'mm-source-100',
            imported_payee: 'Example Sender',
            date: '2026-04-21',
            notes: 'Ruecklagen',
            cleared: true,
        },
    ]);
});

test('applyExistingCounterpartConversions throws when the conversion payee update fails', async () => {
    const updateTransaction = mock.fn(async () => {
        throw new Error('boom');
    });
    const importer = makeImporter({ updateTransaction });

    await assert.rejects(
        () =>
            importer.applyExistingCounterpartConversions({
                newMonMonTransactions: [
                    makeTransaction({
                        id: '100',
                        accountUuid: 'mm-source',
                        amount: -1440,
                        accountNumber: 'DE-TARGET',
                        name: 'Example Sender',
                        purpose: 'Ruecklagen',
                    }),
                ],
                transferPlan: {
                    seedByImportedId: new Map(),
                    suppressedImportedIds: new Set(),
                    resolvedTransferCategoryUuids: new Set(),
                    existingCounterpartConversionsByImportedId: new Map([
                        [
                            'mm-source-100',
                            {
                                existingCounterpartTransactionId:
                                    'actual-counterpart',
                                existingCounterpartAccountId: 'actual-target',
                                existingCounterpartAccountName: 'Target',
                                sourceActualAccountName: 'Source',
                                sourceTransferPayeeId: 'payee-source',
                                sourceImportedId: 'mm-source-100',
                                sourceImportedPayee: 'Example Sender',
                            },
                        ],
                    ]),
                },
            }),
        /Failed to convert plain transaction/
    );
    assert.equal(updateTransaction.mock.callCount(), 1);
});

test('applyExistingCounterpartConversions throws when the auto-created counterpart cannot be located', async () => {
    const updateTransaction = mock.fn(async () => {});
    const getTransactionsByIds = mock.fn(async () => []);
    const logger = makeLogger();
    const importer = makeImporter({
        updateTransaction,
        getTransactionsByIds,
        logger,
    });

    await assert.rejects(
        () =>
            importer.applyExistingCounterpartConversions({
                newMonMonTransactions: [
                    makeTransaction({
                        id: '100',
                        accountUuid: 'mm-source',
                        amount: -1440,
                        accountNumber: 'DE-TARGET',
                        name: 'Example Sender',
                        purpose: 'Ruecklagen',
                    }),
                ],
                transferPlan: {
                    seedByImportedId: new Map(),
                    suppressedImportedIds: new Set(),
                    resolvedTransferCategoryUuids: new Set(),
                    existingCounterpartConversionsByImportedId: new Map([
                        [
                            'mm-source-100',
                            {
                                existingCounterpartTransactionId:
                                    'actual-counterpart',
                                existingCounterpartAccountId: 'actual-target',
                                existingCounterpartAccountName: 'Target',
                                sourceActualAccountName: 'Source',
                                sourceTransferPayeeId: 'payee-source',
                                sourceImportedId: 'mm-source-100',
                                sourceImportedPayee: 'Example Sender',
                            },
                        ],
                    ]),
                },
            }),
        /Could not locate auto-created transfer counterpart/
    );
    assert.equal(updateTransaction.mock.callCount(), 1);
    assert.ok(
        getTransactionsByIds.mock.callCount() >= 5,
        'expected retry attempts when the counterpart is initially missing'
    );
    assert.ok(
        logger.debugMessages.some(
            (message) =>
                message.includes('actual-counterpart') &&
                message.includes('actual-target') &&
                message.includes('attempt 5/5')
        ),
        'expected retry diagnostics to include the missing counterpart details'
    );
});

test('applyExistingCounterpartConversions stops retrying on auth failures', async () => {
    const updateTransaction = mock.fn(async () => {});
    const authError = Object.assign(new Error('forbidden'), { status: 403 });
    const getTransactionsByIds = mock.fn(async () => {
        throw authError;
    });
    const logger = makeLogger();
    const importer = makeImporter({
        updateTransaction,
        getTransactionsByIds,
        logger,
    });

    await assert.rejects(
        () =>
            importer.applyExistingCounterpartConversions({
                newMonMonTransactions: [
                    makeTransaction({
                        id: '100',
                        accountUuid: 'mm-source',
                        amount: -1440,
                        accountNumber: 'DE-TARGET',
                        name: 'Example Sender',
                        purpose: 'Ruecklagen',
                    }),
                ],
                transferPlan: {
                    seedByImportedId: new Map(),
                    suppressedImportedIds: new Set(),
                    resolvedTransferCategoryUuids: new Set(),
                    existingCounterpartConversionsByImportedId: new Map([
                        [
                            'mm-source-100',
                            {
                                existingCounterpartTransactionId:
                                    'actual-counterpart',
                                existingCounterpartAccountId: 'actual-target',
                                existingCounterpartAccountName: 'Target',
                                sourceActualAccountName: 'Source',
                                sourceTransferPayeeId: 'payee-source',
                                sourceImportedId: 'mm-source-100',
                                sourceImportedPayee: 'Example Sender',
                            },
                        ],
                    ]),
                },
            }),
        /forbidden/
    );

    assert.equal(updateTransaction.mock.callCount(), 1);
    assert.equal(getTransactionsByIds.mock.callCount(), 1);
});

test('applyExistingCounterpartConversions throws when stamping the auto-created counterpart fails', async () => {
    const updateTransaction = mock.fn(async (transactionId) => {
        if (transactionId === 'auto-created-counterpart') {
            throw new Error('stamp failed');
        }
    });
    const getTransactionsByIds = mock.fn(async () => [
        {
            id: 'auto-created-counterpart',
            transfer_id: 'auto-created-counterpart',
        },
    ]);
    const importer = makeImporter({ updateTransaction, getTransactionsByIds });

    await assert.rejects(
        () =>
            importer.applyExistingCounterpartConversions({
                newMonMonTransactions: [
                    makeTransaction({
                        id: '100',
                        accountUuid: 'mm-source',
                        amount: -1440,
                        accountNumber: 'DE-TARGET',
                        name: 'Example Sender',
                        purpose: 'Ruecklagen',
                    }),
                ],
                transferPlan: {
                    seedByImportedId: new Map(),
                    suppressedImportedIds: new Set(),
                    resolvedTransferCategoryUuids: new Set(),
                    existingCounterpartConversionsByImportedId: new Map([
                        [
                            'mm-source-100',
                            {
                                existingCounterpartTransactionId:
                                    'actual-counterpart',
                                existingCounterpartAccountId: 'actual-target',
                                existingCounterpartAccountName: 'Target',
                                sourceActualAccountName: 'Source',
                                sourceTransferPayeeId: 'payee-source',
                                sourceImportedId: 'mm-source-100',
                                sourceImportedPayee: 'Example Sender',
                            },
                        ],
                    ]),
                },
            }),
        /Failed to stamp auto-created transfer counterpart/
    );
    assert.equal(updateTransaction.mock.callCount(), 2);
    assert.equal(getTransactionsByIds.mock.callCount(), 1);
});

test('buildTransferPlan does not suppress delayed counterpart when source side is no longer new', () => {
    const importer = makeImporter();
    const sourceMonMon = makeMonMonAccount({
        uuid: 'mm-source',
        name: 'Source',
        accountNumber: 'DE-SOURCE',
    });
    const targetMonMon = makeMonMonAccount({
        uuid: 'mm-target',
        name: 'Target',
        accountNumber: 'DE-TARGET',
    });
    const sourceActual = makeActualAccount({ id: 'actual-source', name: 'A' });
    const targetActual = makeActualAccount({ id: 'actual-target', name: 'B' });
    const sourceTx = makeTransaction({
        id: '100',
        accountUuid: sourceMonMon.uuid,
        amount: -1440,
        accountNumber: targetMonMon.accountNumber,
        purpose: 'Ruecklagen',
    });
    const targetTx = makeTransaction({
        id: '200',
        accountUuid: targetMonMon.uuid,
        amount: 1440,
        categoryUuid: 'mm-uncategorized',
        purpose: 'Ruecklagen',
    });

    const plan = importer.buildTransferPlan({
        fullAccountMapping: makeFullAccountMapping([
            [sourceMonMon, sourceActual],
            [targetMonMon, targetActual],
        ]),
        accountStates: [
            {
                monMonAccount: sourceMonMon,
                actualAccount: sourceActual,
                newMonMonTransactions: [],
            },
            {
                monMonAccount: targetMonMon,
                actualAccount: targetActual,
                newMonMonTransactions: [targetTx],
            },
        ],
        monMonTransactionMap: {
            [sourceMonMon.uuid]: [sourceTx],
            [targetMonMon.uuid]: [targetTx],
        },
        existingActualTransactionsByAccountId: new Map([
            [sourceActual.id, []],
            [targetActual.id, []],
        ]),
        transferPayeeIdByAccountId: new Map([
            [targetActual.id, 'payee-target'],
        ]),
    });

    assert.equal(plan.seedByImportedId.size, 0);
    assert.deepEqual([...plan.suppressedImportedIds], []);
});

test('getExistingTransactionsForStartBalanceCheck refreshes empty accounts for live transfer runs', async () => {
    const getTransactions = mock.fn(async () => [
        {
            id: 'generated-counterpart',
            imported_id: undefined,
            transfer_id: 'source-transfer',
        },
    ]);
    const importer = makeImporter({ getTransactions });
    const getExistingTransactionsForStartBalanceCheck =
        Object.getPrototypeOf(
            importer
        ).getExistingTransactionsForStartBalanceCheck;

    const refreshed = await getExistingTransactionsForStartBalanceCheck.call(
        importer,
        {
            actualAccountId: 'actual-target',
            existingActualTransactions: [],
            transfersEnabled: true,
            isDryRun: false,
        }
    );

    assert.equal(getTransactions.mock.callCount(), 1);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.id, 'generated-counterpart');
});

test('getExistingTransactionsForStartBalanceCheck does not refetch non-empty or dry-run accounts', async () => {
    const getTransactions = mock.fn(async () => [
        {
            id: 'should-not-be-used',
        },
    ]);
    const importer = makeImporter({ getTransactions });
    const getExistingTransactionsForStartBalanceCheck =
        Object.getPrototypeOf(
            importer
        ).getExistingTransactionsForStartBalanceCheck;

    const existing = [{ id: 'existing-1' }];

    assert.deepEqual(
        await getExistingTransactionsForStartBalanceCheck.call(importer, {
            actualAccountId: 'actual-target',
            existingActualTransactions: existing,
            transfersEnabled: true,
            isDryRun: false,
        }),
        existing
    );
    assert.deepEqual(
        await getExistingTransactionsForStartBalanceCheck.call(importer, {
            actualAccountId: 'actual-target',
            existingActualTransactions: [],
            transfersEnabled: true,
            isDryRun: true,
        }),
        []
    );
    assert.deepEqual(
        await getExistingTransactionsForStartBalanceCheck.call(importer, {
            actualAccountId: 'actual-target',
            existingActualTransactions: [],
            transfersEnabled: false,
            isDryRun: false,
        }),
        []
    );

    assert.equal(getTransactions.mock.callCount(), 0);
});

test('convertToActualTransaction uses transfer payee for planned seed', async () => {
    const importer = makeImporter();
    const transaction = makeTransaction({
        id: '100',
        accountUuid: 'mm-source',
        amount: -1440,
        accountNumber: 'DE-TARGET',
        name: 'Example Sender',
        purpose: 'Ruecklagen',
        comment: 'memo',
    });

    const converted = await importer.convertToActualTransaction(transaction, {
        importedId: 'mm-source-100',
        transferPayeeId: 'transfer-payee',
        targetActualAccountId: 'actual-target',
        targetActualAccountName: 'Target',
    });

    assert.equal(converted.payee, 'transfer-payee');
    assert.equal(converted.imported_id, 'mm-source-100');
    assert.equal(converted.imported_payee, 'Example Sender');
    assert.equal(converted.notes, 'Ruecklagen | Comment: memo');
    assert.equal(converted.cleared, true);
});

test('applyTransferCounterpartUpdates stamps generated counterpart with second imported id', async () => {
    const updateTransaction = mock.fn(async () => {});
    const importer = makeImporter({
        updateTransaction,
    });

    await importer.applyTransferCounterpartUpdates({
        actualAccountName: 'Source',
        importedTransactions: [
            {
                id: 'source-tx',
                imported_id: 'mm-source-100',
                transfer_id: 'counterpart-tx',
            },
        ],
        transferPlan: {
            seedByImportedId: new Map([
                [
                    'mm-source-100',
                    {
                        importedId: 'mm-source-100',
                        transferPayeeId: 'payee-target',
                        targetActualAccountId: 'actual-target',
                        targetActualAccountName: 'Target',
                        sameRunCounterpart: {
                            importedId: 'mm-target-200',
                            importedPayee: 'Einzahlung',
                            notes: 'Ruecklagen',
                            cleared: true,
                        },
                    },
                ],
            ]),
            suppressedImportedIds: new Set(['mm-target-200']),
        },
    });

    assert.equal(updateTransaction.mock.callCount(), 1);
    assert.deepEqual(updateTransaction.mock.calls[0].arguments, [
        'counterpart-tx',
        {
            imported_id: 'mm-target-200',
            imported_payee: 'Einzahlung',
            notes: 'Ruecklagen',
            cleared: true,
        },
    ]);
});
