/**
 * Apple Intelligence smoke test.
 *
 * Verifies that the tsfm-sdk optional dependency and the
 * AppleIntelligenceBackend integration work end-to-end.
 *
 * Gates:
 *   1. macOS + Apple Silicon (skips otherwise)
 *   2. tsfm-sdk installed (skips otherwise)
 *   3. Model availability failures skip with a diagnostic
 *
 * Known limitation: Apple doesn't document the on-device context window
 * size. Production payloads (> 100 payees) need empirical validation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Apple Intelligence: resolves Amazon payee from raw name', {
    timeout: 30_000,
}, async t => {
    // ---------- gates ----------
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        t.skip('Not Apple Silicon');
        return;
    }
    try {
        await import('tsfm-sdk');
    } catch {
        t.skip('tsfm-sdk not installed');
        return;
    }

    // ---------- backend ----------
    const { AppleIntelligenceBackend } = await import(
        '../../dist/utils/TransformationBackend.js'
    );

    const backend = new AppleIntelligenceBackend();
    t.after(() => backend.dispose());

    try {
        const result = await backend.transformPayees(
            'Return a JSON object mapping raw payee names to cleaned names. Example: {"AMZN Mktp US*1234567890": "Amazon"}',
            ['AMZN Mktp US*1234567890'],
            0
        );

        const cleanedName = result['AMZN Mktp US*1234567890'];
        assert.ok(
            typeof cleanedName === 'string' && cleanedName.length > 0,
            'Expected a non-empty cleaned payee name'
        );
        assert.match(
            cleanedName,
            /amazon/i,
            `Expected cleaned payee to contain "Amazon", got: "${cleanedName}"`
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof Error && backend.isModelUnavailableError(e)) {
            t.skip(`Apple Intelligence not available: ${msg}`);
            return;
        }
        throw e;
    }
});
