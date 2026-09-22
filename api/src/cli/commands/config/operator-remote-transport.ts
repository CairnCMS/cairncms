import type { AxiosInstance } from 'axios';
import { getEnv } from '../../../env.js';
import { ValidatingHttpAgent, ValidatingHttpsAgent } from '../../../request/agent-with-ip-validation.js';
import { canonicalizeIp } from '../../../utils/canonicalize-ip.js';
import { getMilliseconds } from '../../../utils/get-milliseconds.js';
import { replaceControlCharacters } from '../../../utils/safe-log-fragment.js';

export const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

function resolveTimeout(): number {
	const raw = process.env['CAIRNCMS_REMOTE_CONFIG_TIMEOUT'];
	if (raw === undefined || raw.trim() === '') return DEFAULT_REMOTE_TIMEOUT_MS;

	const parsed = getMilliseconds(raw, undefined);

	if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
		throw Object.assign(
			new Error(
				`CAIRNCMS_REMOTE_CONFIG_TIMEOUT must be a positive duration (for example 30000 or "30s"); received "${replaceControlCharacters(
					raw
				)}".`
			),
			{ exitCode: 2 }
		);
	}

	return parsed;
}

/** `--url` may target local services, but explicit deny-list entries still apply to every resolved address. */
export function validateOperatorTargetIp(ip: string, url: string): void {
	const canonical = canonicalizeIp(ip);
	const denyList = getEnv()['IMPORT_IP_DENY_LIST'] as string[];

	for (const entry of denyList) {
		if (entry !== '0.0.0.0' && entry === canonical) {
			throw new Error(`Requested URL "${url}" resolves to a denied IP address`);
		}
	}
}

export async function createOperatorRemoteTransport(): Promise<AxiosInstance> {
	const axios = (await import('axios')).default;
	const { version } = await import('../../../utils/package.js');

	return axios.create({
		httpAgent: new ValidatingHttpAgent({}, validateOperatorTargetIp),
		httpsAgent: new ValidatingHttpsAgent({}, validateOperatorTargetIp),
		maxRedirects: 0,
		timeout: resolveTimeout(),
		proxy: false,
		headers: { 'User-Agent': `cairncms-cli/${version}` },
	});
}
