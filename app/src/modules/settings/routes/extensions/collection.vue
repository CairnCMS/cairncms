<template>
	<private-view :title="t('settings_extensions')">
		<template #headline><v-breadcrumb :items="[{ name: t('settings'), to: '/settings' }]" /></template>

		<template #title-outer:prepend>
			<v-button class="header-icon" rounded icon exact disabled>
				<v-icon name="brick" />
			</v-button>
		</template>

		<template #navigation>
			<settings-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail icon="info" :title="t('information')" close>
				<div v-md="t('page_help_settings_extensions_collection')" class="page-description" />
			</sidebar-detail>
		</template>

		<div v-if="loading" class="loading">
			<v-progress-circular indeterminate />
		</div>

		<v-notice v-else-if="error" type="danger" class="error">{{ error }}</v-notice>

		<v-info v-else-if="extensions.length === 0" icon="brick" :title="t('no_extensions')" center>
			{{ t('no_extensions_copy') }}
		</v-info>

		<div v-else class="extensions">
			<div class="summary">
				<span class="stat">
					<display-color value="var(--success)" />
					<span class="count">{{ normalCount }}</span>
					{{ t('extension_health_normal') }}
				</span>
				<span v-if="warningCount > 0" class="stat">
					<display-color value="var(--warning)" />
					<span class="count">{{ warningCount }}</span>
					{{ t('extension_health_warning', warningCount) }}
				</span>
				<span v-if="failedCount > 0" class="stat">
					<display-color value="var(--danger)" />
					<span class="count">{{ failedCount }}</span>
					{{ t('extension_health_failed') }}
				</span>
			</div>

			<v-notice
				v-if="confinedRuntime && confinedRuntime.state === 'unavailable'"
				type="warning"
				class="sandbox-warning"
			>
				{{ t('confined_runtime_unavailable') }}
			</v-notice>

			<v-detail v-for="group in groups" :key="group.type" start-open class="group">
				<template #activator="{ toggle, active }">
					<v-divider :inline-title="false" large class="group-head" @click="toggle">
						<template #icon><v-icon :name="typeIcon(group.type)" /></template>
						<span class="group-name">{{ groupLabel(group.type) }}</span>
						<v-chip class="group-count" x-small>{{ group.items.length }}</v-chip>
						<v-icon class="expand-icon" :name="active ? 'expand_more' : 'chevron_right'" />
					</v-divider>
				</template>

				<v-list-item
					v-for="extension in group.items"
					:key="extension._key"
					block
					clickable
					@click="selected = extension"
				>
					<v-list-item-icon>
						<display-color :value="rowHealthColor(extension)" />
					</v-list-item-icon>
					<v-list-item-content>
						<v-text-overflow :text="extensionIdentity(extension.name).title" />
						<v-text-overflow
							v-if="extensionIdentity(extension.name).title !== extension.name"
							class="package-name"
							:text="extension.name"
						/>
					</v-list-item-content>
					<v-chip v-if="extension.runtime === 'confined-server'" class="sandboxed" small label>
						{{ t('extension_sandboxed') }}
					</v-chip>
					<v-chip v-if="extension.version" class="version" small label>{{ extension.version }}</v-chip>
					<extension-options v-if="extension.settings" @open-settings="settingsTarget = extension" />
				</v-list-item>
			</v-detail>

			<v-detail v-if="confinedRuntime && confinedRuntime.posture" class="advanced-diagnostics">
				<template #activator="{ toggle, active }">
					<v-divider :inline-title="false" large class="group-head" @click="toggle">
						<template #icon><v-icon name="shield" /></template>
						<span class="group-name">{{ t('extension_advanced_diagnostics') }}</span>
						<v-icon class="expand-icon" :name="active ? 'expand_more' : 'chevron_right'" />
					</v-divider>
				</template>

				<div class="confined-runtime">
					<div class="detail-label">{{ t('confined_runtime') }}</div>
					<div class="cr-posture">
						<span class="cr-mode">
							{{
								t('confined_runtime_mode', {
									decision: confinedRuntime.posture.decision,
									mode: confinedRuntime.posture.mode,
								})
							}}
						</span>
						<div class="capability-chips">
							<span v-for="layer in confinedRuntime.posture.applied" :key="layer" class="capability-chip layer-applied">
								<v-icon name="check" x-small />
								{{ layer }}
							</span>
							<span v-for="layer in confinedRuntime.posture.missing" :key="layer" class="capability-chip layer-missing">
								<v-icon name="close" x-small />
								{{ layer }}
							</span>
						</div>
					</div>
				</div>
			</v-detail>
		</div>

		<v-dialog
			:model-value="selected !== null"
			placement="center"
			@update:model-value="selected = null"
			@esc="selected = null"
		>
			<v-card v-if="selected">
				<v-card-title>
					<div class="detail-title">
						<div>{{ extensionIdentity(selected.name).title }}</div>
						<div v-if="extensionIdentity(selected.name).title !== selected.name" class="package-name">
							{{ selected.name }}
						</div>
					</div>
				</v-card-title>

				<v-card-text>
					<div class="detail-meta">
						<display-color :value="rowHealthColor(selected)" />
						<span>{{ rowHealthLabel(selected) }}</span>
						<v-chip v-if="selected.type" x-small>{{ selected.type }}</v-chip>
						<v-chip v-if="selected.version" x-small label>{{ selected.version }}</v-chip>
					</div>

					<div v-if="selected.type" class="detail-runtime">
						<span class="detail-label">{{ t('extension_runtime') }}</span>
						<span class="detail-runtime-value">{{ runtimeLabel(selected) }}</span>
					</div>

					<v-notice
						v-if="
							(selected.status === 'loaded' || selected.status === 'discovered') &&
							selected.settings?.status !== 'unavailable'
						"
						type="success"
						class="detail-notice"
					>
						{{
							selected.status === 'loaded'
								? t('extension_status_loaded_detail')
								: t('extension_status_discovered_detail')
						}}
					</v-notice>
					<v-notice v-else-if="selected.status === 'partial'" type="warning" class="detail-notice">
						{{ t('extension_status_partial_detail') }}
					</v-notice>
					<v-notice v-else-if="selected.reason" type="danger" class="detail-notice">
						<div>
							{{ t('extension_status_failed_detail') }}
							<code class="diagnostic-detail">{{ selected.reason.code }}: {{ selected.reason.detail }}</code>
						</div>
					</v-notice>

					<v-notice v-if="selected.settings?.status === 'unavailable'" type="warning" class="detail-notice">
						<div>
							{{ t('extension_settings_unavailable_detail') }}
							<code v-if="selected.settings.reason" class="diagnostic-detail">
								{{ selected.settings.reason.code }}: {{ selected.settings.reason.detail }}
							</code>
						</div>
					</v-notice>

					<div v-if="selected.capabilities" class="detail-capabilities">
						<div class="detail-label">{{ t('extension_capabilities') }}</div>
						<div class="capability-chips">
							<span v-for="label in capabilityLabels(selected.capabilities)" :key="label" class="capability-chip">
								{{ label }}
							</span>
						</div>
					</div>

					<div v-if="selected.entries && selected.entries.length > 0" class="detail-entries">
						<div class="detail-label">{{ t('extension_bundle_contents') }}</div>
						<div
							v-for="(entry, index) in selected.entries"
							:key="`${entry.type}:${entry.name}:${index}`"
							class="detail-entry"
						>
							<v-divider :inline-title="false" class="entry-head">
								<template #icon><v-icon :name="typeIcon(entry.type)" small /></template>
								<span class="entry-name">{{ entry.name }}</span>
								<display-color v-if="entry.status" :value="statusColor(entry.status)" />
								<span v-if="entry.status === 'failed' && entry.reason" class="detail-entry-reason">
									{{ entry.reason.code }}
								</span>
							</v-divider>
							<div v-if="entry.capabilities" class="detail-entry-caps">
								<div class="detail-label">{{ t('extension_capabilities') }}</div>
								<div class="capability-chips">
									<span v-for="label in capabilityLabels(entry.capabilities)" :key="label" class="capability-chip">
										{{ label }}
									</span>
								</div>
							</div>
						</div>
					</div>
				</v-card-text>

				<v-card-actions>
					<v-button secondary @click="selected = null">{{ t('done') }}</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<extension-settings-drawer
			v-if="settingsTarget"
			:model-value="settingsTarget !== null"
			:subject="settingsTarget.name"
			:settings="settingsTarget.settings"
			:resolve-declaration="resolveDeclaration"
			@update:model-value="settingsTarget = null"
		/>
	</private-view>
