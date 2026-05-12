import { Agent as HttpAgent } from 'node:http';
import type { AgentOptions as HttpAgentOptions } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { AgentOptions as HttpsAgentOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { validateIPSync } from './validate-ip.js';

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

type LookupOptions = Parameters<typeof dnsLookup>[1];

export function validatingLookup(
	hostname: string,
	optionsOrCallback: LookupOptions | LookupCallback,
	maybeCallback?: LookupCallback
) {
	const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as any;
	const lookupOpts = (typeof optionsOrCallback === 'function' ? {} : optionsOrCallback) as LookupOptions;
	const wantsAll = (lookupOpts as { all?: boolean })?.all === true;

	(dnsLookup as any)(hostname, lookupOpts, (err: NodeJS.ErrnoException | null, address: any, family?: number) => {
		if (err) return callback(err);

		try {
			if (wantsAll) {
				const list = Array.isArray(address) ? address : [{ address, family }];

				for (const entry of list) {
					validateIPSync(entry.address, hostname);
				}

				callback(null, list);
			} else {
				validateIPSync(address, hostname);
				callback(null, address, family);
			}
		} catch (validationErr) {
			callback(validationErr as NodeJS.ErrnoException);
		}
	});
}

// Sync is load-bearing: async validation would let connect(2) fire before the deny check.
export function preValidateIpLiteral(options: { host?: string; hostname?: string; href?: string }): Error | null {
	const host = options.host ?? options.hostname;
	if (typeof host !== 'string' || isIP(host) === 0) return null;

	const url = (options.href as string | undefined) ?? String(host);

	try {
		validateIPSync(host, url);
		return null;
	} catch (err) {
		return err as Error;
	}
}

export class ValidatingHttpAgent extends HttpAgent {
	constructor(options: HttpAgentOptions = {}) {
		super({ ...options, lookup: validatingLookup as HttpAgentOptions['lookup'] });
	}

	override createConnection(options: any, callback: any): any {
		const err = preValidateIpLiteral(options);

		if (err) {
			process.nextTick(() => callback(err));
			return undefined;
		}

		return super.createConnection(options, callback);
	}
}

export class ValidatingHttpsAgent extends HttpsAgent {
	constructor(options: HttpsAgentOptions = {}) {
		super({ ...options, lookup: validatingLookup as HttpsAgentOptions['lookup'] });
	}

	override createConnection(options: any, callback: any): any {
		const err = preValidateIpLiteral(options);

		if (err) {
			process.nextTick(() => callback(err));
			return undefined;
		}

		return super.createConnection(options, callback);
	}
}
