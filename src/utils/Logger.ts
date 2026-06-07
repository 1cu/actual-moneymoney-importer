import chalk from 'chalk';

export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3,
    ACTUAL = 4,
}

type LogHint = string | string[];

class Logger {
    public logLevel: LogLevel = LogLevel.INFO;

    // We use a private reference to console.log to allow suppressing logs in other parts of the code
    private consoleLog = console.log;

    /** Phase marker deferred until an INFO+ log event occurs within it. */
    private pendingPhase: string | null = null;

    constructor(logLevel = LogLevel.INFO) {
        this.logLevel = logLevel;
    }

    public error(message: string, hint?: LogHint) {
        this.flushPhase();
        this.log(LogLevel.ERROR, message, hint);
    }

    public warn(message: string, hint?: LogHint) {
        this.flushPhase();
        this.log(LogLevel.WARN, message, hint);
    }

    public info(message: string, hint?: LogHint) {
        this.flushPhase();
        this.log(LogLevel.INFO, message, hint);
    }

    public debug(message: string, hint?: LogHint) {
        this.log(LogLevel.DEBUG, message, hint);
    }

    /** Schedule a phase banner. Printed when the next INFO+ event occurs, unless unconditional. */
    public phase(
        label: string,
        { unconditional }: { unconditional?: boolean } = {}
    ) {
        if (unconditional) {
            // Always print immediately — no lazy deferral.
            if (this.logLevel >= LogLevel.INFO) {
                // Discard any pending lazy phase — the unconditional marker replaces it.
                if (this.pendingPhase !== null) {
                    this.pendingPhase = null;
                }
                this.consoleLog();
                this.consoleLog(chalk.bold(`── ${label} ──`));
            }
            return;
        }
        // If the previous pending phase never emitted any output, silently discard it.
        this.pendingPhase = label;
    }

    /** Flush a pending phase marker to the output, if one is queued. */
    private flushPhase() {
        if (this.pendingPhase !== null && this.logLevel >= LogLevel.INFO) {
            this.consoleLog();
            this.consoleLog(chalk.bold(`── ${this.pendingPhase} ──`));
            this.pendingPhase = null;
        }
    }

    public actual(message: string, hint?: LogHint) {
        this.log(LogLevel.ACTUAL, message, hint);
    }

    private log(level: LogLevel, message: string, hint?: LogHint) {
        if (this.logLevel >= level) {
            const prefix = `[${LogLevel[level].toUpperCase()}]`;
            const chalkColor = {
                [LogLevel.ERROR]: chalk.red,
                [LogLevel.WARN]: chalk.yellow,
                [LogLevel.INFO]: chalk.cyan,
                [LogLevel.DEBUG]: chalk.gray,
                [LogLevel.ACTUAL]: chalk.magenta,
            }[level];

            this.consoleLog(chalkColor(prefix), message);
            if (hint) {
                const arrayHint = Array.isArray(hint) ? hint : [hint];
                for (const hint of arrayHint) {
                    this.consoleLog(
                        chalk.gray(' '.repeat(prefix.length), '↳', hint)
                    );
                }
            }
        }
    }
}

export default Logger;
