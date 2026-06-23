import { z } from 'zod';

export const APP_SHARED_DEPS = ['@cairncms/extensions-sdk', 'vue', 'vue-router', 'vue-i18n', 'pinia'];
export const API_SHARED_DEPS = ['cairncms'];

export const APP_EXTENSION_TYPES = ['interface', 'display', 'layout', 'module', 'panel'] as const;
export const API_EXTENSION_TYPES = ['hook', 'endpoint'] as const;
export const HYBRID_EXTENSION_TYPES = ['operation'] as const;
export const BUNDLE_EXTENSION_TYPES = ['bundle'] as const;
export const EXTENSION_TYPES = [
	...APP_EXTENSION_TYPES,
	...API_EXTENSION_TYPES,
	...HYBRID_EXTENSION_TYPES,
	...BUNDLE_EXTENSION_TYPES,
] as const;
export const NESTED_EXTENSION_TYPES = [
	...APP_EXTENSION_TYPES,
	...API_EXTENSION_TYPES,
	...HYBRID_EXTENSION_TYPES,
] as const;
export const APP_OR_HYBRID_EXTENSION_TYPES = [...APP_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES] as const;
export const APP_OR_HYBRID_EXTENSION_PACKAGE_TYPES = [
	...APP_OR_HYBRID_EXTENSION_TYPES,
	...BUNDLE_EXTENSION_TYPES,
] as const;

export const EXTENSION_LANGUAGES = ['javascript', 'typescript'] as const;

export const EXTENSION_NAME_REGEX = /^(?:(?:@[^/]+\/)?cairncms-extension-|@cairncms\/extension-)(.+)$/;

export const EXTENSION_PKG_KEY = 'cairncms:extension';

export const SplitEntrypoint = z.object({
	app: z.string(),
	api: z.string(),
});

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export const HttpMethodSchema = z.enum(HTTP_METHODS);

// URL is a runtime global in every supported environment (Node and the browser),
// but this package compiles without DOM or Node type libraries, so the
// constructor is declared minimally here. Validating with the same WHATWG parser
// the runtime matches with keeps the schema and the broker in agreement.
declare const URL: new (input: string) => {
	protocol: string;
	username: string;
	password: string;
	pathname: string;
	search: string;
	hash: string;
};

