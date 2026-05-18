import type { LogicalFilterAND, LogicalFilterOR, Permission } from '@cairncms/types';
import { flatten, intersection, isEqual, merge, omit } from 'lodash-es';

export function mergePermissions(strategy: 'and' | 'or', ...permissions: Permission[][]): Permission[] {
	const allPermissions = flatten(permissions);

	const mergedPermissions = allPermissions
		.reduce((acc, val) => {
			const key = `${val.collection}__${val.action}__${val.role}`;
			const current = acc.get(key);
			acc.set(key, current ? mergePermission(strategy, current, val) : val);
			return acc;
		}, new Map())
		.values();

	return Array.from(mergedPermissions);
}

function validationParts(validation: Permission['validation']): unknown[] {
	if (!validation || typeof validation !== 'object') return [];
	const keys = Object.keys(validation);

	if (keys[0] === '_and' && Array.isArray((validation as LogicalFilterAND)['_and'])) {
		return (validation as LogicalFilterAND)['_and'];
	}

	return [validation];
}

export function mergePermission(
	strategy: 'and' | 'or',
	currentPerm: Permission,
	newPerm: Permission
): Omit<Permission, 'id' | 'system'> {
	const logicalKey = `_${strategy}` as keyof LogicalFilterOR | keyof LogicalFilterAND;

	let permissions = currentPerm.permissions;
	let validation = currentPerm.validation;
	let fields = currentPerm.fields;
	let presets = currentPerm.presets;

	if (newPerm.permissions) {
		if (currentPerm.permissions && Object.keys(currentPerm.permissions)[0] === logicalKey) {
			permissions = {
				[logicalKey]: [
					...(currentPerm.permissions as LogicalFilterOR & LogicalFilterAND)[logicalKey],
					newPerm.permissions,
				],
			} as LogicalFilterAND | LogicalFilterOR;
		} else if (currentPerm.permissions) {
			// Empty {} supersedes other permissions in _OR merge
			if (strategy === 'or' && (isEqual(currentPerm.permissions, {}) || isEqual(newPerm.permissions, {}))) {
				permissions = {};
			} else {
				permissions = {
					[logicalKey]: [currentPerm.permissions, newPerm.permissions],
				} as LogicalFilterAND | LogicalFilterOR;
			}
		} else {
			permissions = {
				[logicalKey]: [newPerm.permissions],
			} as LogicalFilterAND | LogicalFilterOR;
		}
	}

	const newValidationEmpty = !newPerm.validation || isEqual(newPerm.validation, {});
	const currentValidationEmpty = !currentPerm.validation || isEqual(currentPerm.validation, {});

	if (!newValidationEmpty) {
		if (currentValidationEmpty) {
			validation = newPerm.validation;
		} else {
			const parts = [...validationParts(currentPerm.validation), ...validationParts(newPerm.validation)];
			validation = { _and: parts } as LogicalFilterAND;
		}
	}

	if (newPerm.fields) {
		if (Array.isArray(currentPerm.fields) && strategy === 'or') {
			fields = [...new Set([...currentPerm.fields, ...newPerm.fields])];
		} else if (Array.isArray(currentPerm.fields) && strategy === 'and') {
			fields = intersection(currentPerm.fields, newPerm.fields);
		} else {
			fields = newPerm.fields;
		}

		if (fields.includes('*')) fields = ['*'];
	}

	if (newPerm.presets) {
		presets = merge({}, presets, newPerm.presets);
	}

	return omit(
		{
			...currentPerm,
			permissions,
			validation,
			fields,
			presets,
		},
		['id', 'system']
	);
}
