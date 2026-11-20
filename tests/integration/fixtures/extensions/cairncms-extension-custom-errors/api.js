const createQuotaExceededException = (exceptions) =>
	class QuotaExceededException extends exceptions.BaseException {
		constructor(message, details) {
			super(message, 429, 'QUOTA_EXCEEDED', details);
		}
	};

export default {
	endpoints: [
		{
			name: 'custom-errors',
			config: (router, { exceptions }) => {
				const QuotaExceededException = createQuotaExceededException(exceptions);

				router.post('/quota', (_req, _res, next) => {
					next(new QuotaExceededException('The quota is used up.', { limit: 5 }));
				});

				router.post('/echo', (req, _res, next) => {
					const submitted = req.body?.password;
					next(new QuotaExceededException(`The quota is used up for ${submitted}.`, { limit: 5, submitted }));
				});
			},
		},
	],
	hooks: [
		{
			name: 'custom-errors-hook',
			config: ({ filter }, { exceptions }) => {
				const QuotaExceededException = createQuotaExceededException(exceptions);

				const rejectOverQuota = (payload) => {
					if (payload?.title === 'over quota') throw new QuotaExceededException('The quota is used up.', { limit: 5 });
					return payload;
				};

				filter('custom_error_records.items.create', rejectOverQuota);
				filter('custom_error_settings.items.create', rejectOverQuota);
				filter('custom_error_settings.items.update', rejectOverQuota);
			},
		},
	],
	operations: [],
};
