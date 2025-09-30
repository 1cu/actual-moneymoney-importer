import type { Account as MonMonAccount } from 'moneymoney';
import { getAccounts } from 'moneymoney';
import ActualApi from './ActualApi.js';
import type { ActualBudgetConfig } from './config.js';
import Logger from './Logger.js';

// Use the return type of ActualApi.getAccounts() to get the canonical Account type
type ActualAccount = Awaited<ReturnType<ActualApi['getAccounts']>>[number];

interface LoadFromConfigOptions {
    readonly accountRefs?: ReadonlyArray<string>;
}

export class AccountMap {
    public constructor(
        private budgetConfig: ActualBudgetConfig,
        private logger: Logger,
        private actualApi: ActualApi
    ) {}

    private moneyMoneyAccounts: Array<MonMonAccount> = [];
    private actualAccounts: Array<ActualAccount> = [];

    private mapping: Map<MonMonAccount, ActualAccount> | null = null;
    private _isLoading = false;

    public getMap(moneyMoneyAccountRefs?: Array<string>): Map<MonMonAccount, ActualAccount> {
        if (!this.mapping) {
            throw new Error('Account mapping has not been loaded. Call loadFromConfig() before accessing the map.');
        }

        if (!moneyMoneyAccountRefs) return this.mapping;

        const customMap = new Map<MonMonAccount, ActualAccount>();
        for (const ref of moneyMoneyAccountRefs) {
            const monMonAccount = this.getMoneyMoneyAccountByRef(ref);

            if (!monMonAccount) {
                this.logger.error(`Specified account ref '${ref}' did not resolve to any MoneyMoney accounts.`);
                continue;
            }

            const actualAccount = this.mapping.get(monMonAccount);

            if (!actualAccount) {
                this.logger.error(
                    `Could not find an Actual account for specified MoneyMoney account with ref '${ref}'.`
                );
                continue;
            }

            customMap.set(monMonAccount, actualAccount);
        }

        return customMap;
    }

    private checkMoneyMoneyAccountRef(account: MonMonAccount, ref: string): boolean {
        const r = String(ref).trim();
        return (
            String(account.uuid ?? '').trim() === r ||
            String(account.accountNumber ?? '').trim() === r ||
            String(account.name ?? '').trim() === r
        );
    }

    public getMoneyMoneyAccountByRef(ref: string) {
        const matchingAccounts = this.moneyMoneyAccounts.filter((acc) => this.checkMoneyMoneyAccountRef(acc, ref));

        if (matchingAccounts.length === 0) {
            this.logger.warn(`No MoneyMoney account found for reference '${ref}'.`);

            return null;
        } else if (matchingAccounts.length > 1) {
            this.logger.warn(
                `Found multiple MoneyMoney accounts matching the reference '${ref}'. Using the first one.`
            );
        }

        return matchingAccounts[0];
    }

    private checkActualAccountRef(account: ActualAccount, ref: string) {
        return account.id === ref || account.name === ref;
    }

    public getActualAccountByRef(ref: string): ActualAccount | null {
        const matchingAccounts = this.actualAccounts.filter((acc) => this.checkActualAccountRef(acc, ref));

        if (matchingAccounts.length === 0) {
            this.logger.warn(`No Actual account found for reference '${ref}'.`);

            return null;
        } else if (matchingAccounts.length > 1) {
            this.logger.warn(`Found multiple Actual accounts matching the reference '${ref}'. Using the first one.`);
        }

        return matchingAccounts[0] ?? null;
    }

    public async loadFromConfig(options: LoadFromConfigOptions = {}): Promise<void> {
        if (this.mapping || this._isLoading) return;
        this._isLoading = true;

        const accountMapping = this.budgetConfig.accountMapping ?? {};
        if (typeof accountMapping !== 'object' || accountMapping === null) {
            throw new Error('Invalid budget configuration: accountMapping must be an object');
        }

        const [moneyMoneyAccounts, actualAccounts] = await Promise.all([getAccounts(), this.actualApi.getAccounts()]);
        this.moneyMoneyAccounts = moneyMoneyAccounts;
        this.actualAccounts = actualAccounts as Array<ActualAccount>;

        const parsedAccountMapping: Map<MonMonAccount, ActualAccount> = new Map();
        const accountRefsFilter =
            options.accountRefs && options.accountRefs.length > 0 ? new Set(options.accountRefs) : null;

        for (const [moneyMoneyRef, actualRef] of Object.entries(accountMapping as Record<string, string>)) {
            this.processAccountMapping(moneyMoneyRef, actualRef, accountRefsFilter, parsedAccountMapping);
        }

        this.mapping = parsedAccountMapping;
        this._isLoading = false;
    }

    private processAccountMapping(
        moneyMoneyRef: string,
        actualRef: string,
        accountRefsFilter: Set<string> | null,
        parsedAccountMapping: Map<MonMonAccount, ActualAccount>
    ): void {
        const moneyMoneyAccount = this.getMoneyMoneyAccountByRef(moneyMoneyRef);
        const actualAccount = this.getActualAccountByRef(actualRef);
        const requiresResolution = accountRefsFilter === null || accountRefsFilter.has(moneyMoneyRef);

        if (requiresResolution && !moneyMoneyAccount) {
            this.logger.error(`MoneyMoney account reference '${moneyMoneyRef}' not found`);
            throw new Error(`MoneyMoney account reference '${moneyMoneyRef}' not found`);
        }
        if (requiresResolution && !actualAccount) {
            this.logger.error(`Actual account reference '${actualRef}' not found`);
            throw new Error(`Actual account reference '${actualRef}' not found`);
        }

        if (moneyMoneyAccount && actualAccount) {
            parsedAccountMapping.set(moneyMoneyAccount, actualAccount);
        }
    }
}
