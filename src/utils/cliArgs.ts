export const toRefList = (
    value: string | string[] | undefined
): string[] | undefined => {
    if (!value) {
        return undefined;
    }

    const values = Array.isArray(value) ? value : [value];
    const refs = values
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return refs.length > 0 ? refs : undefined;
};

export const includesRef = (
    refs: string[] | undefined,
    value: string
): boolean => {
    if (!refs || refs.length === 0) {
        return true;
    }

    return refs.some((ref) => ref.toLowerCase() === value.toLowerCase());
};

/** Options shared across all commands (registered at top-level). */
export type CommonArgs = {
    config?: string;
    logLevel?: number;
    loglevel?: number;
};