</template>

<script setup lang="ts">
import api from '@/api';
import DisplayColor from '@/displays/color/color.vue';
import { unexpectedError } from '@/utils/unexpected-error';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsNavigation from '../../components/navigation.vue';
import { extensionIdentity } from './components/extension-identity';
import ExtensionOptions from './components/extension-options.vue';
import ExtensionSettingsDrawer from './components/extension-settings-drawer.vue';

type ExtensionDiagnostic = {
	name: string;
	type: string | null;
	local: boolean;
	version?: string;
	entries?: {
		name: string;
		type: string;
		status?: 'loaded' | 'failed';
		reason?: { code: string; detail: string };
		capabilities?: Record<string, unknown>;
	}[];
	status: 'loaded' | 'discovered' | 'failed' | 'partial';
	reason?: { code: string; detail: string };
	capabilities?: Record<string, unknown>;
	runtime?: 'confined-server';
	settings?: { status: 'available' | 'unavailable'; reason?: { code: string; detail: string } };
};

type ExtensionRow = ExtensionDiagnostic & { _key: string };

const TYPE_ICONS: Record<string, string> = {
	hook: 'webhook',
	endpoint: 'api',
	operation: 'bolt',
	bundle: 'deployed_code',
	interface: 'tune',
	display: 'visibility',
	layout: 'grid_view',
	module: 'category',
	panel: 'insert_chart',
	'item-view': 'vertical_split',
	other: 'extension',
};

