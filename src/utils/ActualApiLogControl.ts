const API_NOISE_PATTERNS = [
    /^Syncing since /,
    /^Got messages from server /,
    /^\[Breadcrumb\]/,
];

// Keep this list small and explicit; these are the only known Actual log lines
// we want to suppress while preserving everything else.
const isApiNoiseLine = (line: string): boolean =>
    API_NOISE_PATTERNS.some((pattern) => pattern.test(line.trim()));

type ConsoleMethod = typeof console.log;
type StreamWrite = typeof process.stdout.write;
type StreamWriteArgs = Parameters<StreamWrite>;
type StreamWriteCallback = (err?: Error | null) => void;

// Only one top-level suppressing call should be active at a time.
// Nested calls within a single async chain are safe.
let globalApiNoiseFilterDepth = 0;

const getStreamWriteCallback = (args: StreamWriteArgs) =>
    args.find(
        (value): value is StreamWriteCallback => typeof value === 'function'
    );

export async function withApiLogControl<T>(
    verbose: boolean,
    callback: () => Promise<T> | T
): Promise<T> {
    if (verbose) {
        return await callback();
    }

    const originalConsoleLog = console.log;
    console.log = () => {};

    try {
        return await callback();
    } finally {
        console.log = originalConsoleLog;
    }
}

export async function withGlobalApiNoiseFilter<T>(
    suppress: boolean,
    callback: () => Promise<T> | T
): Promise<T> {
    if (!suppress) {
        return await callback();
    }

    const shouldPatchGlobals = globalApiNoiseFilterDepth === 0;
    globalApiNoiseFilterDepth++;

    if (!shouldPatchGlobals) {
        try {
            return await callback();
        } finally {
            globalApiNoiseFilterDepth--;
        }
    }

    const originalConsoleLog = console.log;
    const originalConsoleInfo = console.info;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write.bind(
        process.stdout
    ) as StreamWrite;
    const originalStderrWrite = process.stderr.write.bind(
        process.stderr
    ) as StreamWrite;

    const filterConsoleMethod =
        (method: ConsoleMethod): ConsoleMethod =>
        (...args: Parameters<ConsoleMethod>) => {
            const firstArg = args[0];
            if (typeof firstArg === 'string' && isApiNoiseLine(firstArg)) {
                return;
            }
            method(...args);
        };

    const filterWrite = (write: StreamWrite) => {
        let suppressNextStandaloneNewline = false;

        return ((...args: StreamWriteArgs) => {
            const chunk = args[0];
            const text =
                typeof chunk === 'string'
                    ? chunk
                    : Buffer.from(chunk).toString('utf8');

            if (suppressNextStandaloneNewline && /^\r?\n$/.test(text)) {
                suppressNextStandaloneNewline = false;
                const completionCallback = getStreamWriteCallback(args);
                completionCallback?.();
                return true;
            }

            if (isApiNoiseLine(text)) {
                // Actual sometimes emits the payload and the trailing newline as
                // separate writes. Keep the next standalone newline from leaking.
                suppressNextStandaloneNewline = true;
                const completionCallback = getStreamWriteCallback(args);
                completionCallback?.();
                return true;
            }

            suppressNextStandaloneNewline = false;
            return write(...args);
        }) as StreamWrite;
    };

    console.log = filterConsoleMethod(originalConsoleLog);
    console.info = filterConsoleMethod(originalConsoleInfo);
    console.warn = filterConsoleMethod(originalConsoleWarn);
    console.error = filterConsoleMethod(originalConsoleError);
    process.stdout.write = filterWrite(originalStdoutWrite);
    process.stderr.write = filterWrite(originalStderrWrite);

    try {
        return await callback();
    } finally {
        console.log = originalConsoleLog;
        console.info = originalConsoleInfo;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
        globalApiNoiseFilterDepth--;
    }
}
