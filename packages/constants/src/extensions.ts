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

export const RequestCapabilitySchema = z
	.object({
		methods: z.array(HttpMethodSchema).optional(),
		urls: z.array(z.string()).min(1),
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

function requireConfinedForCapabilities(value: { runtime?: unknown; capabilities?: unknown }, ctx: z.RefinementCtx) {
	if (value.capabilities !== undefined && value.runtime !== CONFINED_RUNTIME) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['capabilities'],
			message: `capabilities require runtime: ${CONFINED_RUNTIME}`,
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

const BUNDLE_SERVER_ENTRY_TYPES = new Set<string>([...API_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES]);

export const ExtensionOptionsBundleEntry = z.union([
	z
		.object({
			type: z.enum(APP_EXTENSION_TYPES),
			name: z.string(),
			source: z.string(),
			runtime: ConfinedRuntimeSchema.optional(),
			capabilities: ExtensionCapabilitiesSchema.optional(),
		})
		.superRefine((value, ctx) => {
			rejectBundleEntryRuntime(value, ctx);

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
		})
		.superRefine(rejectBundleEntryRuntime),
	z
		.object({
			type: z.enum(HYBRID_EXTENSION_TYPES),
			name: z.string(),
			source: SplitEntrypoint,
			runtime: ConfinedRuntimeSchema.optional(),
			capabilities: ExtensionCapabilitiesSchema.optional(),
		})
		.superRefine(rejectBundleEntryRuntime),
]);

export const ExtensionOptionsBase = z.object({
	host: z.string(),
	hidden: z.boolean().optional(),
});

export const ExtensionOptionsApp = z
	.object({
		type: z.enum(APP_EXTENSION_TYPES),
		path: z.string(),
		source: z.string(),
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
	})
	.superRefine((value, ctx) => rejectConfinedDeclaration(value, ctx, 'app extension types'));

export const ExtensionOptionsApi = z
	.object({
		type: z.enum(API_EXTENSION_TYPES),
		path: z.string(),
		source: z.string(),
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
	})
	.superRefine(requireConfinedForCapabilities);

export const ExtensionOptionsHybrid = z
	.object({
		type: z.enum(HYBRID_EXTENSION_TYPES),
		path: SplitEntrypoint,
		source: SplitEntrypoint,
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
	})
	.superRefine(requireConfinedForCapabilities);

export const ExtensionOptionsBundle = z
	.object({
		type: z.literal('bundle'),
		path: SplitEntrypoint,
		entries: z.array(ExtensionOptionsBundleEntry),
		runtime: ConfinedRuntimeSchema.optional(),
		capabilities: ExtensionCapabilitiesSchema.optional(),
	})
	.superRefine((value, ctx) => {
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

		const hasServerEntry = value.entries.some((entry) => BUNDLE_SERVER_ENTRY_TYPES.has(entry.type));

		if (value.runtime === CONFINED_RUNTIME && !hasServerEntry) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['runtime'],
				message: `a ${CONFINED_RUNTIME} bundle must declare at least one server entry`,
			});
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
