const API_NOISE_PATTERNS = [
    /^Syncing since /,
    /^Got messages from server /,
    /^Loaded spreadsheet from cache /,
    /^\[Breadcrumb\]/,
];

const isApiNoiseLine = (line: string): boolean =>
    API_NOISE_PATTERNS.some((pattern) => pattern.test(line.trim()));

type ConsoleLog = typeof console.log;

// Depth tracking prevents premature restore when nested async calls overlap.
let noiseFilterDepth = 0;

/**
 * Applies API-noise filtering to `console.log` and `process.stdout.write`
 * on the outermost call. Only the specific patterns (sync progress,
 * breadcrumbs) are suppressed; all other output passes through normally.
 *
 * @actual-app/api writes some progress messages directly to
 * process.stdout.write, so we must filter both channels.
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

    const originalConsoleLog = console.log;
    const originalStdoutWrite = process.stdout.write;

    console.log = ((...args: Parameters<ConsoleLog>) => {
        const firstArg = args[0];
        if (typeof firstArg === 'string' && isApiNoiseLine(firstArg)) {
            return;
        }
        originalConsoleLog(...args);
    }) as ConsoleLog;

    process.stdout.write = ((data: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof data === 'string' && isApiNoiseLine(data)) {
            return true;
        }
        return (
            originalStdoutWrite as unknown as (
                data: string | Uint8Array,
                ...rest: unknown[]
            ) => boolean
        ).call(process.stdout, data, ...rest) as boolean;
    }) as typeof process.stdout.write;

    try {
        return await callback();
    } finally {
        noiseFilterDepth--;
        if (noiseFilterDepth === 0) {
            console.log = originalConsoleLog;
            process.stdout.write = originalStdoutWrite;
        }
    }
}
