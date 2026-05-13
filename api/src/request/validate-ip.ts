import ipaddr from 'ipaddr.js';
import os from 'node:os';
import { getEnv } from '../env.js';

function canonicalize(ip: string): string {
	try {
		const parsed = ipaddr.parse(ip);

		if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
			return (parsed as ipaddr.IPv6).toIPv4Address().toString();
		}

		return ip;
	} catch {
		return ip;
	}
}

function isLoopback(ip: string): boolean {
	try {
		return ipaddr.parse(ip).range() === 'loopback';
	} catch {
		return false;
	}
}

export function validateIPSync(ip: string, url: string): void {
	const env = getEnv();
	const canonical = canonicalize(ip);

	if (env['IMPORT_IP_DENY_LIST'].includes(canonical)) {
		throw new Error(`Requested URL "${url}" resolves to a denied IP address`);
	}

	if (env['IMPORT_IP_DENY_LIST'].includes('0.0.0.0')) {
		if (isLoopback(canonical)) {
			throw new Error(`Requested URL "${url}" resolves to a denied IP address`);
		}

		const networkInterfaces = os.networkInterfaces();

		for (const networkInfo of Object.values(networkInterfaces)) {
			if (!networkInfo) continue;

			for (const info of networkInfo) {
				if (info.address === canonical) {
					throw new Error(`Requested URL "${url}" resolves to a denied IP address`);
				}
			}
		}
	}
}

export const validateIP = async (ip: string, url: string) => validateIPSync(ip, url);
