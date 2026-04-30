import { v4 as uuid } from 'uuid';

export interface GeneratedSecrets {
	KEY: string;
	SECRET: string;
	DB_PASSWORD: string;
	ADMIN_PASSWORD: string;
}

export default async function generateSecrets(): Promise<GeneratedSecrets> {
	const { nanoid } = await import('nanoid');

	return {
		KEY: uuid(),
		SECRET: nanoid(32),
		DB_PASSWORD: nanoid(32),
		ADMIN_PASSWORD: nanoid(16),
	};
}
