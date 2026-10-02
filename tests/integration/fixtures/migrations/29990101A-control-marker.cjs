exports.up = async (database) => {
	await database.schema.createTable('integration_migration_control', (table) => table.string('value').primary());
	await database('integration_migration_control').insert({ value: 'migration-ran' });
};

exports.down = async (database) => database.schema.dropTable('integration_migration_control');
