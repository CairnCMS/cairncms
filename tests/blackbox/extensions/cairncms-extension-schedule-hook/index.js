export default function registerScheduleHook({ schedule }, { logger, env }) {
	if (env['SCHEDULE_COORD_TEST'] !== true) return;

	schedule('*/2 * * * * *', () => {
		logger.info('SCHEDULE_COORD_HOOK');
	});
}
