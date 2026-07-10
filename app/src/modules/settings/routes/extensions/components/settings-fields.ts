import { SECRET_MASK } from '@cairncms/constants';
import formatTitle from '@cairncms/format-title';

export { SECRET_MASK };

export type SettingDeclaration = {
	type: 'string' | 'number' | 'boolean';
	scope?: 'global' | 'collection';
	secret?: { source: 'inline' | 'config' };
	appReadable?: boolean;
	presentation?: { order?: number; width?: 'half' | 'full' };
};

export type SettingsDeclarationMap = Record<string, SettingDeclaration>;

const FIELD_TYPES: Record<SettingDeclaration['type'], string> = {
	string: 'string',
	number: 'float',
	boolean: 'boolean',
};

export function synthesizeSettingsFields(declaration: SettingsDeclarationMap, scope: 'global' | 'collection') {
	const entries = Object.entries(declaration).filter(
		([, decl]) => (decl.scope ?? 'global') === scope && decl.secret?.source !== 'config'
	);

	const sorted = entries
		.map(([key, decl], index) => ({ key, decl, order: decl.presentation?.order ?? index + 1000 }))
		.sort((a, b) => a.order - b.order);

	return sorted.map(({ key, decl }, index) => ({
		field: key,
		name: formatTitle(key),
		type: FIELD_TYPES[decl.type],
		meta: {
			field: key,
			width: decl.presentation?.width ?? 'full',
			sort: index + 1,
			interface:
				decl.secret?.source === 'inline' ? 'system-extension-secret' : decl.type === 'boolean' ? 'boolean' : 'input',
		},
		schema: null,
	}));
}

export function isInlineSecret(declaration: SettingsDeclarationMap, key: string): boolean {
	return declaration[key]?.secret?.source === 'inline';
}
