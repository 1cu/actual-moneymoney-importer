/**
 * Apple Intelligence smoke test.
 *
 * Verifies that the tsfm-sdk optional dependency and the
 * AppleIntelligenceBackend integration work end-to-end.
 *
 * Gates:
 *   1. macOS + Apple Silicon (skips otherwise)
 *   2. tsfm-sdk installed (skips otherwise)
 *   3. Model throw falls through to 'unavailable' skip
 *
 * Known limitation: Apple doesn't document the on-device context window
 * size. Production payloads (> 100 payees) need empirical validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test(
    'Apple Intelligence: resolves Amazon payee from raw name',
    { timeout: 30_000 },
    async (t) => {
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
        const { AppleIntelligenceBackend } =
            await import('../../dist/utils/TransformationBackend.js');

        const backend = new AppleIntelligenceBackend({
            enabled: true,
            backend: 'apple-intelligence',
            openAiApiKey: undefined,
            openAiModel: 'SystemLanguageModel',
            temperature: 1,
            onTransformError: 'warn',
        });
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
            if (
                msg.includes('unavailable') ||
                msg.includes('not installed') ||
                e?.constructor?.name === 'ModelNotReadyError'
            ) {
                t.skip(`Apple Intelligence not available: ${msg}`);
                return;
            }
            throw e;
        }
    }
);