// The runtime matches request urls by origin equality only, so a path-bearing
// entry would read as a narrowed grant while silently granting the whole origin.
// Entries must therefore state the real grant: a bare http or https origin.
function isOriginOnlyUrl(entry: string): boolean {
	let url: InstanceType<typeof URL>;

	try {
		url = new URL(entry);
	} catch {
		return false;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (url.username !== '' || url.password !== '') return false;
	if (url.pathname !== '/' && url.pathname !== '') return false;
	if (url.search !== '' || url.hash !== '') return false;

	return true;
}

export const RequestCapabilitySchema = z
	.object({
		methods: z.array(HttpMethodSchema).optional(),
		urls: z
			.array(
				z.string().refine(isOriginOnlyUrl, {
					message:
						'a request capability url must be a bare http or https origin, with no path, query, fragment, or credentials',
				})
			)
			.min(1),
	})
	.strict();

// Raw powers such as fs, process.env, database access, child processes, and internal imports
// must not be smuggled in as capability keys, so unknown keys are rejected rather than ignored.
// items and files are accountability modes, not per-collection grants. Per-collection and
// per-field access stays with CairnCMS roles and permissions.
export const ExtensionCapabilitiesSchema = z
	.object({
		log: z.boolean(),
		request: RequestCapabilitySchema,
		template: z.boolean(),
		endpoint: z.object({ access: z.enum(['public', 'authenticated']) }).strict(),
		items: z.enum(['current-user', 'system']),
		files: z.enum(['current-user', 'system']),
		schema: z.array(z.enum(['read', 'write'])).min(1),
		secrets: z.boolean(),
		settings: z.array(z.enum(['read', 'write'])).min(1),
		jobs: z.boolean(),
	})
	.partial()
	.strict();

// Per-key delivery for a confined operation's sensitive options. A declared key
// reaches the guest only as an opaque reference the host resolves on brokered use,
// never as a clear configured value, while an undeclared key is an ordinary JSON
// option. Only 'reference' is defined: a host-side 'brokered' mode with no guest
// handle has no operation consumer yet.
export const ConfinedOptionDeliverySchema = z.record(z.object({ delivery: z.enum(['reference']) }).strict());

// Exact platform event names a confined hook subscribes to, declared in the
// manifest so the subscription surface is operator-reviewable without reading
// code. Exact names only: no wildcard, no pattern, bounded count and length.
const CONFINED_EVENT_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/;

const CONFINED_EVENTS_MAX = 16;

// The platform emitter (EventEmitter2, wildcard mode) grows its listener tree as
// plain objects keyed by the dot-delimited event segments, `tree[segment] ||
// (tree[segment] = {})`. A segment naming an Object.prototype member resolves to an
// inherited object instead of a fresh branch, and `_listeners` collides with the
// node's own listener key, so either pollutes shared globals and aliases unrelated
// events. A name with such a segment in any position is refused, so the declared
// subscription surface is exactly what the operator reviewed.
function isReservedEventSegment(segment: string): boolean {
	return (
		segment.length === 0 || segment === '_listeners' || Object.prototype.hasOwnProperty.call(Object.prototype, segment)
	);
}

// Segment safety only, not the full event grammar: the schema composes this after
// the regex and length checks, and the manager reuses it purely as a reserved-
// segment guard on names already grammar-validated at the gate.
export function hasSafeEventSegments(name: string): boolean {
	return name.split('.').every((segment) => !isReservedEventSegment(segment));
}

const ConfinedEventNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(CONFINED_EVENT_NAME)
	.refine(hasSafeEventSegments, { message: 'an event name segment may not be a reserved object or emitter key' });

const ConfinedEventListSchema = z
	.array(ConfinedEventNameSchema)
	.min(1)
	.max(CONFINED_EVENTS_MAX)
	.refine((names) => new Set(names).size === names.length, { message: 'event names must be unique' });

export const ConfinedHookEventsSchema = z
	.object({
		filter: ConfinedEventListSchema.optional(),
		action: ConfinedEventListSchema.optional(),
	})
	.strict()
	.refine((value) => value.filter !== undefined || value.action !== undefined, {
		message: 'events must declare at least one filter or action list',
	});

export const CONFINED_RUNTIME = 'confined-server';

export const ConfinedRuntimeSchema = z.literal(CONFINED_RUNTIME);

function rejectConfinedDeclaration(
	value: { runtime?: unknown; capabilities?: unknown },
	ctx: z.RefinementCtx,
	subject: string
) {
	if (value.runtime !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['runtime'],
			message: `${subject} may not declare a server runtime`,
		});
	}

	if (value.capabilities !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['capabilities'],
			message: `${subject} may not declare capabilities`,
		});
	}
}

function requireConfinedForCapabilities(
	value: { runtime?: unknown; capabilities?: unknown; optionDelivery?: unknown },
	ctx: z.RefinementCtx
) {
	if (value.capabilities !== undefined && value.runtime !== CONFINED_RUNTIME) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['capabilities'],
			message: `capabilities require runtime: ${CONFINED_RUNTIME}`,
		});
	}

	if (value.optionDelivery !== undefined && value.runtime !== CONFINED_RUNTIME) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['optionDelivery'],
			message: `optionDelivery requires runtime: ${CONFINED_RUNTIME}`,
		});
	}
}

// A bundle declares runtime once, at the bundle. A runtime on an entry is
// rejected rather than stripped, so a confined intent on a single entry cannot be
// silently dropped and loaded full-authority.
function rejectBundleEntryRuntime(value: { runtime?: unknown }, ctx: z.RefinementCtx) {
	if (value.runtime !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['runtime'],
			message: `a bundle entry may not declare a runtime, declare runtime: ${CONFINED_RUNTIME} on the bundle`,
		});
	}
}

/**
 * Rejects a misplaced optionDelivery declaration. The unsupported schemas capture
 * the field rather than strip it, so a sensitive-option declaration in the wrong
 * place fails closed here instead of vanishing and reaching the guest clear.
 */
function rejectOptionDelivery(value: { optionDelivery?: unknown }, ctx: z.RefinementCtx, subject: string) {
	if (value.optionDelivery !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['optionDelivery'],
			message: `${subject} may not declare optionDelivery`,
		});
	}
}

