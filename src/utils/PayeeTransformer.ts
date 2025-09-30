import Logger from './Logger.js';
import type { PayeeTransformationConfig } from './config.js';

class PayeeTransformer {
    public constructor(
        private readonly config: PayeeTransformationConfig,
        private readonly logger: Logger
    ) {}

    public async transformPayees(payees: string[]): Promise<Record<string, string>> {
        if (payees.length === 0) {
            return {};
        }

        if (!this.config.openAiApiKey) {
            this.logger.warn('Payee transformation requested without an OpenAI API key. Returning original payees.');
        } else {
            this.logger.info('Payee transformation is disabled in the simplified build. Returning original payees.');
        }

        return Array.from(new Set(payees)).reduce<Record<string, string>>((accumulator, payee) => {
            accumulator[payee] = payee;
            return accumulator;
        }, {});
    }
}

export default PayeeTransformer;
