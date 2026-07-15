export const UUID_REGEX = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const UUID_SHAPE = new RegExp(`^${UUID_REGEX}$`, 'i');

export function isValidUuid(value: string): boolean {
	return UUID_SHAPE.test(value);
}
