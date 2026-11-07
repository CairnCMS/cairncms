/** Returns the knex client the built API uses for SQLite, so harness connections open files the same way. */
export async function sqliteClient() {
	const { getSqliteClient } = await import('../../../api/dist/database/sqlite-driver.js');
	return getSqliteClient();
}
