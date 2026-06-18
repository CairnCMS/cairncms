import { describe, expect, it } from 'vitest';
import { prepareOperationOptions } from './operation-options.js';
import { ConfinedSecretScope } from './secret-scope.js';

const DELIVERY = { apiKey: { delivery: 'reference' as const } };

function ok(result: ReturnType<typeof prepareOperationOptions>) {
	if (!result.ok) throw new Error(`expected ok, got failure on ${result.key}`);
	return result;
}

describe('prepareOperationOptions', () => {
	it('replaces a declared reference key with an opaque handle and keeps the clear value out of band', () => {
		const scope = new ConfinedSecretScope();

		const result = ok(
			prepareOperationOptions('op-1', { channel: 'general', apiKey: 'sk_live_real_token' }, DELIVERY, scope)
		);

		expect(result.childOptions['channel']).toBe('general');
		expect(result.childOptions['apiKey']).toMatchObject({ kind: 'secret-reference' });
		expect(result.referenceValues).toEqual({ apiKey: 'sk_live_real_token' });

		// The guest's options never carry the clear secret.
		expect(JSON.stringify(result.childOptions)).not.toContain('sk_live_real_token');
	});

	it('mints a handle bound to this operation and key, resolvable in the scope', () => {
		const scope = new ConfinedSecretScope();
		const result = ok(prepareOperationOptions('op-1', { apiKey: 'sk_live_token' }, DELIVERY, scope));

		const ref = (result.childOptions['apiKey'] as { ref: string }).ref;

		expect(scope.refs()).toContain(ref);
		expect(scope.resolve(ref)).toEqual({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });
	});

	it('mints a distinct handle per reference key', () => {
		const scope = new ConfinedSecretScope();

		const result = ok(
			prepareOperationOptions(
				'op-1',
				{ apiKey: 'token-a', webhookSecret: 'token-b' },
				{ apiKey: { delivery: 'reference' }, webhookSecret: { delivery: 'reference' } },
				scope
			)
		);

		const a = (result.childOptions['apiKey'] as { ref: string }).ref;
		const b = (result.childOptions['webhookSecret'] as { ref: string }).ref;

		expect(a).not.toBe(b);
		expect(result.referenceValues).toEqual({ apiKey: 'token-a', webhookSecret: 'token-b' });
	});

	it('omits an absent, null, or blank reference value rather than minting a handle', () => {
		const scope = new ConfinedSecretScope();

		for (const value of [null, undefined, '']) {
			const result = ok(prepareOperationOptions('op-1', { channel: 'general', apiKey: value }, DELIVERY, scope));
			expect('apiKey' in result.childOptions, String(value)).toBe(false);
			expect(result.referenceValues).toEqual({});
		}

		expect(scope.refs()).toHaveLength(0);
	});

	it('fails closed when a declared reference value is present but not a string', () => {
		const scope = new ConfinedSecretScope();

		const result = prepareOperationOptions('op-1', { apiKey: 12345 }, DELIVERY, scope);

		expect(result).toEqual({ ok: false, key: 'apiKey' });
		expect(scope.refs()).toHaveLength(0);
	});

	it('passes every key through clear when nothing is declared a reference', () => {
		const scope = new ConfinedSecretScope();
		const options = { channel: 'general', count: 3, flag: true };

		const result = ok(prepareOperationOptions('op-1', options, undefined, scope));

		expect({ ...result.childOptions }).toEqual(options);
		expect(result.referenceValues).toEqual({});
		expect(scope.refs()).toHaveLength(0);
	});

	it('keeps a __proto__ option key an ordinary own property in both paths', () => {
		const scope = new ConfinedSecretScope();

		// As a passthrough key.
		const passthrough = ok(prepareOperationOptions('op-1', JSON.parse('{"__proto__":"x"}'), undefined, scope));
		expect(Object.prototype.hasOwnProperty.call(passthrough.childOptions, '__proto__')).toBe(true);
		expect(JSON.parse(JSON.stringify(passthrough.childOptions))['__proto__']).toBe('x');

		// As a declared reference key. The delivery and options both arrive as parsed
		// JSON, where `__proto__` is an ordinary own key, not the literal-syntax proto.
		const reference = ok(
			prepareOperationOptions(
				'op-1',
				JSON.parse('{"__proto__":"sk_secret"}'),
				JSON.parse('{"__proto__":{"delivery":"reference"}}'),
				scope
			)
		);

		expect(Object.prototype.hasOwnProperty.call(reference.childOptions, '__proto__')).toBe(true);
		expect((reference.childOptions as Record<string, { kind?: string }>)['__proto__']?.kind).toBe('secret-reference');
		expect(Object.prototype.hasOwnProperty.call(reference.referenceValues, '__proto__')).toBe(true);
	});
});
