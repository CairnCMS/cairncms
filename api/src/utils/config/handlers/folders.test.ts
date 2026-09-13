import { describe, expect, it } from 'vitest';
import type { ConfigFolder } from '../../../types/config.js';
import type { ValidationContext } from '../descriptor.js';
import { foldersDescriptor } from './folders.js';

const CONTEXT = {
	rolesManaged: false,
	declaredRoleKeys: new Set<string>(),
	references: 'current-state',
	currentRoleKeys: new Set<string>(),
} as ValidationContext;

function folder(key: string, parent: string | null = null): ConfigFolder {
	return { key, name: key, parent };
}

function validate(documents: ConfigFolder[]) {
	return foldersDescriptor.handler.validateDesired(documents, documents, CONTEXT);
}

function codes(documents: ConfigFolder[]): string[] {
	return validate(documents).map((failure) => failure.code);
}

describe('folders validateDesired', () => {
	it('accepts an acyclic tree whose parents all resolve against the desired set', () => {
		expect(validate([folder('root'), folder('child', 'root'), folder('grandchild', 'child')])).toEqual([]);
	});

	it('rejects a duplicate key with CONFIG_IDENTITY_CONFLICT', () => {
		expect(codes([folder('docs'), folder('docs')])).toEqual(['CONFIG_IDENTITY_CONFLICT']);
	});

	it('rejects a folder that is its own parent', () => {
		expect(codes([folder('loop', 'loop')])).toEqual(['CONFIG_INVALID']);
	});

	it('rejects a parent that is not a managed folder', () => {
		expect(codes([folder('child', 'missing')])).toEqual(['CONFIG_INVALID']);
	});

	it('rejects a parent cycle and reports it once', () => {
		const failures = codes([folder('a', 'b'), folder('b', 'c'), folder('c', 'a')]);
		expect(failures).toEqual(['CONFIG_INVALID']);
	});

	it('reports a cycle once even when another folder feeds into it', () => {
		const failures = codes([folder('a', 'b'), folder('b', 'c'), folder('c', 'a'), folder('d', 'a')]);
		expect(failures).toEqual(['CONFIG_INVALID']);
	});

	it('reports two distinct cycles separately', () => {
		const failures = codes([folder('a', 'b'), folder('b', 'a'), folder('x', 'y'), folder('y', 'x')]);
		expect(failures).toEqual(['CONFIG_INVALID', 'CONFIG_INVALID']);
	});

	it('allows a root folder with a null parent', () => {
		expect(validate([folder('root', null)])).toEqual([]);
	});
});

describe('folders descriptor', () => {
	it('identifies documents and files by key', () => {
		expect(foldersDescriptor.layout.documentIdentityOf(folder('docs'))).toEqual({ key: 'docs' });
		expect(foldersDescriptor.layout.filenameOf({ key: 'docs' })).toBe('docs');
		expect(foldersDescriptor.identityOf(folder('docs'))).toEqual({ key: 'docs' });
	});

	it('requires a folder file to be named for its key', () => {
		expect(() => foldersDescriptor.layout.parseDocumentFile({ key: 'docs', name: 'Docs' }, 'other.yaml')).toThrow();

		expect(foldersDescriptor.layout.parseDocumentFile({ key: 'docs', name: 'Docs' }, 'docs.yaml')).toMatchObject({
			key: 'docs',
			name: 'Docs',
		});
	});

	it('canonicalizes a record to its name and parent', () => {
		expect(foldersDescriptor.canonicalizeValues(folder('docs', 'root'))).toEqual({ name: 'docs', parent: 'root' });
	});

	it('requires manifest version 2', () => {
		expect(foldersDescriptor.formatVersion).toBe(2);
	});
});