const { t } = useI18n();

type ConfinedRuntimeMeta = {
	state: 'not-required' | 'available' | 'unavailable';
	posture: {
		mode: string;
		decision: string;
		applied: string[];
		missing: string[];
		cgroupMechanic: string | null;
	} | null;
};

const extensions = ref<ExtensionRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selected = ref<ExtensionRow | null>(null);
const settingsTarget = ref<ExtensionRow | null>(null);
const confinedRuntime = ref<ConfinedRuntimeMeta | null>(null);

const failedCount = computed(() => extensions.value.filter((extension) => extension.status === 'failed').length);

const warningCount = computed(
	() =>
		extensions.value.filter(
			(extension) =>
				extension.status === 'partial' ||
				(extension.status !== 'failed' && extension.settings?.status === 'unavailable')
		).length
);

const normalCount = computed(() => extensions.value.length - failedCount.value - warningCount.value);

function statusColor(status?: string): string {
	if (status === 'failed') return 'var(--danger)';
	if (status === 'partial') return 'var(--warning)';
	return 'var(--success)';
}

function rowHealthColor(row: ExtensionDiagnostic): string {
	if (row.status === 'failed') return 'var(--danger)';
	if (row.settings?.status === 'unavailable') return 'var(--warning)';
	return statusColor(row.status);
}

function rowHealthLabel(row: ExtensionDiagnostic): string {
	if (row.status === 'failed') return t('extension_health_failed');
	if (row.status === 'partial' || row.settings?.status === 'unavailable') return t('extension_health_warning', 1);
	return t('extension_health_normal');
}

function runtimeLabel(row: ExtensionDiagnostic): string {
	if (row.runtime === 'confined-server') return t('extension_runtime_sandboxed');
	// A discovered extension is app-only and runs in the browser, not on the server, so it is
	// neither sandboxed nor full-authority in the server sense.
	if (row.status === 'discovered') return t('extension_runtime_browser');
	return t('extension_runtime_full_authority');
}

function capabilityLabels(capabilities: Record<string, unknown>): string[] {
	return Object.entries(capabilities).map(([key, value]) => {
		if (value === true) return key;
		if (typeof value === 'string') return `${key}: ${value}`;
		if (Array.isArray(value)) return `${key}: ${value.join(', ')}`;

		if (value && typeof value === 'object') {
			const obj = value as Record<string, unknown>;
			if (typeof obj.access === 'string') return `${key}: ${obj.access}`;

			if (Array.isArray(obj.urls)) {
				// An omitted request method allowlist defaults to GET in the broker, so show that
				// rather than an empty method scope.
				const methods = Array.isArray(obj.methods) ? obj.methods : ['GET'];
				return `${key}: ${methods.join(', ')} ${(obj.urls as unknown[]).join(', ')}`;
			}
		}

		return key;
	});
}

const groups = computed(() => {
	const byType = new Map<string, ExtensionRow[]>();

	for (const extension of extensions.value) {
		const type = extension.type ?? 'other';
		const items = byType.get(type) ?? [];
		items.push(extension);
		byType.set(type, items);
	}

	return [...byType.entries()].map(([type, items]) => ({ type, items }));
});

function typeIcon(type: string): string {
	return TYPE_ICONS[type] ?? 'extension';
}

function groupLabel(type: string): string {
	return t(`extension_type_group_${type}`);
}

fetchExtensions();

async function fetchExtensions() {
	loading.value = true;
	error.value = null;

	try {
		const response = await api.get('/extensions');

		extensions.value = response.data.data.map((entry: ExtensionDiagnostic, index: number) => ({
			...entry,
			_key: `${index}:${entry.name}`,
		}));

		confinedRuntime.value = response.data.meta?.confinedRuntime ?? null;

		loadOwnerDeclarations().catch(() => undefined);
	} catch (err: any) {
		error.value = t('extensions_load_failed');
		unexpectedError(err);
	} finally {
		loading.value = false;
	}
}

