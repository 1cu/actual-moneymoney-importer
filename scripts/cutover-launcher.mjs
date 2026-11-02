import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const shortcutName = 'Actual synchronisieren';

const isDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
};

const shiftDate = (value, days) => {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
};

const localToday = now =>
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export const fromDate = (today, lastSuccess, earliestImportDate) => {
    if (!isDate(today) || !isDate(earliestImportDate)) {
        throw new Error('Invalid launcher date');
    }
    return isDate(lastSuccess)
        ? [shiftDate(today, -90), shiftDate(lastSuccess, -5)].sort()[0]
        : earliestImportDate;
};

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const xmlEscape = value =>
    value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');

export const runLauncher = (
    { directory, repoDir, configPath, earliestImportDate, actualUrl, nodePath },
    { now = new Date(), spawn = spawnSync } = {}
) => {
    if (!isDate(earliestImportDate))
        throw new Error('Invalid earliestImportDate');
    const lockPath = join(directory, '.actual-mmi.lock');
    const statePath = join(directory, '.actual-mmi-last-success');
    const today = localToday(now);
    try {
        mkdirSync(lockPath);
    } catch (error) {
        if (error.code === 'EEXIST') {
            throw new Error(`Import already running (lock: ${lockPath})`);
        }
        throw error;
    }
    try {
        let lastSuccess;
        try {
            lastSuccess = readFileSync(statePath, 'utf8').trim();
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const start = fromDate(today, lastSuccess, earliestImportDate);
        const result = spawn(
            nodePath,
            [
                join(repoDir, 'dist/index.js'),
                'import',
                '--config',
                configPath,
                `--from=${start}`,
                `--to=${today}`,
            ],
            { cwd: repoDir, stdio: 'inherit' }
        );
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error(
                `Import failed (exit ${result.status ?? result.signal})`
            );
        }
        const pending = `${statePath}.${randomUUID()}.tmp`;
        try {
            writeFileSync(pending, `${today}\n`, { mode: 0o600, flag: 'wx' });
            renameSync(pending, statePath);
        } finally {
            rmSync(pending, { force: true });
        }
        if (actualUrl) {
            const opened = spawn('/usr/bin/open', [actualUrl], {
                stdio: 'inherit',
            });
            if (opened.error || opened.status !== 0) {
                throw new Error(
                    `Import succeeded, but opening Actual failed: ${opened.error?.message ?? opened.status}`
                );
            }
        }
        return { from: start, to: today };
    } finally {
        rmSync(lockPath, { recursive: true, force: true });
    }
};

export const installLauncher = ({
    directory,
    repoDir,
    configPath,
    earliestImportDate,
    actualUrl,
    nodePath,
}) => {
    if (!isDate(earliestImportDate))
        throw new Error('Invalid earliestImportDate');
    const options = {
        directory: resolve(directory),
        repoDir: resolve(repoDir),
        configPath: resolve(configPath),
        earliestImportDate,
        actualUrl,
        nodePath: resolve(nodePath),
    };
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const launcherPath = join(options.directory, 'actual-synchronisieren.zsh');
    const encoded = Buffer.from(JSON.stringify(options)).toString('base64');
    writeFileSync(
        launcherPath,
        `#!/bin/zsh\nset -e\nsource "$HOME/.zsh_secrets"\n${shellQuote(options.nodePath)} ${shellQuote(thisFile)} run ${shellQuote(encoded)}\n`,
        { mode: 0o700 }
    );
    chmodSync(launcherPath, 0o700);

    const unsigned = join(
        options.directory,
        `${shortcutName}.unsigned.shortcut`
    );
    const signed = join(options.directory, `${shortcutName}.shortcut`);
    const script = shellQuote(launcherPath);
    writeFileSync(
        unsigned,
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>WFWorkflowName</key><string>${shortcutName}</string><key>WFWorkflowClientVersion</key><string>2700.0.4</string><key>WFWorkflowMinimumClientVersion</key><integer>900</integer><key>WFWorkflowMinimumClientVersionString</key><string>900</string><key>WFWorkflowIcon</key><dict><key>WFWorkflowIconGlyphNumber</key><integer>59395</integer><key>WFWorkflowIconStartColor</key><integer>4292093695</integer></dict><key>WFWorkflowImportQuestions</key><array/><key>WFWorkflowOutputContentItemClasses</key><array/><key>WFWorkflowTypes</key><array/><key>WFWorkflowActions</key><array><dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.runshellscript</string><key>WFWorkflowActionParameters</key><dict><key>UUID</key><string>${randomUUID().toUpperCase()}</string><key>Script</key><string>${xmlEscape(script)}</string><key>Shell</key><string>/bin/zsh</string></dict></dict></array></dict></plist>\n`,
        { mode: 0o600 }
    );
    const converted = spawnSync(
        '/usr/bin/plutil',
        ['-convert', 'binary1', unsigned],
        { encoding: 'utf8' }
    );
    if (converted.error || converted.status !== 0) {
        rmSync(unsigned, { force: true });
        throw new Error(
            `Could not build Shortcut: ${converted.error?.message ?? converted.stderr}`
        );
    }
    const result = spawnSync(
        '/usr/bin/shortcuts',
        ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signed],
        { encoding: 'utf8' }
    );
    rmSync(unsigned, { force: true });
    if (result.error || result.status !== 0) {
        throw new Error(
            `Could not sign Shortcut: ${result.error?.message ?? result.stderr}`
        );
    }
    chmodSync(signed, 0o600);
    return { launcherPath, shortcutPath: signed };
};

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
    try {
        if (process.argv[2] !== 'run' || !process.argv[3])
            throw new Error('Expected run and launcher settings');
        runLauncher(
            JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'))
        );
    } catch (error) {
        console.error(`Actual sync: ${error.message}`);
        process.exitCode = 1;
    }
}
