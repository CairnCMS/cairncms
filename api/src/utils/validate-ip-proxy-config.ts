import express from 'express';
import { validateHeaderName } from 'node:http';
import { getEnv } from '../env.js';

/** The env loader leaves comma-list array entries untrimmed, while Express only trims string input. */
export function normalizeTrustProxy(value: unknown): unknown {
	return Array.isArray(value) ? value.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)) : value;
}

export function validateIpProxyConfig(): void {
	const env = getEnv();

	const customHeader = env['IP_CUSTOM_HEADER'];

	if (customHeader !== false) {
		if (typeof customHeader !== 'string') {
			throw new Error('"IP_CUSTOM_HEADER" must be false or a valid HTTP header name');
		}

		try {
			validateHeaderName(customHeader);
		} catch {
			throw new Error('"IP_CUSTOM_HEADER" must be false or a valid HTTP header name');
		}
	}

	try {
		express().set('trust proxy', normalizeTrustProxy(env['IP_TRUST_PROXY']));
	} catch (error) {
		throw new Error(`"IP_TRUST_PROXY" is invalid: ${(error as Error).message}`);
	}
}
