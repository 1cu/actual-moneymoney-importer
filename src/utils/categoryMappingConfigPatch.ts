import toml from 'toml';

export const getBudgetBlocks = (
    content: string
): Array<{ start: number; end: number }> => {
    const startRegex = /^\[\[actualServers\.budgets\]\]\s*(#.*)?$/gm;
    const starts: number[] = [];

    for (const match of content.matchAll(startRegex)) {
        if (match.index !== undefined) {
            starts.push(match.index);
        }
    }

    const blocks: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        if (start === undefined) {
            continue;
        }
        const end =
            i + 1 < starts.length
                ? (starts[i + 1] ?? content.length)
                : content.length;
        blocks.push({ start, end });
    }

    return blocks;
};

export const replaceCategoryMappingInConfig = (
    content: string,
    syncId: string,
    mapping: Record<string, string>
): { ok: true; content: string } | { ok: false; reason: string } => {
    const budgetBlocks = getBudgetBlocks(content);
    const matchingBlocks = budgetBlocks.filter((block) => {
        const blockContent = content.slice(block.start, block.end);
        const syncIdMatch = blockContent.match(/(^|\n)syncId\s*=\s*"([^"]+)"/);
        return syncIdMatch?.[2] === syncId;
    });

    if (matchingBlocks.length !== 1) {
        return {
            ok: false,
            reason: `Expected exactly one budget block for syncId '${syncId}', found ${matchingBlocks.length}.`,
        };
    }

    const block = matchingBlocks[0];
    if (!block) {
        return {
            ok: false,
            reason: `Budget block for syncId '${syncId}' could not be resolved.`,
        };
    }

    const blockContent = content.slice(block.start, block.end);
    const mappingLines = [
        '[actualServers.budgets.categoryMapping]',
        ...Object.entries(mapping)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(
                ([source, target]) =>
                    `${JSON.stringify(source)} = ${JSON.stringify(target)}`
            ),
    ];

    const mappingSectionRegex =
        /(^|\n)\[actualServers\.budgets\.categoryMapping\]\n([\s\S]*?)(?=\n\[|$)/;

    let newBlockContent = blockContent;

    if (mappingSectionRegex.test(blockContent)) {
        newBlockContent = blockContent.replace(
            mappingSectionRegex,
            `\n${mappingLines.join('\n')}\n`
        );
    } else {
        const trimmedBlock = blockContent.trimEnd();
        newBlockContent = `${trimmedBlock}\n\n${mappingLines.join('\n')}\n`;
    }

    const updatedContent =
        content.slice(0, block.start) +
        newBlockContent +
        content.slice(block.end);

    try {
        toml.parse(updatedContent);
    } catch (error) {
        return {
            ok: false,
            reason:
                error instanceof Error
                    ? `TOML parse failed after patch: ${error.message}`
                    : 'TOML parse failed after patch.',
        };
    }

    return {
        ok: true,
        content: updatedContent,
    };
};
