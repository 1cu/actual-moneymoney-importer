import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export interface CliRunOptions {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
}

export interface CliRunResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

const repoRoot: string = fileURLToPath(new URL('../../', import.meta.url));
const cliEntryPoint: string = path.join(repoRoot, 'dist', 'index.js');

export function createCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        ...process.env,
        NODE_ENV: 'test',
        FORCE_COLOR: '0',
        ...overrides,
    };
}

export async function runCli(args: readonly string[], options: CliRunOptions = {}): Promise<CliRunResult> {
    const env = options.env ? { ...createCliEnv(), ...options.env } : createCliEnv();
    const cwd = options.cwd ?? repoRoot;
    const timeout = options.timeoutMs ?? 10000;

    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntryPoint, ...args], {
            cwd,
            env,
            timeout,
            encoding: 'utf8',
        });

        return {
            exitCode: 0,
            stdout,
            stderr,
        };
    } catch (error: any) {
        return {
            exitCode: error.code ?? 1,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message ?? '',
        };
    }
}