let ownerDeclarationsRequest: Promise<Record<string, Record<string, unknown>>> | null = null;

function loadOwnerDeclarations(): Promise<Record<string, Record<string, unknown>>> {
	ownerDeclarationsRequest ??= api
		.get('/extension-settings/owners')
		.then((response) =>
			Object.fromEntries(
				(response.data.data as { subject?: string; declaration?: Record<string, unknown> }[])
					.filter((owner) => owner.subject !== undefined && owner.declaration !== undefined)
					.map((owner) => [owner.subject!, owner.declaration!])
			)
		)
		.catch((error) => {
			ownerDeclarationsRequest = null;
			throw error;
		});

	return ownerDeclarationsRequest;
}

async function resolveDeclaration(subject: string): Promise<Record<string, unknown> | undefined> {
	const declarations = await loadOwnerDeclarations();
	return declarations[subject];
}
</script>

<style lang="scss" scoped>
@import '@/styles/mixins/package-name';

.header-icon {
	--v-button-color-disabled: var(--primary);
	--v-button-background-color-disabled: var(--primary-10);
	--v-button-background-color-hover-disabled: var(--primary-25);
	--v-button-color-hover-disabled: var(--primary);
}

.package-name {
	@include package-name;
}

.detail-title {
	text-align: left;
}

.extensions {
	padding: var(--content-padding);
	padding-top: 0;
	padding-bottom: var(--content-padding-bottom);
}

.error {
	margin: var(--content-padding);
	margin-top: 0;
}

.loading {
	display: flex;
	justify-content: center;
	padding: var(--content-padding);
}

.summary {
	display: flex;
	gap: 1.5rem;
	margin-bottom: 1.5rem;
	color: var(--foreground-subdued);
	font-size: 0.875rem;
}

.summary .stat {
	display: inline-flex;
	align-items: center;
	gap: 0.375rem;
}

.summary .count {
	color: var(--foreground-normal);
	font-weight: 600;
}

.group {
	margin-bottom: 2rem;
}

.group-count {
	margin-left: 0.5rem;
}

.expand-icon {
	float: right;
}

.version {
	flex-shrink: 0;
	margin-left: 0.75rem;
}

.sandboxed {
	flex-shrink: 0;
	margin-left: 0.75rem;
	--v-chip-color: var(--primary);
}

.detail-meta {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

.detail-runtime {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	margin-top: 0.75rem;
}

.detail-runtime .detail-label {
	margin-bottom: 0;
}

.detail-entries {
	margin-top: 1.25rem;
}

.detail-label {
	margin-bottom: 0.5rem;
	color: var(--foreground-subdued);
	font-size: 0.8125rem;
}

.detail-entry {
	display: flex;
	flex-direction: column;
	gap: 0.625rem;
	margin-bottom: 1.5rem;
}

.entry-head :deep(.type-text) {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	font-size: 0.9375rem;
}

.entry-name {
	flex-grow: 1;
	min-width: 0;
}

.detail-entry-reason {
	color: var(--danger);
	font-family: var(--family-monospace);
	font-size: 0.8125rem;
}

.diagnostic-detail {
	display: block;
	margin-top: 0.5rem;
	font-family: var(--family-monospace);
	font-size: 0.8125rem;
}

.detail-notice {
	margin-top: 1.25rem;
}

.detail-capabilities {
	margin-top: 1.25rem;
}

.capability-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
}

.detail-capabilities .capability-chips {
	margin-top: 0.5rem;
}

.detail-entry-caps .detail-label {
	margin-bottom: 0.25rem;
}

.capability-chip {
	max-width: 100%;
	padding: 0 0.375rem;
	border: var(--border-width) solid var(--border-subdued);
	border-radius: var(--border-radius);
	color: var(--foreground-subdued);
	font-size: 0.75rem;
	line-height: 1.7;
	overflow-wrap: anywhere;
}

.layer-applied {
	display: inline-flex;
	align-items: center;
	gap: 0.125rem;
	border-color: var(--success);
	color: var(--success);
}

.layer-missing {
	display: inline-flex;
	align-items: center;
	gap: 0.125rem;
	color: var(--foreground-subdued);
}

.sandbox-warning {
	margin-bottom: 1.5rem;
}

.advanced-diagnostics {
	margin-bottom: 2rem;
}

.confined-runtime {
	padding-top: 0.75rem;
}

.cr-posture {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.75rem;
	margin-top: 0.5rem;
}

.cr-mode {
	color: var(--foreground-subdued);
	font-size: 0.8125rem;
}
</style>
