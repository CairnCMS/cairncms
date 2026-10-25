import { describe, expect, it } from 'vitest';
import type { ConfigFolder, ConfigPlan } from '../types/config.js';
import { assertFolderPreparationCreationsOnly, buildFolderPreparationPlan } from './folder-preparation.js';

function folder(key: string, parent?: string): ConfigFolder {
	return { key, name: key, ...(parent === undefined ? {} : { parent }) };
}

function build(input: { referenced: string[]; declared: ConfigFolder[]; current?: string[] }): ConfigPlan {
	return buildFolderPreparationPlan({
		referencedKeys: new Set(input.referenced),
		declaredFolders: input.declared,
		currentFolderKeys: new Set(input.current ?? []),
	});
}

describe('buildFolderPreparationPlan', () => {
	it('creates a referenced folder the target lacks', () => {
		const plan = build({ referenced: ['uploads'], declared: [folder('uploads')] });

		expect(plan.folders.create).toEqual([folder('uploads')]);
		expect(plan.managedResources).toEqual(['folders']);
	});

	it('does not create a referenced folder already on the target', () => {
		const plan = build({ referenced: ['uploads'], declared: [folder('uploads')], current: ['uploads'] });

		expect(plan.folders.create).toEqual([]);
	});

	it('does not create a referenced folder with no declared definition', () => {
		const plan = build({ referenced: ['ghost'], declared: [] });

		expect(plan.folders.create).toEqual([]);
	});

	it('creates a missing declared parent before its child', () => {
		const plan = build({ referenced: ['child'], declared: [folder('child', 'parent'), folder('parent')] });

		expect(plan.folders.create.map((entry) => entry.key)).toEqual(['parent', 'child']);
	});

	it('creates a chain of new parents before the referenced folder', () => {
		const plan = build({
			referenced: ['leaf'],
			declared: [folder('leaf', 'branch'), folder('branch', 'root'), folder('root')],
		});

		expect(plan.folders.create.map((entry) => entry.key)).toEqual(['root', 'branch', 'leaf']);
	});

	it('stops the ancestor walk at a parent already on the target', () => {
		const plan = build({
			referenced: ['child'],
			declared: [folder('child', 'parent'), folder('parent')],
			current: ['parent'],
		});

		expect(plan.folders.create).toEqual([folder('child', 'parent')]);
	});

	it('leaves every slice other than folder creation empty', () => {
		const plan = build({ referenced: ['uploads'], declared: [folder('uploads')] });

		expect(plan.folders.update).toEqual([]);
		expect(plan.folders.delete).toEqual([]);
		expect(plan.roles.create).toEqual([]);
		expect(plan.permissions.create).toEqual([]);
		expect(plan.schema.create).toEqual([]);
		expect(plan.protections).toEqual([]);
	});
});

describe('assertFolderPreparationCreationsOnly', () => {
	const base = build({ referenced: ['uploads'], declared: [folder('uploads')] });

	it('accepts a folders-only creation plan', () => {
		expect(() => assertFolderPreparationCreationsOnly(base)).not.toThrow();
	});

	it('refuses a plan carrying a folder update', () => {
		const plan: ConfigPlan = { ...base, folders: { ...base.folders, update: [{ key: 'uploads', changes: {} }] } };

		expect(() => assertFolderPreparationCreationsOnly(plan)).toThrow(/other than folder creation/);
	});

	it('refuses a plan carrying a folder deletion', () => {
		const plan: ConfigPlan = { ...base, folders: { ...base.folders, delete: ['uploads'] } };

		expect(() => assertFolderPreparationCreationsOnly(plan)).toThrow(/other than folder creation/);
	});

	it('refuses a plan carrying a creation in another kind', () => {
		const plan: ConfigPlan = {
			...base,
			translations: {
				...base.translations,
				create: [{ identity: { language: 'en-US', key: 'greeting' }, value: 'Hello' }],
			},
		};

		expect(() => assertFolderPreparationCreationsOnly(plan)).toThrow(/other than folder creation/);
	});

	it('refuses a plan carrying a protection', () => {
		const plan: ConfigPlan = {
			...base,
			protections: [{ code: 'ADMIN_CONTINUITY_REQUIRED', message: 'x', contributors: [] }],
		};

		expect(() => assertFolderPreparationCreationsOnly(plan)).toThrow(/protection/);
	});
});
