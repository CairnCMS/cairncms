module.exports = function registerHooks({ action }, { logger }) {
	action('test_flow_options_studio.items.update', (meta) => {
		logger.info(`flow-update-receipt ${meta.payload?.name}`);
	});
};
