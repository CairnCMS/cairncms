import { describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import type { ConfigTranslationsAuthored } from '../../../types/config.js';
import type { ValidationContext } from '../descriptor.js';
import { translationsDescriptor } from './translations.js';

const descriptor = translationsDescriptor;

function context(references: 'current-state' | 'server-snapshot'): ValidationContext {
	const base = {
		rolesManaged: false,
		declaredRoleKeys: new Set<string>(),
		foldersManaged: false,
		declaredFolderKeys: new Set<string>(),
	};

	return references === 'server-snapshot'
		? { ...base, references: 'server-snapshot' }
		: { ...base, references: 'current-state', currentRoleKeys: new Set(), currentFolderKeys: new Set() };
}

function validate(
	documents: ConfigTranslationsAuthored[],
	references: 'current-state' | 'server-snapshot' = 'current-state'
) {
	const { records } = descriptor.projectDocuments(documents);
	return descriptor.handler.validateDesired(documents, records as never, context(references));
}

describe('translations projectDocuments and composeDocuments', () => {
	it('round-trips ordinary, dotted, mixed-case, and empty keys per language', () => {
		const documents: ConfigTranslationsAuthored[] = [
			{ language: 'fr-FR', translations: { hello: 'Bonjour', 'a.b.c': 'point', MixedCase: 'M', '': 'empty-key' } },
			{ language: 'de-DE', translations: { hello: 'Hallo' } },
		];

		const { records, anchors } = descriptor.projectDocuments(documents);

		expect(records).toHaveLength(5);

		const composed = descriptor.composeDocuments(records, anchors);

		expect(composed).toEqual([
			{ language: 'fr-FR', translations: { hello: 'Bonjour', 'a.b.c': 'point', MixedCase: 'M', '': 'empty-key' } },
			{ language: 'de-DE', translations: { hello: 'Hallo' } },
		]);
	});

	it('keeps an empty-language document as an anchor that contributes no tuples', () => {
		const documents: ConfigTranslationsAuthored[] = [{ language: 'fr-FR', translations: {} }, { language: 'de-DE' }];

		const { records, anchors } = descriptor.projectDocuments(documents);

		expect(records).toHaveLength(0);
		expect(anchors).toEqual([{ language: 'fr-FR' }, { language: 'de-DE' }]);

		const composed = descriptor.composeDocuments(records, anchors);

		expect(composed).toEqual([
			{ language: 'fr-FR', translations: {} },
			{ language: 'de-DE', translations: {} },
		]);
	});

	it('preserves a prototype-sensitive key as data without polluting Object.prototype', () => {
		const map = JSON.parse('{"__proto__": "own-value", "constructor": "c"}') as Record<string, string>;
		const documents: ConfigTranslationsAuthored[] = [{ language: 'fr-FR', translations: map }];

		const { records, anchors } = descriptor.projectDocuments(documents);
		const [composed] = descriptor.composeDocuments(records, anchors);

		expect(Object.getPrototypeOf(composed!.translations)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(composed!.translations, '__proto__')?.value).toBe('own-value');
		expect(composed!.translations['constructor']).toBe('c');
		expect(({} as Record<string, unknown>)['own-value']).toBeUndefined();
		expect((Object.prototype as Record<string, unknown>)['__proto__']).not.toBe('own-value');
	});
});

describe('translations validateDesired', () => {
	it('accepts a catalogue language with arbitrary keys', () => {
		expect(validate([{ language: 'fr-FR', translations: { hello: 'Bonjour', '': '' } }])).toEqual([]);
	});

	it('accepts an empty-language document', () => {
		expect(validate([{ language: 'en-US', translations: {} }])).toEqual([]);
		expect(validate([{ language: 'en-US' }])).toEqual([]);
	});

	it('refuses an unknown top-level field in both modes', () => {
		const doc = { language: 'fr-FR', translations: { a: 'b' }, extra: 'x' } as unknown as ConfigTranslationsAuthored;

		expect(validate([doc], 'current-state').map((f) => f.code)).toContain('CONFIG_INVALID');
		expect(validate([doc], 'server-snapshot').map((f) => f.code)).toContain('CONFIG_INVALID');
	});

	it('refuses a non-string leaf value', () => {
		const doc = { language: 'fr-FR', translations: { a: 5 } } as unknown as ConfigTranslationsAuthored;

		expect(validate([doc]).map((f) => f.code)).toContain('CONFIG_INVALID');
	});

	it('reports a duplicate language as an identity conflict', () => {
		const failures = validate([
			{ language: 'fr-FR', translations: { a: '1' } },
			{ language: 'fr-FR', translations: { b: '2' } },
		]);

		expect(failures.map((f) => f.code)).toContain('CONFIG_IDENTITY_CONFLICT');
	});

	it('refuses a filename-safe but non-catalogue language in both modes', () => {
		const doc: ConfigTranslationsAuthored = { language: 'made-up', translations: { a: 'b' } };

		expect(validate([doc], 'current-state').map((f) => f.code)).toContain('CONFIG_INVALID');
		expect(validate([doc], 'server-snapshot').map((f) => f.code)).toContain('CONFIG_INVALID');
	});

	it('refuses a case variant of a catalogue language', () => {
		expect(validate([{ language: 'fr-fr', translations: { a: 'b' } }]).map((f) => f.code)).toContain('CONFIG_INVALID');
	});

	it('accepts a key at the storage length limit and refuses one over it in both modes', () => {
		const atLimit = 'a'.repeat(255);
		const overLimit = 'a'.repeat(256);

		expect(validate([{ language: 'fr-FR', translations: { [atLimit]: 'v' } }])).toEqual([]);

		expect(
			validate([{ language: 'fr-FR', translations: { [overLimit]: 'v' } }], 'current-state').map((f) => f.code)
		).toContain('CONFIG_INVALID');

		expect(
			validate([{ language: 'fr-FR', translations: { [overLimit]: 'v' } }], 'server-snapshot').map((f) => f.code)
		).toContain('CONFIG_INVALID');
	});
});

describe('translations projectReadState ordering', () => {
	const precomposedAcute = String.fromCharCode(0xe9);
	const decomposedAcute = `e${String.fromCharCode(0x301)}`;

	it('produces an order-independent projection for keys that collate equal but differ by code unit', () => {
		const first = { language: 'fr-FR', key: precomposedAcute, value: '1' };
		const second = { language: 'fr-FR', key: decomposedAcute, value: '2' };
		const documentIdentities = [{ language: 'fr-FR' }];

		const forward = descriptor.handler.projectReadState(
			{ records: [first, second], documentIdentities, dependencyState: undefined },
			'full'
		);

		const reversed = descriptor.handler.projectReadState(
			{ records: [second, first], documentIdentities, dependencyState: undefined },
			'full'
		);

		expect(forward.identities).toHaveLength(2);
		expect(forward).toEqual(reversed);
	});
});

describe('translations parseDocumentFile', () => {
	const parse = descriptor.layout.parseDocumentFile;

	it('parses a literal locale file whose language matches its filename', () => {
		expect(parse({ language: 'fr-FR', translations: { hello: 'Bonjour' } }, 'fr-FR.yaml')).toEqual({
			language: 'fr-FR',
			translations: { hello: 'Bonjour' },
		});
	});

	it('refuses a file whose inner language disagrees with its filename', () => {
		expect(() => parse({ language: 'de-DE', translations: {} }, 'fr-FR.yaml')).toThrow(ConfigInvalidException);
	});

	it('refuses an unknown top-level field', () => {
		expect(() => parse({ language: 'fr-FR', translations: {}, extra: 1 }, 'fr-FR.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('refuses a non-string leaf value', () => {
		expect(() => parse({ language: 'fr-FR', translations: { a: 3 } }, 'fr-FR.yaml')).toThrow(ConfigInvalidException);
	});

	it('does not enforce catalogue membership, which is a separate validation concern', () => {
		expect(parse({ language: 'made-up', translations: { a: 'b' } }, 'made-up.yaml')).toEqual({
			language: 'made-up',
			translations: { a: 'b' },
		});
	});

	it('preserves a prototype-sensitive key from a parsed record without pollution', () => {
		const record = JSON.parse('{"language": "fr-FR", "translations": {"__proto__": "own"}}') as Record<string, unknown>;
		const parsed = parse(record, 'fr-FR.yaml');

		expect(Object.getOwnPropertyDescriptor(parsed.translations, '__proto__')?.value).toBe('own');
		expect(Object.getPrototypeOf(parsed.translations)).toBe(Object.prototype);
	});
});
