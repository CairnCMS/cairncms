export const SCHEMA_OPERATIONS = ['create', 'update', 'delete'] as const;

export type SchemaOperation = (typeof SCHEMA_OPERATIONS)[number];

export const SCHEMA_CHANGE_OUTCOMES = ['applied', 'reverted', 'unknown', 'not_applicable'] as const;

export type SchemaChangeOutcome = (typeof SCHEMA_CHANGE_OUTCOMES)[number];

export type SchemaPersistedCollection = {
	collection: string;
	operation: SchemaOperation;
	table: SchemaChangeOutcome;
	metadata: SchemaChangeOutcome;
};

export type SchemaPersistedField = {
	collection: string;
	field: string;
	operation: SchemaOperation;
	column: SchemaChangeOutcome;
	metadata: SchemaChangeOutcome;
};

export type SchemaPersistedRelation = {
	collection: string;
	field: string;
	operation: SchemaOperation;
	foreignKey: 'unknown';
	metadata: SchemaChangeOutcome;
};

export type SchemaPersistedState = {
	collections: SchemaPersistedCollection[];
	fields: SchemaPersistedField[];
	relations: SchemaPersistedRelation[];
};
