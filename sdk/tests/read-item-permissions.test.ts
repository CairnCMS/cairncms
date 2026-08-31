import { describe, expect, it } from 'vitest';
import { readItemPermissions } from '../src/rest/commands/read/permissions.js';

describe('readItemPermissions path construction', () => {
	it('treats a numeric key 0 as a key rather than dropping it', () => {
		expect(readItemPermissions('articles', 0)().path).toBe('/permissions/me/articles/0');
	});

	it('includes a string key in the path', () => {
		expect(readItemPermissions('articles', 'abc')().path).toBe('/permissions/me/articles/abc');
	});

	it('omits the key segment when no key is provided', () => {
		expect(readItemPermissions('articles')().path).toBe('/permissions/me/articles');
	});

	it('rejects an explicit empty-string key', () => {
		expect(() => readItemPermissions('articles', '')()).toThrow('Key cannot be empty');
	});
});