/**
 * Rejects a misplaced events declaration the same way: captured rather than
 * stripped, so a subscription declared in the wrong place fails closed instead
 * of vanishing.
 */
function rejectHookEvents(value: { events?: unknown }, ctx: z.RefinementCtx, subject: string) {
	if (value.events !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['events'],
			message: `${subject} may not declare events`,
		});
	}
}

export const ExtensionOptionsBundleEntry = z.union([
	z
		.object({
			type: z.enum(APP_EXTENSION_TYPES),
			name: z.string(),
			source: z.string(),
			runtime: ConfinedRuntimeSchema.optional(),
			capabilities: ExtensionCapabilitiesSchema.optional(),
			optionDelivery: z.unknown().optional(),
			events: z.unknown().optional(),
		})
		.superRefine((value, ctx) => {
			rejectBundleEntryRuntime(value, ctx);
			rejectOptionDelivery(value, ctx, 'app entries in a bundle');
			rejectHookEvents(value, ctx, 'app entries in a bundle');

			if (value.capabilities !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['capabilities'],
					message: 'app entries in a bundle may not declare capabilities',
				});
			}
		}),
	z
		.object({
			type: z.enum(API_EXTENSION_TYPES),
			name: z.string(),
			source: z.string(),
			runtime: ConfinedRuntimeSchema.optional(),
			capabilities: ExtensionCapabilitiesSchema.optional(),
			optionDelivery: z.unknown().optional(),
			events: ConfinedHookEventsSchema.optional(),
		})
		.superRefine((value, ctx) => {
			rejectBundleEntryRuntime(value, ctx);
			rejectOptionDelivery(value, ctx, 'endpoint and hook entries in a bundle');

			// A hook entry declares its events like a top-level hook; an endpoint entry
			// may not, so a misplaced subscription fails closed rather than vanishing.
			// Whether a hook entry is required to declare events depends on the bundle
			// root runtime, so that rule lives in the bundle refine, not here.
			if (value.events !== undefined && value.type !== 'hook') {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['events'],
					message: 'only a hook entry in a bundle may declare events',
				});
			}
		}),
	z
		.object({
			type: z.enum(HYBRID_EXTENSION_TYPES),
			name: z.string(),
			source: SplitEntrypoint,
			runtime: ConfinedRuntimeSchema.optional(),
			capabilities: ExtensionCapabilitiesSchema.optional(),
			optionDelivery: ConfinedOptionDeliverySchema.optional(),
			events: z.unknown().optional(),
		})
		.superRefine((value, ctx) => {
			rejectBundleEntryRuntime(value, ctx);
			rejectHookEvents(value, ctx, 'a bundle operation entry');
		}),
]);

export const ExtensionSettingDeclaration = z
	.object({
		type: z.enum(['string', 'number', 'boolean']),
		scope: z.enum(['global', 'collection']),
		sensitive: z.boolean().optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.sensitive === true && value.type !== 'string') {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['type'],
				message: 'a sensitive setting must be type string',
			});
		}
	});

const RESERVED_SETTING_KEYS = ['__proto__', 'constructor', 'prototype'];

export const ExtensionSettingKeySchema = z
	.string()
	.regex(/^[a-z][a-z0-9_]*$/)
	.max(64)
	.refine((key) => RESERVED_SETTING_KEYS.includes(key) === false, {
		message: 'a settings key must not be a reserved property name',
	});

export const ExtensionSettingsSchema = z
	.record(ExtensionSettingKeySchema, ExtensionSettingDeclaration)
	.refine((value) => Object.keys(value).length > 0, {
		message: 'a settings declaration must declare at least one key',
	});

export const ExtensionSettingsSubjectSchema = z.string().regex(EXTENSION_NAME_REGEX).max(255);

export const ExtensionSecretPointerSchema = z
	.object({
		source: z.literal('config'),
		name: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
			.max(128),
	})
	.strict();

export const ExtensionOptionsBase = z.object({
	host: z.string(),
	hidden: z.boolean().optional(),
	settings: ExtensionSettingsSchema.optional(),
});

export const ExtensionOptionsApp = z
	.object({
		type: z.enum(APP_EXTENSION_TYPES),
		path: z.string(),
		source: z.string(),
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
		optionDelivery: z.unknown().optional(),
		events: z.unknown().optional(),
	})
	.superRefine((value, ctx) => {
		rejectConfinedDeclaration(value, ctx, 'app extension types');
		rejectOptionDelivery(value, ctx, 'app extension types');
		rejectHookEvents(value, ctx, 'app extension types');
	});

