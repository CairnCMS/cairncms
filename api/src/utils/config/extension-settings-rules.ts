export type SettingValueProblem = 'type' | 'finite';

export function checkSettingValue(declaredType: string, value: unknown): SettingValueProblem | undefined {
	if (typeof value !== declaredType) return 'type';
	if (declaredType === 'number' && Number.isFinite(value) === false) return 'finite';
	return undefined;
}

export type SettingScopeProblem = 'scope' | 'global-key' | 'collection-key';

export function checkSettingScope(
	scope: string,
	scopeKey: string,
	collectionExists: (name: string) => boolean
): SettingScopeProblem | undefined {
	if (scope !== 'global' && scope !== 'collection') return 'scope';
	if (scope === 'global' && scopeKey !== '') return 'global-key';
	if (scope === 'collection' && (scopeKey === '' || collectionExists(scopeKey) === false)) return 'collection-key';
	return undefined;
}
