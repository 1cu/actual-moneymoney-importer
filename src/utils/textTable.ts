import stringWidth from 'string-width';

type Alignment = 'left' | 'right';

type TableColumnConfig = {
    width: number;
    alignment: Alignment;
    paddingLeft?: number;
    paddingRight?: number;
    truncatePriority?: number;
};

type TableConfig = {
    columns: TableColumnConfig[];
    maxWidth?: number;
};

type BorderCharacters = {
    topLeft: string;
    topJoin: string;
    topRight: string;
    topBody: string;
    joinLeft: string;
    joinJoin: string;
    joinRight: string;
    joinBody: string;
    bottomLeft: string;
    bottomJoin: string;
    bottomRight: string;
    bottomBody: string;
    bodyLeft: string;
    bodyJoin: string;
    bodyRight: string;
};

const TABLE_BORDER: BorderCharacters = {
    topLeft: '╔',
    topJoin: '╦',
    topRight: '╗',
    topBody: '═',
    joinLeft: '╟',
    joinJoin: '┼',
    joinRight: '╢',
    joinBody: '─',
    bottomLeft: '╚',
    bottomJoin: '╩',
    bottomRight: '╝',
    bottomBody: '═',
    bodyLeft: '║',
    bodyJoin: '│',
    bodyRight: '║',
};

const ELLIPSIS = '…';

const truncateToWidth = (value: string, width: number) => {
    if (width <= 0) {
        return '';
    }

    if (stringWidth(value) <= width) {
        return value;
    }

    if (width === 1) {
        return ELLIPSIS;
    }

    let currentWidth = 0;
    let output = '';
    const maxContentWidth = width - stringWidth(ELLIPSIS);

    for (const character of [...value]) {
        const characterWidth = stringWidth(character);
        if (currentWidth + characterWidth > maxContentWidth) {
            break;
        }

        output += character;
        currentWidth += characterWidth;
    }

    return `${output}${ELLIPSIS}`;
};

const alignCell = (value: string, width: number, alignment: Alignment) => {
    const clipped = truncateToWidth(value, width);
    const clippedWidth = stringWidth(clipped);
    const padWidth = Math.max(0, width - clippedWidth);

    if (alignment === 'right') {
        return `${' '.repeat(padWidth)}${clipped}`;
    }

    return `${clipped}${' '.repeat(padWidth)}`;
};

const toContentWidths = (rows: string[][], columns: TableColumnConfig[]) => {
    return columns.map((column, columnIndex) => {
        const contentWidth = rows.reduce((maxWidth, row) => {
            const value = row[columnIndex] ?? '';
            return Math.max(maxWidth, stringWidth(value));
        }, 0);

        return Math.max(column.width, contentWidth);
    });
};

const toTotalWidths = (widths: number[], columns: TableColumnConfig[]) => {
    return widths.map((width, columnIndex) => {
        const column = columns[columnIndex];
        const paddingLeft = column?.paddingLeft ?? 1;
        const paddingRight = column?.paddingRight ?? 1;
        return width + paddingLeft + paddingRight;
    });
};

const tableRenderWidth = (totalWidths: number[]) => {
    if (totalWidths.length === 0) {
        return 0;
    }

    return (
        totalWidths.reduce((sum, width) => sum + width, 0) +
        (totalWidths.length - 1) +
        2
    );
};

const shrinkWidthsToFit = (
    widths: number[],
    columns: TableColumnConfig[],
    maxWidth: number
) => {
    const shrunk = [...widths];
    const minWidths = columns.map(() => 3);
    const priorities = columns
        .map((column, index) => ({
            index,
            priority: column.truncatePriority ?? Number.POSITIVE_INFINITY,
        }))
        .filter(entry => Number.isFinite(entry.priority))
        .sort((a, b) => a.priority - b.priority);

    if (priorities.length === 0) {
        return shrunk;
    }

    while (true) {
        const totalWidths = toTotalWidths(shrunk, columns);
        const currentWidth = tableRenderWidth(totalWidths);
        if (currentWidth <= maxWidth) {
            break;
        }

        let reduced = false;
        for (const entry of priorities) {
            const idx = entry.index;
            if ((shrunk[idx] ?? 0) > (minWidths[idx] ?? 3)) {
                shrunk[idx] = (shrunk[idx] ?? 0) - 1;
                reduced = true;
                break;
            }
        }

        if (!reduced) {
            break;
        }
    }

    return shrunk;
};

const drawHorizontal = (
    totalWidths: number[],
    type: 'top' | 'middle' | 'bottom'
) => {
    if (type === 'top') {
        return `${TABLE_BORDER.topLeft}${totalWidths
            .map(width => TABLE_BORDER.topBody.repeat(width))
            .join(TABLE_BORDER.topJoin)}${TABLE_BORDER.topRight}`;
    }

    if (type === 'bottom') {
        return `${TABLE_BORDER.bottomLeft}${totalWidths
            .map(width => TABLE_BORDER.bottomBody.repeat(width))
            .join(TABLE_BORDER.bottomJoin)}${TABLE_BORDER.bottomRight}`;
    }

    return `${TABLE_BORDER.joinLeft}${totalWidths
        .map(width => TABLE_BORDER.joinBody.repeat(width))
        .join(TABLE_BORDER.joinJoin)}${TABLE_BORDER.joinRight}`;
};

export const renderTextTable = (rows: string[][], config: TableConfig) => {
    if (rows.length === 0 || config.columns.length === 0) {
        return [];
    }

    const naturalWidths = toContentWidths(rows, config.columns);
    const adjustedWidths =
        config.maxWidth && config.maxWidth > 0
            ? shrinkWidthsToFit(naturalWidths, config.columns, config.maxWidth)
            : naturalWidths;
    const totalWidths = toTotalWidths(adjustedWidths, config.columns);

    const lines: string[] = [];
    lines.push(drawHorizontal(totalWidths, 'top'));

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex] ?? [];
        const cells = config.columns.map((column, columnIndex) => {
            const raw = row[columnIndex] ?? '';
            const cell = alignCell(
                raw,
                adjustedWidths[columnIndex] ?? 0,
                column.alignment
            );
            const paddingLeft = ' '.repeat(column.paddingLeft ?? 1);
            const paddingRight = ' '.repeat(column.paddingRight ?? 1);
            return `${paddingLeft}${cell}${paddingRight}`;
        });

        lines.push(
            `${TABLE_BORDER.bodyLeft}${cells.join(TABLE_BORDER.bodyJoin)}${TABLE_BORDER.bodyRight}`
        );

        if (rowIndex === 0 && rows.length > 1) {
            lines.push(drawHorizontal(totalWidths, 'middle'));
        }
    }

    lines.push(drawHorizontal(totalWidths, 'bottom'));
    return lines;
};

export type { Alignment, TableColumnConfig, TableConfig };
