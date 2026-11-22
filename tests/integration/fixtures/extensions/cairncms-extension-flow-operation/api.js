export default {
	id: 'flow-probe',
	handler: (options, context) => {
		if (options.fail) {
			context.logger.info('flow-probe-reached-throw');
			throw new Error('flow-probe failed as configured');
		}

		return {
			options,
			synthetic: context.data?.seed?.synthetic ?? null,
			chain: Object.keys(context.data).sort(),
			user: context.accountability?.user ?? null,
			context: {
				services: typeof context.services === 'object' && context.services !== null,
				database: typeof context.database === 'function',
				getSchema: typeof context.getSchema === 'function',
				env: typeof context.env === 'object' && context.env !== null,
				logger: typeof context.logger?.info === 'function',
			},
		};
	},
};
