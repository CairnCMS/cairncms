import { isInternalTable } from '../database/internal-tables.js';
import {
	DashboardsService,
	ItemsService,
	NotificationsService,
	OperationsService,
	PanelsService,
	SharesService,
} from '../services/index.js';
import type { AbstractServiceOptions } from '../types/services.js';

type ServiceFactory = (options: AbstractServiceOptions) => ItemsService;

const SUPPORTED_SYSTEM_COLLECTIONS = new Map<string, ServiceFactory>([
	['directus_dashboards', (options) => new DashboardsService(options)],
	['directus_notifications', (options) => new NotificationsService(options)],
	['directus_operations', (options) => new OperationsService(options)],
	['directus_panels', (options) => new PanelsService(options)],
	['directus_shares', (options) => new SharesService(options)],
]);

export function resolveTargetService(collection: string, options: AbstractServiceOptions): ItemsService | null {
	if (isInternalTable(collection)) return null;
	if (!Object.hasOwn(options.schema.collections, collection)) return null;

	const factory = SUPPORTED_SYSTEM_COLLECTIONS.get(collection);
	if (factory !== undefined) return factory(options);

	if (collection.startsWith('directus_')) return null;

	return new ItemsService(collection, options);
}
