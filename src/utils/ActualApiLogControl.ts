const API_NOISE_PATTERNS = [
    /^Syncing since /,
    /^Got messages from server /,
    /^\[Breadcrumb\]/,
];

const isApiNoiseLine = (line: string): boolean =>
    API_NOISE_PATTERNS.some((pattern) => pattern.test(line.trim()));

type ConsoleLog = typeof console.log;

// Depth tracking prevents premature restore when nested async calls overlap.
let noiseFilterDepth = 0;

/**
 * Applies API-noise filtering to `console.log` on the outermost call.
 * Only the specific patterns (sync progress, breadcrumbs) are suppressed;
 * all other `console.log` output passes through normally.
 *
 * Nested calls are safe — only the outermost call patches and restores.
 */
export async function withApiNoiseFilter<T>(
    callback: () => Promise<T> | T
): Promise<T> {
    const isOutermost = noiseFilterDepth === 0;
    noiseFilterDepth++;

    if (!isOutermost) {
        try {
            return await callback();
        } finally {
            noiseFilterDepth--;
        }
    }

    const originalLog = console.log;
    console.log = ((...args: Parameters<ConsoleLog>) => {
        const firstArg = args[0];
        if (typeof firstArg === 'string' && isApiNoiseLine(firstArg)) {
            return;
        }
        originalLog(...args);
    }) as ConsoleLog;

    try {
        return await callback();
    } finally {
        console.log = originalLog;
        noiseFilterDepth--;
    }
}
