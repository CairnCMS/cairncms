import type { SchemaOverview } from '@cairncms/types';
import { describe, expect, it, vi } from 'vitest';
import type { AbstractServiceOptions } from '../types/services.js';

vi.mock('../services/index.js', () => {
	class ItemsService {
		constructor(public collection: string, public options: AbstractServiceOptions) {}
	}

	class DashboardsService {
		constructor(public options: AbstractServiceOptions) {}
	}

	class NotificationsService {
		constructor(public options: AbstractServiceOptions) {}
	}

	class OperationsService {
		constructor(public options: AbstractServiceOptions) {}
	}

	class PanelsService {
		constructor(public options: AbstractServiceOptions) {}
	}

	class SharesService {
		constructor(public options: AbstractServiceOptions) {}
	}

	return { ItemsService, DashboardsService, NotificationsService, OperationsService, PanelsService, SharesService };
});

const { resolveTargetService } = await import('./target.js');

const { ItemsService, DashboardsService, NotificationsService, OperationsService, PanelsService, SharesService } =
	await import('../services/index.js');

function schemaWith(...collections: string[]): SchemaOverview {
	return {
		collections: Object.fromEntries(collections.map((c) => [c, { collection: c }])),
	} as unknown as SchemaOverview;
}

const SUPPORTED = [
	'directus_dashboards',
	'directus_notifications',
	'directus_operations',
	'directus_panels',
	'directus_shares',
	'articles',
	'directus_users',
	'cairncms_extension_settings',
];

function resolve(collection: string, admin = false) {
	return resolveTargetService(collection, {
		schema: schemaWith(...SUPPORTED),
		accountability: { user: 'u', role: 'r', admin, app: true } as never,
	});
}

describe('resolveTargetService', () => {
	it('resolves a user collection to ItemsService', () => {
		const service = resolve('articles');
		expect(service).toBeInstanceOf(ItemsService);
		expect((service as unknown as { collection: string }).collection).toBe('articles');
	});

	it('resolves each supported system collection to its dedicated service', () => {
		expect(resolve('directus_dashboards')).toBeInstanceOf(DashboardsService);
		expect(resolve('directus_notifications')).toBeInstanceOf(NotificationsService);
		expect(resolve('directus_operations')).toBeInstanceOf(OperationsService);
		expect(resolve('directus_panels')).toBeInstanceOf(PanelsService);
		expect(resolve('directus_shares')).toBeInstanceOf(SharesService);
	});

	it('denies an internal table, an unsupported system collection, and an unknown name', () => {
		expect(resolve('cairncms_extension_settings')).toBeNull();
		expect(resolve('directus_users')).toBeNull();
		expect(resolve('does_not_exist')).toBeNull();
	});

	it('does not let an admin bypass the denials', () => {
		expect(resolve('cairncms_extension_settings', true)).toBeNull();
		expect(resolve('directus_users', true)).toBeNull();
		expect(resolve('does_not_exist', true)).toBeNull();
	});

	it('treats inherited object keys as absent rather than present', () => {
		expect(resolve('constructor')).toBeNull();
		expect(resolve('toString')).toBeNull();
		expect(resolve('__proto__')).toBeNull();
	});

	it('resolves a real collection even when its name shadows an inherited key', () => {
		const service = resolveTargetService('constructor', {
			schema: schemaWith('constructor'),
			accountability: { user: 'u', role: 'r', admin: false, app: true } as never,
		});

		expect(service).toBeInstanceOf(ItemsService);
	});
});
