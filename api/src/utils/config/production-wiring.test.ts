import { describe, expect, it, vi } from 'vitest';

// The sentinel distinguishes live production wiring from behavioral equivalence with another schema authority.
vi.mock('./field-schema.js', async () => {
	const Joi = (await import('joi')).default;
	return { buildDocumentSchema: () => Joi.object({ __sentinel__: Joi.boolean().required() }) };
});

const { validateConfigRecord } = await import('../validate-desired-config.js');

describe('validate-desired-config consumes the generated schema', () => {
	it('routes both kinds through buildDocumentSchema', () => {
		expect(validateConfigRecord('roles', {})).toContain('"__sentinel__" is required');
		expect(validateConfigRecord('permissions', {})).toContain('"__sentinel__" is required');
	});
});
