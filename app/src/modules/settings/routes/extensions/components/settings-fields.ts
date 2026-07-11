import { SECRET_MASK } from '@cairncms/constants';
import formatTitle from '@cairncms/format-title';

export { SECRET_MASK };

export type SettingDeclaration = {
	type: 'string' | 'number' | 'boolean';
	scope?: 'global' | 'collection';
	secret?: { source: 'inline' | 'config' };
	appReadable?: boolean;
	presentation?: { order?: number; width?: 'half' | 'full'; interface?: 'system-display-template' };
};

export type SettingsDeclarationMap = Record<string, SettingDeclaration>;

const FIELD_TYPES: Record<SettingDeclaration['type'], string> = {
	string: 'string',
	number: 'float',
	boolean: 'boolean',
};

// The contextual options are synthesized here, never taken from the declaration, so a
// manifest cannot steer which collection an interface reads.
function fieldInterface(
	decl: SettingDeclaration,
	collection: string | undefined
): { interface: string; options?: Record<string, unknown> } {
	if (decl.secret?.source === 'inline') return { interface: 'system-extension-secret' };

	if (decl.presentation?.interface === 'system-display-template' && collection !== undefined) {
		return { interface: 'system-display-template', options: { collectionName: collection } };
	}

	if (decl.type === 'boolean') return { interface: 'boolean' };

	return { interface: 'input' };
}

export function synthesizeSettingsFields(
	declaration: SettingsDeclarationMap,
	scope: 'global' | 'collection',
	collection?: string
) {
	const entries = Object.entries(declaration).filter(
		([, decl]) => (decl.scope ?? 'global') === scope && decl.secret?.source !== 'config'
	);

	const sorted = entries
		.map(([key, decl], index) => ({ key, decl, order: decl.presentation?.order ?? index + 1000 }))
		.sort((a, b) => a.order - b.order);

	return sorted.map(({ key, decl }, index) => {
		const { interface: fieldInterfaceId, options } = fieldInterface(
			decl,
			scope === 'collection' ? collection : undefined
		);

		return {
			field: key,
			name: formatTitle(key),
			type: FIELD_TYPES[decl.type],
			meta: {
				field: key,
				width: decl.presentation?.width ?? 'full',
				sort: index + 1,
				interface: fieldInterfaceId,
				...(options && { options }),
			},
			schema: null,
		};
	});
}

export function isInlineSecret(declaration: SettingsDeclarationMap, key: string): boolean {
	return declaration[key]?.secret?.source === 'inline';
}
