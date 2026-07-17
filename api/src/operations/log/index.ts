import { defineOperationApi, optionToString } from '@cairncms/utils';
import { REDACT_TEXT } from '../../constants.js';
import logger from '../../logger.js';

type Options = {
	message: unknown;
};

type FlowLogRedactor = { redactForFlowLog?: (value: unknown) => unknown };

export default defineOperationApi<Options>({
	id: 'log',

	handler: ({ message }, context) => {
		const redact = (context as FlowLogRedactor).redactForFlowLog;
		logger.info(optionToString(redact ? redact(message) : REDACT_TEXT));
	},
});
