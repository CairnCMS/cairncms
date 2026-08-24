import { describe, expect, it } from 'vitest';
import { renderConfigPlan } from '../cli/commands/config/render-config-plan.js';
import type { CairnConfig, ConfigPlanChange, ConfigPlanEnrichment, ConfigRole } from '../types/config.js';
import { computeConfigPlan } from './compute-config-plan.js';
import { serializeConfigPlan } from './serialize-config-plan.js';

const NO_ENRICHMENT: ConfigPlanEnrichment = { roleDeletionImpact: new Map(), warnings: [] };

function config(roles: ConfigRole[]): CairnConfig {
	return { manifest: { version: 1, resources: ['roles', 'permissions'] }, roles, permissions: [] };
}

function role(overrides: Partial<ConfigRole>): ConfigRole {
	return { key: 'editor', name: 'editor', admin_access: false, app_access: true, ...overrides };
}

function serialize(current: CairnConfig, desired: CairnConfig) {
	return serializeConfigPlan(computeConfigPlan(current, desired), { enrichment: NO_ENRICHMENT, manifestVersion: 1 });
}

describe('config plan field order', () => {
	it('serializes create values in canonical byte order', () => {
		const serialized = serialize(config([]), config([role({})]));

		const create = serialized.changes.find(
			(change): change is Extract<ConfigPlanChange, { kind: 'roles'; operation: 'create' }> =>
				change.kind === 'roles' && change.operation === 'create'
		);

		if (!create) throw new Error('expected a roles create change');

		expect(JSON.stringify(create.values)).toBe(
			'{"name":"editor","icon":"supervised_user_circle","description":null,"admin_access":false,"app_access":true,"enforce_tfa":false,"ip_access":null}'
		);
	});

	it('renders changed fields in canonical order, not schema order', () => {
		const serialized = serialize(
			config([role({ name: 'A', admin_access: false, icon: 'x' })]),
			config([role({ name: 'B', admin_access: true, icon: 'y' })])
		);

		const update = serialized.changes.find(
			(change): change is Extract<ConfigPlanChange, { kind: 'roles'; operation: 'update' }> =>
				change.kind === 'roles' && change.operation === 'update'
		);

		if (!update) throw new Error('expected a roles update change');

		expect(Object.keys(update.fields)).toEqual(['name', 'icon', 'admin_access']);

		const rendered = renderConfigPlan(serialized);
		expect(rendered.indexOf('name')).toBeLessThan(rendered.indexOf('icon'));
		expect(rendered.indexOf('icon')).toBeLessThan(rendered.indexOf('admin_access'));
	});
});
