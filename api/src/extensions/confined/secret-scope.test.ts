import { describe, expect, it } from 'vitest';
import { ConfinedSecretScope } from './secret-scope.js';

describe('ConfinedSecretScope', () => {
	it('mints distinct opaque tokens and lists them for redaction', () => {
		const scope = new ConfinedSecretScope();

		const a = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });
		const b = scope.mint({ kind: 'extension-setting', extensionId: 'e', contributionId: 'c', key: 'token' });

		expect(a).not.toBe(b);
		expect(typeof a).toBe('string');
		expect(scope.refs().sort()).toEqual([a, b].sort());
	});

	it('detects a minted token embedded in a string, and ignores unknown strings', () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });

		expect(scope.containsRef(ref)).toBe(true);
		expect(scope.containsRef(`Bearer ${ref}`)).toBe(true);
		expect(scope.containsRef('an unrelated value')).toBe(false);
	});

	it('does not recognize a token minted in a different scope', () => {
		const one = new ConfinedSecretScope();
		const two = new ConfinedSecretScope();
		const ref = one.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });

		expect(two.containsRef(ref)).toBe(false);
		expect(two.resolve(ref)).toBeUndefined();
	});

	it('resolves a minted token to its binding and a forged token to undefined', () => {
		const scope = new ConfinedSecretScope();
		const binding = { kind: 'extension-setting', extensionId: 'e', contributionId: 'c', key: 'token' } as const;
		const ref = scope.mint(binding);

		expect(scope.resolve(ref)).toEqual(binding);
		expect(scope.resolve('forged-token')).toBeUndefined();
	});

	it('carries resolved real values in the redaction set alongside the tokens', () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });

		scope.registerResolved('sk_live_real_secret');
		scope.registerResolved('');

		expect(scope.resolvedSecrets()).toEqual(['sk_live_real_secret']);
		expect(scope.redactionValues().sort()).toEqual([ref, 'sk_live_real_secret'].sort());
	});
});
