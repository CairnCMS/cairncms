export type DriverErrorFixture = {
	client: 'postgres' | 'mysql' | 'sqlite';
	scenario: string;
	vendors: string[];
	action?: 'delete';
	error: Record<string, unknown> & { message: string };
	expected: { type: string; message: string; extensions: Record<string, unknown> };
};

/**
 * Driver errors captured from each supported database through the API's own connection, keeping only the
 * fields the dialect translators read, with the exception each one translated to when captured.
 */
export const driverErrorFixtures: DriverErrorFixture[] = [
	{
		client: 'postgres',
		scenario: 'unique',
		vendors: ['postgres18', 'postgres15', 'postgres10'],
		error: {
			message:
				'insert into "probe_unique" ("email") values ($1) - duplicate key value violates unique constraint "probe_unique_email_unique"',
			code: '23505',
			detail: 'Key (email)=(duplicate@example.com) already exists.',
			table: 'probe_unique',
		},
		expected: {
			type: 'RecordNotUniqueException',
			message: 'Field "email" has to be unique.',
			extensions: { collection: 'probe_unique', field: 'email', invalid: 'duplicate@example.com' },
		},
	},
	{
		client: 'postgres',
		scenario: 'out_of_range',
		vendors: ['postgres18', 'postgres15', 'postgres10'],
		error: {
			message: 'insert into "probe_range" ("score") values ($1) - value "99999999999" is out of range for type integer',
			code: '22003',
		},
		expected: {
			type: 'ValueOutOfRangeException',
			message: 'Numeric value is out of range.',
			extensions: { collection: 'probe_range', field: null, invalid: '99999999999' },
		},
	},
	{
		client: 'postgres',
		scenario: 'too_long',
		vendors: ['postgres18', 'postgres15', 'postgres10'],
		error: {
			message: 'insert into "probe_long" ("code") values ($1) - value too long for type character varying(5)',
			code: '22001',
		},
		expected: {
			type: 'ValueTooLongException',
			message: 'Value is too long.',
			extensions: { collection: 'probe_long', field: null },
		},
	},
	{
		client: 'postgres',
		scenario: 'not_null',
		vendors: ['postgres18', 'postgres15'],
		error: {
			message:
				'insert into "probe_notnull" ("name") values ($1) - null value in column "name" of relation "probe_notnull" violates not-null constraint',
			code: '23502',
			detail: 'Failing row contains (1, null).',
			table: 'probe_notnull',
			column: 'name',
		},
		expected: {
			type: 'NotNullViolationException',
			message: 'Value for field "name" can\'t be null.',
			extensions: { collection: 'probe_notnull', field: 'name' },
		},
	},
	{
		client: 'postgres',
		scenario: 'contains_null',
		vendors: ['postgres18', 'postgres15'],
		error: {
			message:
				'alter table "probe_alter" alter column "note" set not null - column "note" of relation "probe_alter" contains null values',
			code: '23502',
			table: 'probe_alter',
			column: 'note',
		},
		expected: {
			type: 'ContainsNullValuesException',
			message: 'Field "note" contains null values.',
			extensions: { collection: 'probe_alter', field: 'note' },
		},
	},
	{
		client: 'postgres',
		scenario: 'fk_insert',
		vendors: ['postgres18', 'postgres15', 'postgres10'],
		error: {
			message:
				'insert into "probe_fki_child" ("parent") values ($1) - insert or update on table "probe_fki_child" violates foreign key constraint "probe_fki_child_parent_foreign"',
			code: '23503',
			detail: 'Key (parent)=(999) is not present in table "probe_fki_parent".',
			table: 'probe_fki_child',
		},
		expected: {
			type: 'InvalidForeignKeyException',
			message: 'Invalid foreign key in field "parent".',
			extensions: { collection: 'probe_fki_child', field: 'parent', invalid: '999' },
		},
	},
	{
		client: 'postgres',
		scenario: 'fk_delete',
		vendors: ['postgres18', 'postgres15', 'postgres10'],
		action: 'delete',
		error: {
			message:
				'delete from "probe_fkd_parent" where "id" = $1 - update or delete on table "probe_fkd_parent" violates foreign key constraint "probe_fkd_child_parent_foreign" on table "probe_fkd_child"',
			code: '23503',
			detail: 'Key (id)=(1) is still referenced from table "probe_fkd_child".',
			table: 'probe_fkd_child',
		},
		expected: {
			type: 'RecordStillReferencedException',
			message: "Item can't be deleted because other items still reference it.",
			extensions: {},
		},
	},
	{
		client: 'postgres',
		scenario: 'not_null',
		vendors: ['postgres10'],
		error: {
			message:
				'insert into "probe_notnull" ("name") values ($1) - null value in column "name" violates not-null constraint',
			code: '23502',
			detail: 'Failing row contains (1, null).',
			table: 'probe_notnull',
			column: 'name',
		},
		expected: {
			type: 'NotNullViolationException',
			message: 'Value for field "name" can\'t be null.',
			extensions: { collection: 'probe_notnull', field: 'name' },
		},
	},
	{
		client: 'postgres',
		scenario: 'contains_null',
		vendors: ['postgres10'],
		error: {
			message: 'alter table "probe_alter" alter column "note" set not null - column "note" contains null values',
			code: '23502',
			table: 'probe_alter',
			column: 'note',
		},
		expected: {
			type: 'ContainsNullValuesException',
			message: 'Field "note" contains null values.',
			extensions: { collection: 'probe_alter', field: 'note' },
		},
	},
	{
		client: 'mysql',
		scenario: 'unique',
		vendors: ['mysql97', 'mysql84'],
		error: {
			message:
				"insert into `probe_unique` (`email`) values ('duplicate@example.com') - Duplicate entry 'duplicate@example.com' for key 'probe_unique.probe_unique_email_unique'",
			code: 'ER_DUP_ENTRY',
			errno: 1062,
			sqlMessage: "Duplicate entry 'duplicate@example.com' for key 'probe_unique.probe_unique_email_unique'",
			sql: "insert into `probe_unique` (`email`) values ('duplicate@example.com')",
		},
		expected: {
			type: 'RecordNotUniqueException',
			message: 'Field "email" has to be unique.',
			extensions: { collection: 'probe_unique', field: 'email', invalid: 'duplicate@example.com' },
		},
	},
	{
		client: 'mysql',
		scenario: 'out_of_range',
		vendors: ['mysql97', 'mysql84', 'mysql5', 'maria123', 'maria1011'],
		error: {
			message:
				"insert into `probe_range` (`score`) values (99999999999) - Out of range value for column 'score' at row 1",
			code: 'ER_WARN_DATA_OUT_OF_RANGE',
			errno: 1264,
			sqlMessage: "Out of range value for column 'score' at row 1",
			sql: 'insert into `probe_range` (`score`) values (99999999999)',
		},
		expected: {
			type: 'ValueOutOfRangeException',
			message: 'Numeric value in field "score" is out of range.',
			extensions: { collection: 'probe_range', field: 'score' },
		},
	},
	{
		client: 'mysql',
		scenario: 'too_long',
		vendors: ['mysql97', 'mysql84', 'mysql5', 'maria123', 'maria1011'],
		error: {
			message: "insert into `probe_long` (`code`) values ('abcdefgh') - Data too long for column 'code' at row 1",
			code: 'ER_DATA_TOO_LONG',
			errno: 1406,
			sqlMessage: "Data too long for column 'code' at row 1",
			sql: "insert into `probe_long` (`code`) values ('abcdefgh')",
		},
		expected: {
			type: 'ValueTooLongException',
			message: 'Value for field "code" is too long.',
			extensions: { collection: 'probe_long', field: 'code' },
		},
	},
	{
		client: 'mysql',
		scenario: 'not_null',
		vendors: ['mysql97', 'mysql84', 'mysql5', 'maria123', 'maria1011'],
		error: {
			message: "insert into `probe_notnull` (`name`) values (NULL) - Column 'name' cannot be null",
			code: 'ER_BAD_NULL_ERROR',
			errno: 1048,
			sqlMessage: "Column 'name' cannot be null",
			sql: 'insert into `probe_notnull` (`name`) values (NULL)',
		},
		expected: {
			type: 'NotNullViolationException',
			message: 'Value for field "name" can\'t be null.',
			extensions: { collection: 'probe_notnull', field: 'name' },
		},
	},
	{
		client: 'mysql',
		scenario: 'contains_null',
		vendors: ['mysql97', 'mysql84', 'mysql5'],
		error: {
			message: 'alter table `probe_alter` modify `note` varchar(255) not null - Invalid use of NULL value',
			code: 'ER_INVALID_USE_OF_NULL',
			errno: 1138,
			sqlMessage: 'Invalid use of NULL value',
			sql: 'alter table `probe_alter` modify `note` varchar(255) not null',
		},
		expected: { type: 'ContainsNullValuesException', message: 'Field "note" contains null values.', extensions: {} },
	},
	{
		client: 'mysql',
		scenario: 'fk_insert',
		vendors: ['mysql97', 'mysql84', 'mysql5', 'maria123', 'maria1011'],
		error: {
			message:
				'insert into `probe_fki_child` (`parent`) values (999) - Cannot add or update a child row: a foreign key constraint fails (`probe`.`probe_fki_child`, CONSTRAINT `probe_fki_child_parent_foreign` FOREIGN KEY (`parent`) REFERENCES `probe_fki_parent` (`id`))',
			code: 'ER_NO_REFERENCED_ROW_2',
			errno: 1452,
			sqlMessage:
				'Cannot add or update a child row: a foreign key constraint fails (`probe`.`probe_fki_child`, CONSTRAINT `probe_fki_child_parent_foreign` FOREIGN KEY (`parent`) REFERENCES `probe_fki_parent` (`id`))',
			sql: 'insert into `probe_fki_child` (`parent`) values (999)',
		},
		expected: {
			type: 'InvalidForeignKeyException',
			message: 'Invalid foreign key in field "parent".',
			extensions: { collection: 'probe_fki_child', field: 'parent', invalid: '999' },
		},
	},
	{
		client: 'mysql',
		scenario: 'fk_delete',
		vendors: ['mysql97', 'mysql84', 'mysql5', 'maria123', 'maria1011'],
		action: 'delete',
		error: {
			message:
				'delete from `probe_fkd_parent` where `id` = 1 - Cannot delete or update a parent row: a foreign key constraint fails (`probe`.`probe_fkd_child`, CONSTRAINT `probe_fkd_child_parent_foreign` FOREIGN KEY (`parent`) REFERENCES `probe_fkd_parent` (`id`))',
			code: 'ER_ROW_IS_REFERENCED_2',
			errno: 1451,
			sqlMessage:
				'Cannot delete or update a parent row: a foreign key constraint fails (`probe`.`probe_fkd_child`, CONSTRAINT `probe_fkd_child_parent_foreign` FOREIGN KEY (`parent`) REFERENCES `probe_fkd_parent` (`id`))',
			sql: 'delete from `probe_fkd_parent` where `id` = 1',
		},
		expected: {
			type: 'RecordStillReferencedException',
			message: "Item can't be deleted because other items still reference it.",
			extensions: {},
		},
	},
	{
		client: 'mysql',
		scenario: 'unique',
		vendors: ['mysql5', 'maria123', 'maria1011'],
		error: {
			message:
				"insert into `probe_unique` (`email`) values ('duplicate@example.com') - Duplicate entry 'duplicate@example.com' for key 'probe_unique_email_unique'",
			code: 'ER_DUP_ENTRY',
			errno: 1062,
			sqlMessage: "Duplicate entry 'duplicate@example.com' for key 'probe_unique_email_unique'",
			sql: "insert into `probe_unique` (`email`) values ('duplicate@example.com')",
		},
		expected: {
			type: 'RecordNotUniqueException',
			message: 'Field "unique_email" has to be unique.',
			extensions: { collection: 'probe', field: 'unique_email', invalid: 'duplicate@example.com' },
		},
	},
	{
		client: 'mysql',
		scenario: 'contains_null',
		vendors: ['maria123', 'maria1011'],
		error: {
			message:
				"alter table `probe_alter` modify `note` varchar(255) not null - Data truncated for column 'note' at row 1",
			code: 'WARN_DATA_TRUNCATED',
			errno: 1265,
			sqlMessage: "Data truncated for column 'note' at row 1",
			sql: 'alter table `probe_alter` modify `note` varchar(255) not null',
		},
		expected: { type: 'ContainsNullValuesException', message: 'Field "note" contains null values.', extensions: {} },
	},
	{
		client: 'sqlite',
		scenario: 'unique',
		vendors: ['sqlite3'],
		error: {
			message:
				"insert into `probe_unique` (`email`) values ('duplicate@example.com') - SQLITE_CONSTRAINT: UNIQUE constraint failed: probe_unique.email",
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		},
		expected: {
			type: 'RecordNotUniqueException',
			message: 'Field "email" has to be unique.',
			extensions: { collection: 'probe_unique', field: 'email' },
		},
	},
	{
		client: 'sqlite',
		scenario: 'not_null',
		vendors: ['sqlite3'],
		error: {
			message:
				'insert into `probe_notnull` (`name`) values (NULL) - SQLITE_CONSTRAINT: NOT NULL constraint failed: probe_notnull.name',
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		},
		expected: {
			type: 'NotNullViolationException',
			message: 'Value for field "name" can\'t be null.',
			extensions: { collection: 'probe_notnull', field: 'name' },
		},
	},
	{
		client: 'sqlite',
		scenario: 'contains_null',
		vendors: ['sqlite3'],
		error: {
			message:
				'INSERT INTO "_knex_temp_alter892" SELECT * FROM "probe_alter"; - SQLITE_CONSTRAINT: NOT NULL constraint failed: _knex_temp_alter892.note',
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		},
		expected: { type: 'ContainsNullValuesException', message: 'Field "note" contains null values.', extensions: {} },
	},
	{
		client: 'sqlite',
		scenario: 'fk_insert',
		vendors: ['sqlite3'],
		error: {
			message:
				'insert into `probe_fki_child` (`parent`) values (999) - SQLITE_CONSTRAINT: FOREIGN KEY constraint failed',
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		},
		expected: { type: 'InvalidForeignKeyException', message: 'Invalid foreign key.', extensions: {} },
	},
	{
		client: 'sqlite',
		scenario: 'fk_delete',
		vendors: ['sqlite3'],
		action: 'delete',
		error: {
			message: 'delete from `probe_fkd_parent` where `id` = 1 - SQLITE_CONSTRAINT: FOREIGN KEY constraint failed',
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		},
		expected: {
			type: 'RecordStillReferencedException',
			message: "Item can't be deleted because other items still reference it.",
			extensions: {},
		},
	},
];
