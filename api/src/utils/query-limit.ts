/** Normalizes QUERY_LIMIT_DEFAULT / QUERY_LIMIT_MAX. `-1` means "unlimited" for both;
 * `effectiveDefault` is the limit an option-less query runs at. */

import env from '../env.js';
import { type BoundedSpec, type ConfigParseError, isUnset, parseCount } from './parse-config.js';

export const QUERY_LIMIT_UNLIMITED = -1;

// server_info.queryLimit is exposed as GraphQLInt, so a configured limit must stay within its signed 32-bit range.
const GRAPHQL_INT_MAX = 2_147_483_647;

export interface QueryLimitConfig {
	default: number;
	max: number;
	effectiveDefault: number;
}

export type QueryLimitConfigResult = { ok: true; config: QueryLimitConfig } | { ok: false; error: ConfigParseError };

const DEFAULT_SPEC: BoundedSpec = {
	envVar: 'QUERY_LIMIT_DEFAULT',
	defaultValue: 100,
	floor: 0,
	ceiling: GRAPHQL_INT_MAX,
};

const MAX_SPEC: BoundedSpec = {
	envVar: 'QUERY_LIMIT_MAX',
	defaultValue: QUERY_LIMIT_UNLIMITED,
	floor: 1,
	ceiling: GRAPHQL_INT_MAX,
};

function isUnlimitedSentinel(raw: unknown): boolean {
	return raw === QUERY_LIMIT_UNLIMITED || (typeof raw === 'string' && raw.trim() === String(QUERY_LIMIT_UNLIMITED));
}

function parseLimit(
	raw: unknown,
	spec: BoundedSpec,
	unsetValue: number
): { ok: true; value: number } | { ok: false; error: ConfigParseError } {
	if (isUnset(raw)) return { ok: true, value: unsetValue };
	if (isUnlimitedSentinel(raw)) return { ok: true, value: QUERY_LIMIT_UNLIMITED };

	const result = parseCount(raw, spec);
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, value: result.value };
}

function computeEffectiveDefault(defaultValue: number, max: number): number {
	if (max === QUERY_LIMIT_UNLIMITED) return defaultValue;
	if (defaultValue === QUERY_LIMIT_UNLIMITED) return max;
	return Math.min(defaultValue, max);
}

export function resolveQueryLimitConfig(source: Record<string, any>): QueryLimitConfigResult {
	const parsedDefault = parseLimit(source['QUERY_LIMIT_DEFAULT'], DEFAULT_SPEC, DEFAULT_SPEC.defaultValue);
	if (!parsedDefault.ok) return { ok: false, error: parsedDefault.error };

	const parsedMax = parseLimit(source['QUERY_LIMIT_MAX'], MAX_SPEC, QUERY_LIMIT_UNLIMITED);
	if (!parsedMax.ok) return { ok: false, error: parsedMax.error };

	return {
		ok: true,
		config: {
			default: parsedDefault.value,
			max: parsedMax.value,
			effectiveDefault: computeEffectiveDefault(parsedDefault.value, parsedMax.value),
		},
	};
}

export function getQueryLimitConfig(source: Record<string, any>): QueryLimitConfig {
	const result = resolveQueryLimitConfig(source);
	if (!result.ok) throw new Error(result.error.message);
	return result.config;
}

export function hasFiniteMax(config: QueryLimitConfig): boolean {
	return config.max !== QUERY_LIMIT_UNLIMITED;
}

export function validateQueryLimitConfig(): void {
	const result = resolveQueryLimitConfig(env);
	if (!result.ok) throw new Error(result.error.message);
}
