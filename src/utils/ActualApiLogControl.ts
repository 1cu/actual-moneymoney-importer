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
