import type { ActualServerConfig, ActualBudgetConfig } from './config.js';
import { includesRef } from './cliArgs.js';

export type ActualTarget = {
    server: ActualServerConfig;
    budget: ActualBudgetConfig;
};

export const selectTargets = (
    servers: ActualServerConfig[],
    serverRefs: string[] | undefined,
    budgetRefs: string[] | undefined
): ActualTarget[] => {
    const targets: ActualTarget[] = [];

    for (const server of servers) {
        if (!includesRef(serverRefs, server.serverUrl)) {
            continue;
        }

        for (const budget of server.budgets) {
            if (!includesRef(budgetRefs, budget.syncId)) {
                continue;
            }

            targets.push({ server, budget });
        }
    }

    return targets;
};
