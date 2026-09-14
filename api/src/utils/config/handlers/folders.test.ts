import { describe, expect, it } from 'vitest';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import type { ConfigFolder } from '../../../types/config.js';
import type { ValidationContext } from '../descriptor.js';
import { foldersDescriptor } from './folders.js';

const CONTEXT: ValidationContext = {
	rolesManaged: false,
	declaredRoleKeys: new Set<string>(),
	references: 'current-state',
	currentRoleKeys: new Set<string>(),
	currentFolderParents: new Map<string, string | null>(),
};

function contextWith(currentFolderParents: Map<string, string | null>): ValidationContext {
	return {
		rolesManaged: false,
		declaredRoleKeys: new Set<string>(),
		references: 'current-state',
		currentRoleKeys: new Set<string>(),
		currentFolderParents,
	};
}

function folder(key: string, parent: string | null = null): ConfigFolder {
	return { key, name: key, parent };
}

function folderNoParent(key: string): ConfigFolder {
	return { key, name: key };
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

	it('preserves an omitted parent from current state on update', () => {
		const context = contextWith(
			new Map<string, string | null>([
				['root', null],
				['child', 'root'],
			])
		);

		expect(foldersDescriptor.handler.validateDesired([folder('root'), folderNoParent('child')], [], context)).toEqual(
			[]
		);
	});

	it('rejects a cycle formed through a preserved parent', () => {
		const context = contextWith(
			new Map<string, string | null>([
				['a', null],
				['b', 'a'],
			])
		);

		const failures = foldersDescriptor.handler
			.validateDesired([folder('a', 'b'), folderNoParent('b')], [], context)
			.map((failure) => failure.code);

		expect(failures).toEqual(['CONFIG_INVALID']);
	});

	it('treats an omitted parent on a new folder as root', () => {
		expect(foldersDescriptor.handler.validateDesired([folderNoParent('fresh')], [], contextWith(new Map()))).toEqual(
			[]
		);
	});

	it('rejects a self-parent preserved from current state', () => {
		const context = contextWith(new Map<string, string | null>([['a', 'a']]));

		expect(
			foldersDescriptor.handler.validateDesired([folderNoParent('a')], [], context).map((failure) => failure.code)
		).toEqual(['CONFIG_INVALID']);
	});

	it('accepts an explicit null that repairs a self-parent', () => {
		const context = contextWith(new Map<string, string | null>([['a', 'a']]));

		expect(foldersDescriptor.handler.validateDesired([folder('a', null)], [], context)).toEqual([]);
	});

	it('rejects validation when a parent is omitted but current state is missing', () => {
		const context: ValidationContext = {
			rolesManaged: false,
			declaredRoleKeys: new Set<string>(),
			references: 'current-state',
			currentRoleKeys: new Set<string>(),
		};

		let error: unknown;

		try {
			foldersDescriptor.handler.validateDesired([folderNoParent('child')], [], context);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(ConfigReadFailedException);
		expect(error).toMatchObject({ code: 'CONFIG_READ_FAILED' });
		expect((error as Error).message).toContain('current folder state was not supplied');
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
