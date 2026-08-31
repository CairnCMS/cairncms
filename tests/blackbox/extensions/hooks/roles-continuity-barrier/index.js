module.exports = function registerHooks({ filter, action }) {
	const barriers = new Map();

	filter('roles.update', async (payload) => {
		if (!payload || typeof payload !== 'object') return payload;

		if (payload._injectDemotion) {
			const { _injectDemotion, ...rest } = payload;
			return { ...rest, admin_access: false };
		}

		const key = payload._raceBarrier;

		if (typeof key === 'string' && key.length > 0) {
			const { _raceBarrier, ...rest } = payload;

			await new Promise((resolve, reject) => {
				let entry = barriers.get(key);

				if (!entry) {
					entry = { parties: [] };
					barriers.set(key, entry);
				}

				const party = { resolve, reject };

				party.timer = setTimeout(() => {
					barriers.delete(key);

					for (const waiting of entry.parties) {
						clearTimeout(waiting.timer);
						waiting.reject(new Error('roles-continuity-barrier timeout'));
					}
				}, 5000);

				entry.parties.push(party);

				if (entry.parties.length >= 2) {
					barriers.delete(key);

					for (const waiting of entry.parties) {
						clearTimeout(waiting.timer);
						waiting.resolve();
					}
				}
			});

			return rest;
		}

		return payload;
	});

	action('roles.update', async (data, { database }) => {
		const marker = data && data.payload && data.payload._raceBarrier;
		if (typeof marker !== 'string' || marker.length === 0) return;

		await database('tests_extensions_log').insert({
			key: `roles-continuity-barrier/committed/${marker}`,
			value: JSON.stringify(data.keys || []),
		});
	});
};
