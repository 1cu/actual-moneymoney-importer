const API_NOISE_PATTERNS = [/^Syncing since /, /^Got messages from server /];

const isApiNoiseLine = (line: string): boolean =>
    API_NOISE_PATTERNS.some((pattern) => pattern.test(line.trim()));

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

    const originalConsoleLog = console.log;
    const originalConsoleInfo = console.info;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let suppressNextStandaloneNewline = false;

    const filterConsoleMethod =
        (method: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
            const firstArg = args[0];
            if (typeof firstArg === 'string' && isApiNoiseLine(firstArg)) {
                return;
            }
            method(...args);
        };

    const filterWrite =
        (write: (...args: StreamWriteArg[]) => boolean) =>
        (...args: StreamWriteArg[]) => {
            const chunk = args[0] as string | Uint8Array;
            const text =
                typeof chunk === 'string'
                    ? chunk
                    : Buffer.from(chunk).toString('utf8');

            if (suppressNextStandaloneNewline && /^\r?\n$/.test(text)) {
                suppressNextStandaloneNewline = false;
                const completionCallback = args.find(
                    (value): value is (err?: Error | null) => void =>
                        typeof value === 'function'
                );
                completionCallback?.();
                return true;
            }

            if (isApiNoiseLine(text)) {
                suppressNextStandaloneNewline = true;
                const completionCallback = args.find(
                    (value): value is (err?: Error | null) => void =>
                        typeof value === 'function'
                );
                completionCallback?.();
                return true;
            }

            suppressNextStandaloneNewline = false;
            return write(...args);
        };

    console.log = filterConsoleMethod(
        originalConsoleLog as unknown as (...args: unknown[]) => void
    );
    console.info = filterConsoleMethod(
        originalConsoleInfo as unknown as (...args: unknown[]) => void
    );
    console.warn = filterConsoleMethod(
        originalConsoleWarn as unknown as (...args: unknown[]) => void
    );
    console.error = filterConsoleMethod(
        originalConsoleError as unknown as (...args: unknown[]) => void
    );
    process.stdout.write = filterWrite(
        originalStdoutWrite as unknown as (...args: StreamWriteArg[]) => boolean
    ) as unknown as typeof process.stdout.write;
    process.stderr.write = filterWrite(
        originalStderrWrite as unknown as (...args: StreamWriteArg[]) => boolean
    ) as unknown as typeof process.stderr.write;

    try {
        return await callback();
    } finally {
        console.log = originalConsoleLog;
        console.info = originalConsoleInfo;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
    }
}
type StreamWriteCallback = (err?: Error | null) => void;
type StreamWriteArg =
    | string
    | Uint8Array
    | BufferEncoding
    | StreamWriteCallback;
