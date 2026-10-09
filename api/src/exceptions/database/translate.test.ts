import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDatabaseClient } from '../../database/index.js';
import { translateDatabaseError } from './translate.js';

vi.mock('../../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn(),
}));

const foreignKeyErrors: Record<string, () => any> = {
	postgres: () =>
		Object.assign(new Error('violates foreign key constraint "posts_author_foreign" on table "posts"'), {
			code: '23503',
			detail: 'Key (id)=(1) is still referenced from table "posts".',
			table: 'posts',
		}),
	mysql: () =>
		Object.assign(new Error('Cannot add or update a child row: a foreign key constraint fails'), {
			code: 'ER_NO_REFERENCED_ROW_2',
			sqlMessage:
				'Cannot add or update a child row: a foreign key constraint fails (`db`.`posts`, CONSTRAINT `posts_author_foreign` FOREIGN KEY (`author`) REFERENCES `authors` (`id`))',
			sql: 'insert into `posts` (`author`) values (?)',
		}),
	sqlite: () =>
		Object.assign(new Error('insert into `posts` - SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'), {
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		}),
};

const referencedErrors: Record<string, () => any> = {
	postgres: () =>
		Object.assign(new Error('update or delete on table "authors" violates foreign key constraint'), {
			code: '23503',
			detail: 'Key (id)=(1) is still referenced from table "posts".',
			table: 'posts',
		}),
	mysql: () =>
		Object.assign(new Error('Cannot delete or update a parent row: a foreign key constraint fails'), {
			code: 'ER_ROW_IS_REFERENCED_2',
			errno: 1451,
		}),
	sqlite: () =>
		Object.assign(new Error('delete from `authors` - SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'), {
			code: 'SQLITE_CONSTRAINT',
			errno: 19,
		}),
};

describe('translateDatabaseError', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it.each(['postgres', 'mysql', 'sqlite'])(
		'%s maps a foreign-key error during a delete to RECORD_STILL_REFERENCED',
		async (client) => {
			vi.mocked(getDatabaseClient).mockReturnValue(client as any);

			const result = await translateDatabaseError(referencedErrors[client]!(), 'delete');

			expect(result.code).toBe('RECORD_STILL_REFERENCED');
			expect(result.status).toBe(400);
			expect(result.extensions).toEqual({});
		}
	);

	it.each(['postgres', 'sqlite'])(
		'%s keeps a foreign-key error without the delete action as INVALID_FOREIGN_KEY',
		async (client) => {
			vi.mocked(getDatabaseClient).mockReturnValue(client as any);

			const result = await translateDatabaseError(foreignKeyErrors[client]!());

			expect(result.code).toBe('INVALID_FOREIGN_KEY');
			expect(result.status).toBe(400);
		}
	);

	it('maps a child foreign-key insert error to INVALID_FOREIGN_KEY on mysql', async () => {
		vi.mocked(getDatabaseClient).mockReturnValue('mysql');

		const result = await translateDatabaseError(foreignKeyErrors['mysql']!());

		expect(result.code).toBe('INVALID_FOREIGN_KEY');
	});
});
