const API_NOISE_PATTERNS = [
    /^Syncing since /,
    /^Got messages from server /,
    /^Loaded spreadsheet from cache /,
    /^\[Breadcrumb\]/,
];

const isApiNoiseLine = (line: string): boolean =>
    API_NOISE_PATTERNS.some((pattern) => pattern.test(line.trim()));

type ConsoleLog = typeof console.log;

// Module-level state ensures restore works correctly for overlapping calls.
let noiseFilterDepth = 0;
let savedConsoleLog: ConsoleLog | null = null;
let savedStdoutWrite: typeof process.stdout.write | null = null;

function ensurePatched() {
    if (noiseFilterDepth === 0) {
        savedConsoleLog = console.log;
        savedStdoutWrite = process.stdout.write;

        console.log = ((...args: Parameters<ConsoleLog>) => {
            const firstArg = args[0];
            if (typeof firstArg === 'string' && isApiNoiseLine(firstArg)) {
                return;
            }
            savedConsoleLog!(...args);
        }) as ConsoleLog;

        process.stdout.write = ((
            data: string | Uint8Array,
            encodingOrCb?: unknown,
            cb?: unknown
        ) => {
            // Resolve callback from both Node.js write variants:
            //   write(data, callback) and write(data, encoding, callback)
            let callback: ((error?: Error) => void) | undefined;
            if (typeof encodingOrCb === 'function') {
                callback = encodingOrCb as (error?: Error) => void;
            } else if (typeof cb === 'function') {
                callback = cb as (error?: Error) => void;
            }

            // Convert Buffer/Uint8Array chunks to string for matching
            const text =
                typeof data === 'string'
                    ? data
                    : Buffer.from(data).toString('utf-8');

            if (isApiNoiseLine(text)) {
                callback?.();
                return true;
            }

            return (
                savedStdoutWrite as unknown as (
                    data: string | Uint8Array,
                    ...rest: unknown[]
                ) => boolean
            ).call(process.stdout, data, encodingOrCb, cb) as boolean;
        }) as typeof process.stdout.write;
    }
    noiseFilterDepth++;
}

function ensureRestored() {
    noiseFilterDepth--;
    if (noiseFilterDepth === 0 && savedConsoleLog !== null) {
        console.log = savedConsoleLog;
        process.stdout.write = savedStdoutWrite!;
        savedConsoleLog = null;
        savedStdoutWrite = null;
    }
}

/**
 * Applies API-noise filtering to `console.log` and `process.stdout.write`
 * on the outermost call. Only the specific patterns (sync progress,
 * breadcrumbs) are suppressed; all other output passes through normally.
 *
 * @actual-app/api writes some progress messages directly to
 * process.stdout.write, so we must filter both channels.
 *
 * Nested and overlapping calls are safe — the patch uses module-level
 * depth tracking and restores globals whenever depth reaches zero.
 */
export async function withApiNoiseFilter<T>(
    callback: () => Promise<T> | T
): Promise<T> {
    ensurePatched();
    try {
        return await callback();
    } finally {
        ensureRestored();
    }
}
