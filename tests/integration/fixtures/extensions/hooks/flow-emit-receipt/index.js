module.exports = function registerHooks({ action }, { logger }) {
	action('test_flow_events_emitted.items.create', (meta) => {
		logger.info(`flow-emit-receipt ${meta.payload?.name}`);
	});
};