export const ExtensionOptionsApi = z
	.object({
		type: z.enum(API_EXTENSION_TYPES),
		path: z.string(),
		source: z.string(),
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
		optionDelivery: z.unknown().optional(),
		events: ConfinedHookEventsSchema.optional(),
	})
	.superRefine((value, ctx) => {
		requireConfinedForCapabilities(value, ctx);
		rejectOptionDelivery(value, ctx, 'endpoint and hook extensions');

		if (value.events !== undefined && value.type !== 'hook') {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['events'],
				message: 'only a hook extension may declare events',
			});
		}

		if (value.events !== undefined && value.runtime !== CONFINED_RUNTIME) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['events'],
				message: `events require runtime: ${CONFINED_RUNTIME}`,
			});
		}
	});

export const ExtensionOptionsHybrid = z
	.object({
		type: z.enum(HYBRID_EXTENSION_TYPES),
		path: SplitEntrypoint,
		source: SplitEntrypoint,
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
		optionDelivery: ConfinedOptionDeliverySchema.optional(),
		events: z.unknown().optional(),
	})
	.superRefine((value, ctx) => {
		requireConfinedForCapabilities(value, ctx);
		rejectHookEvents(value, ctx, 'an operation extension');
	});

export const ExtensionOptionsBundle = z
	.object({
		type: z.literal('bundle'),
		path: SplitEntrypoint,
		entries: z.array(ExtensionOptionsBundleEntry),
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
		optionDelivery: z.unknown().optional(),
		events: z.unknown().optional(),
	})
	.superRefine((value, ctx) => {
		rejectOptionDelivery(value, ctx, 'a bundle root');
		rejectHookEvents(value, ctx, 'a bundle root');

		if (value.capabilities !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['capabilities'],
				message: 'a bundle declares capabilities on its server entries, not at the bundle root',
			});
		}

		const entryDeclaresCapabilities = value.entries.some(
			(entry) => 'capabilities' in entry && entry.capabilities !== undefined
		);

		if (entryDeclaresCapabilities && value.runtime !== CONFINED_RUNTIME) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['runtime'],
				message: `a bundle entry declares capabilities, so the bundle must declare runtime: ${CONFINED_RUNTIME}`,
			});
		}

		const entryDeclaresEvents = value.entries.some((entry) => 'events' in entry && entry.events !== undefined);

		if (entryDeclaresEvents && value.runtime !== CONFINED_RUNTIME) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['runtime'],
				message: `a bundle entry declares events, so the bundle must declare runtime: ${CONFINED_RUNTIME}`,
			});
		}

		const entryDeclaresOptionDelivery = value.entries.some(
			(entry) => 'optionDelivery' in entry && entry.optionDelivery !== undefined
		);

		if (entryDeclaresOptionDelivery && value.runtime !== CONFINED_RUNTIME) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['runtime'],
				message: `a bundle entry declares optionDelivery, so the bundle must declare runtime: ${CONFINED_RUNTIME}`,
			});
		}

		// A confined hook is inert without a subscription, so a confined bundle's hook
		// entries must declare events. An inherited bundle hook needs no declaration, so
		// this applies only under the confined runtime.
		if (value.runtime === CONFINED_RUNTIME) {
			const inertHook = value.entries.some((entry) => entry.type === 'hook' && entry.events === undefined);

			if (inertHook) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['entries'],
					message: 'a hook entry in a confined bundle must declare events',
				});
			}
		}
	});

export const ExtensionOptionsBundleEntries = z.array(ExtensionOptionsBundleEntry);

export const ExtensionOptions = ExtensionOptionsBase.and(
	z.union([ExtensionOptionsApp, ExtensionOptionsApi, ExtensionOptionsHybrid, ExtensionOptionsBundle])
);

export const ExtensionManifest = z.object({
	name: z.string(),
	version: z.string(),
	type: z.union([z.literal('module'), z.literal('commonjs')]).optional(),
	dependencies: z.record(z.string()).optional(),
	[EXTENSION_PKG_KEY]: ExtensionOptions,
});
