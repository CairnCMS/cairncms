import { Agent as HttpAgent } from 'node:http';
import type { AgentOptions as HttpAgentOptions } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { AgentOptions as HttpsAgentOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { validateIPSync } from './validate-ip.js';

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

type LookupOptions = Parameters<typeof dnsLookup>[1];

export type IpValidator = (ip: string, url: string) => void;

export function makeValidatingLookup(validate: IpValidator = validateIPSync) {
	return function validatingLookup(
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
						validate(entry.address, hostname);
					}

					callback(null, list);
				} else {
					validate(address, hostname);
					callback(null, address, family);
				}
			} catch (validationErr) {
				callback(validationErr as NodeJS.ErrnoException);
			}
		});
	};
}

export const validatingLookup = makeValidatingLookup();

// Sync is load-bearing: async validation would let connect(2) fire before the deny check.
export function preValidateIpLiteral(
	options: { host?: string; hostname?: string; href?: string },
	validate: IpValidator = validateIPSync
): Error | null {
	const host = options.host ?? options.hostname;
	if (typeof host !== 'string' || isIP(host) === 0) return null;

	const url = (options.href as string | undefined) ?? String(host);

	try {
		validate(host, url);
		return null;
	} catch (err) {
		return err as Error;
	}
}

export class ValidatingHttpAgent extends HttpAgent {
	private readonly validate: IpValidator;

	constructor(options: HttpAgentOptions = {}, validate: IpValidator = validateIPSync) {
		const lookup = validate === validateIPSync ? validatingLookup : makeValidatingLookup(validate);
		super({ ...options, lookup: lookup as HttpAgentOptions['lookup'] });
		this.validate = validate;
	}

	override createConnection(options: any, callback: any): any {
		const err = preValidateIpLiteral(options, this.validate);

		if (err) {
			process.nextTick(() => callback(err));
			return undefined;
		}

		return super.createConnection(options, callback);
	}
}

export class ValidatingHttpsAgent extends HttpsAgent {
	private readonly validate: IpValidator;

	constructor(options: HttpsAgentOptions = {}, validate: IpValidator = validateIPSync) {
		const lookup = validate === validateIPSync ? validatingLookup : makeValidatingLookup(validate);
		super({ ...options, lookup: lookup as HttpsAgentOptions['lookup'] });
		this.validate = validate;
	}

	override createConnection(options: any, callback: any): any {
		const err = preValidateIpLiteral(options, this.validate);

		if (err) {
			process.nextTick(() => callback(err));
			return undefined;
		}

		return super.createConnection(options, callback);
	}
}
