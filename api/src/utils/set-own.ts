import { isObject, setWith } from 'lodash-es';

/**
 * Same as lodash `set`, except that an intermediate segment naming an inherited property, such as `toString`,
 * gets a new own plain object instead of writing into the inherited value.
 */
export function setOwn<T extends object>(object: T, path: string | string[], value: unknown): T {
	return setWith(object, path, value, (objValue, key, nested) =>
		isObject(objValue) && !Object.hasOwn(nested, key) ? {} : undefined
	);
}
