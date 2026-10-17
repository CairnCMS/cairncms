export type SchemaOperation = 'create' | 'update' | 'delete';

export type SchemaChangeOutcome = 'applied' | 'reverted' | 'unknown' | 'not_applicable';

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
