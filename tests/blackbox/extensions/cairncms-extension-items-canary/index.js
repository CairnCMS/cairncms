export default ({ filter, action }, { database }) => {
	const record = async (event) => {
		try {
			await database('confined_canary_events').insert({ event });
		} catch {
			// The canary table is created by the test; events before that are not recorded.
		}
	};

	filter('confined_tenant_records.items.query', async (payload) => {
		await record('query');
		return payload;
	});

	action('confined_tenant_records.items.read', async () => {
		await record('read');
	});
};
