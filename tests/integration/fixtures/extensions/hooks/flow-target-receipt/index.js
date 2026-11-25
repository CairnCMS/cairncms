module.exports = function registerHooks({ filter, action }, { logger }) {
	filter('test_flow_targets.items.update', (payload) => {
		logger.info(`flow-target-filter ${payload?.name}`);
	});

	action('test_flow_targets.items.update', (meta) => {
		logger.info(`flow-target-action ${meta.payload?.name}`);
	});

	filter('test_flow_targets_guarded.items.query', (query) => {
		logger.info(`flow-target-query ${query?.search ?? Object.keys(query?.filter ?? {}).join(',')}`);
	});
};
