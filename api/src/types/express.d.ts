/**
 * Custom properties on the req object in express
 */

import { Accountability, Query, SchemaOverview } from '@cairncms/types';

export {};

declare global {
	namespace Express {
		export interface Request {
			token: string | null;
			collection: string;
			sanitizedQuery: Query;
			schema: SchemaOverview;

			accountability?: Accountability;
			singleton?: boolean;
		}
	}
}
