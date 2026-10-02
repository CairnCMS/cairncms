module.exports = function registerHooks({ filter, action }, { exceptions }) {
	const logsCollection = 'tests_extensions_log';
	const hookRollbackMessage = 'config-apply-probe: forced permission-phase rollback';
	const hookProbePrefix = 'hookprobe_';
	const probeRoleIds = new Set();
	const probePermIds = new Set();
	const rollbackRoleIds = new Set();
	const dbProbeRoleIds = new Set();

	async function mark(database, key) {
		await database(logsCollection).insert({ key: `config-apply-probe/${key}`, value: '1' });
	}

	// Reads the role key through the supplied EventContext.database rather than getDatabase(). On a
	// single-connection SQLite deployment this only completes because it uses the transaction connection.
	filter('roles.update', async (payload, meta, { database }) => {
		for (const id of (meta && meta.keys) || []) {
			const row = await database('directus_roles').select('key').where({ id }).first();

			if (row && typeof row.key === 'string' && row.key.startsWith(hookProbePrefix)) {
				dbProbeRoleIds.add(id);
				await mark(database, `roles.update.dbfilter/${id}`);
			}
		}

		return payload;
	});

	filter('permissions.create', (payload) => {
		if (payload && payload.collection === 'audit_probe_rollback') {
			throw new Error('config apply probe forced rollback');
		}

		// A typed exception so a config-apply failure at the permission phase is distinguishable from a
		// role-phase failure, which would surface as CONFIG_APPLY_FAILED.
		if (payload && payload.collection === 'hookprobe_rollback') {
			throw new exceptions.InvalidPayloadException(hookRollbackMessage);
		}

		return payload;
	});

	filter('permissions.delete', async (keys, _meta, { database }) => {
		for (const id of keys || []) {
			if (probePermIds.has(id)) await mark(database, `permissions.delete.filter/${id}`);
		}

		return keys;
	});

	filter('roles.delete', async (keys, _meta, { database }) => {
		for (const id of keys || []) {
			if (probeRoleIds.has(id)) await mark(database, `roles.delete.filter/${id}`);
		}

		for (const id of keys || []) {
			if (rollbackRoleIds.has(id)) throw new Error('config apply probe forced delete rollback');
		}

		return keys;
	});

	action('roles.create', async (data, { database }) => {
		const key = data && data.payload && data.payload.key;
		if (typeof key !== 'string' || !key.startsWith('audit_probe')) return;

		probeRoleIds.add(data.key);
		if (key.includes('delrollback')) rollbackRoleIds.add(data.key);
		await mark(database, `roles.create/${key}`);
	});

	action('roles.update', async (data, { database }) => {
		for (const id of data.keys || []) {
			if (probeRoleIds.has(id)) await mark(database, `roles.update/${id}`);

			if (dbProbeRoleIds.has(id)) {
				await mark(database, `roles.update.dbaction/${id}`);
				dbProbeRoleIds.delete(id);
			}
		}
	});

	action('roles.delete', async (data, { database }) => {
		for (const id of data.keys || []) {
			dbProbeRoleIds.delete(id);

			if (probeRoleIds.has(id)) {
				await mark(database, `roles.delete/${id}`);
				probeRoleIds.delete(id);
			}
		}
	});

	action('permissions.create', async (data, { database }) => {
		const collection = data && data.payload && data.payload.collection;
		if (typeof collection !== 'string' || !collection.startsWith('audit_probe')) return;

		probePermIds.add(data.key);
		await mark(database, `permissions.create/${collection}`);
	});

	action('permissions.update', async (data, { database }) => {
		for (const id of data.keys || []) {
			if (probePermIds.has(id)) await mark(database, `permissions.update/${id}`);
		}
	});

	action('permissions.delete', async (data, { database }) => {
		for (const id of data.keys || []) {
			if (probePermIds.has(id)) {
				await mark(database, `permissions.delete/${id}`);
				probePermIds.delete(id);
			}
		}
	});

	action('users.update', async (data, { database }) => {
		for (const id of data.keys || []) {
			const user = await database('directus_users').select('email').where({ id }).first();
			if (user && typeof user.email === 'string' && user.email.startsWith('audit_probe')) {
				await mark(database, `users.update/${id}`);
			}
		}
	});
};
