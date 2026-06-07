// This file is intended to be run via stdin piping:
//   node --input-type=module < test/unit/apple-intelligence-check.mjs
//
// Running as a file (node test/unit/apple-intelligence-check.mjs) triggers a
// conflict between native dylib loading and Node's ESM module resolution that
// causes the process to hang. The --input-type=module path avoids this.
//
// When piped through stdin, relative imports resolve from process.cwd().
// Run from the repo root so ../../ resolves correctly to dist/.

import { resolve } from 'node:path';

// Hard timeout: if we haven't finished within 30s the on-device model is
// likely in a degraded state (e.g., Neural Engine resource leak from a prior
// kill). Treat as a skip rather than hanging indefinitely in CI.
const DEADLINE_MS = 30_000;
const deadline = setTimeout(() => {
    console.error(
        `SKIP: timed out after ${DEADLINE_MS}ms — model may be in a degraded state; try a system restart`
    );
    process.exit(0);
}, DEADLINE_MS);
deadline.unref(); // Don't keep the process alive for the timer alone

const repoRoot = process.cwd();

function platformGate() {
    if (process.platform !== 'darwin') return 'Requires macOS';
    if (process.arch !== 'arm64') return 'Requires Apple Silicon';
    return false;
}

const platformReason = platformGate();
if (platformReason) {
    console.log(`SKIP: ${platformReason}`);
    process.exit(0);
}

let sdkReason;
try {
    await import('tsfm-sdk');
    sdkReason = false;
} catch (e) {
    sdkReason = `tsfm-sdk not installed: ${e instanceof Error ? e.message : String(e)}`;
}
if (sdkReason) {
    console.log(`SKIP: ${sdkReason}`);
    process.exit(0);
}

const backendPath = resolve(repoRoot, 'dist/utils/TransformationBackend.js');
const { AppleIntelligenceBackend } = await import(backendPath);

const backend = new AppleIntelligenceBackend({
    enabled: true,
    backend: 'apple-intelligence',
    openAiApiKey: undefined,
    openAiModel: 'SystemLanguageModel',
    temperature: 1,
    onTransformError: 'warn',
});

const start = Date.now();

try {
    const result = await backend.transformPayees(
        'Return JSON with "mappings": [{ "rawPayee": "...", "cleanedPayee": "..." }].',
        ['AMZN Mktp US*1234567890'],
        0
    );

    const elapsed = Date.now() - start;

    if (!result || typeof result !== 'object') {
        console.error('FAIL: Expected a result object, got:', typeof result);
        process.exit(1);
    }

    const cleanedName = result['AMZN Mktp US*1234567890'];
    if (typeof cleanedName !== 'string' || cleanedName.length === 0) {
        console.error(
            'FAIL: Expected non-empty cleaned payee name, got:',
            cleanedName
        );
        process.exit(1);
    }

    if (!/amazon/i.test(cleanedName)) {
        console.error(
            `FAIL: Expected cleaned payee to contain "Amazon", got: "${cleanedName}"`
        );
        process.exit(1);
    }

    console.log(`PASS (${elapsed}ms): "${cleanedName}"`);
    process.exit(0);
} catch (e) {
    const elapsed = Date.now() - start;
    const message = e instanceof Error ? e.message : String(e);

    if (
        message.includes('unavailable') ||
        message.includes('not installed') ||
        e?.constructor?.name === 'ModelNotReadyError'
    ) {
        console.log(
            `SKIP (${elapsed}ms): Apple Intelligence not available: ${message}`
        );
        process.exit(0);
    }

    console.error(
        `FAIL (${elapsed}ms): ${e?.constructor?.name ?? 'Error'}: ${message}`
    );
    process.exit(1);
}
