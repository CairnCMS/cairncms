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
					<span class="count">{{ activeCount }}</span>
					{{ t('extension_active') }}
				</span>
				<span v-if="failedCount > 0" class="stat">
					<display-color value="var(--danger)" />
					<span class="count">{{ failedCount }}</span>
					{{ t('extension_failed') }}
				</span>
			</div>

			<v-detail v-for="group in groups" :key="group.type" start-open class="group">
				<template #activator="{ toggle, active }">
					<v-divider :inline-title="false" large class="group-head" @click="toggle">
						<template #icon><v-icon :name="typeIcon(group.type)" /></template>
						<span class="group-name">{{ groupLabel(group.type) }}</span>
						<v-chip class="group-count" x-small>{{ group.items.length }}</v-chip>
						<v-icon class="expand-icon" :class="{ active }" name="expand_more" />
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
						<display-color :value="extension.status === 'failed' ? 'var(--danger)' : 'var(--success)'" />
					</v-list-item-icon>
					<v-list-item-content>
						<v-text-overflow :text="extension.name" />
					</v-list-item-content>
					<v-chip v-if="extension.version" class="version" small label>{{ extension.version }}</v-chip>
				</v-list-item>
			</v-detail>
		</div>

		<v-dialog
			:model-value="selected !== null"
			placement="center"
			@update:model-value="selected = null"
			@esc="selected = null"
		>
			<v-card v-if="selected">
				<v-card-title>{{ selected.name }}</v-card-title>

				<v-card-text>
					<div class="detail-meta">
						<display-color :value="selected.status === 'failed' ? 'var(--danger)' : 'var(--success)'" />
						<span>{{ selected.status === 'failed' ? t('extension_failed') : t('extension_active') }}</span>
						<v-chip v-if="selected.type" x-small>{{ selected.type }}</v-chip>
						<v-chip v-if="selected.version" x-small label>{{ selected.version }}</v-chip>
					</div>

					<v-notice v-if="selected.status === 'loaded'" type="success" class="detail-notice">
						{{ t('extension_status_loaded_detail') }}
					</v-notice>
					<v-notice v-else-if="selected.status === 'discovered'" type="success" class="detail-notice">
						{{ t('extension_status_discovered_detail') }}
					</v-notice>
					<v-notice v-else-if="selected.reason" type="danger" class="detail-notice">
						{{ selected.reason.code }}: {{ selected.reason.detail }}
					</v-notice>

					<div v-if="selected.entries && selected.entries.length > 0" class="detail-entries">
						<div class="detail-label">{{ t('extension_bundle_contents') }}</div>
						<div
							v-for="(entry, index) in selected.entries"
							:key="`${entry.type}:${entry.name}:${index}`"
							class="detail-entry"
						>
							<v-icon :name="typeIcon(entry.type)" small />
							<span class="detail-entry-name">{{ entry.name }}</span>
							<v-chip x-small>{{ entry.type }}</v-chip>
						</div>
					</div>
				</v-card-text>

				<v-card-actions>
					<v-button secondary @click="selected = null">{{ t('done') }}</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import api from '@/api';
import DisplayColor from '@/displays/color/color.vue';
import { unexpectedError } from '@/utils/unexpected-error';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsNavigation from '../../components/navigation.vue';

type ExtensionDiagnostic = {
	name: string;
	type: string | null;
	local: boolean;
	version?: string;
	entries?: { name: string; type: string }[];
	status: 'loaded' | 'discovered' | 'failed';
	reason?: { code: string; detail: string };
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
	other: 'extension',
};

const { t } = useI18n();

const extensions = ref<ExtensionRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selected = ref<ExtensionRow | null>(null);

const failedCount = computed(() => extensions.value.filter((extension) => extension.status === 'failed').length);
const activeCount = computed(() => extensions.value.length - failedCount.value);

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
	} catch (err: any) {
		error.value = t('extensions_load_failed');
		unexpectedError(err);
	} finally {
		loading.value = false;
	}
}
</script>

<style lang="scss" scoped>
.header-icon {
	--v-button-color-disabled: var(--primary);
	--v-button-background-color-disabled: var(--primary-10);
	--v-button-background-color-hover-disabled: var(--primary-25);
	--v-button-color-hover-disabled: var(--primary);
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
	gap: 24px;
	margin-bottom: 24px;
	color: var(--foreground-subdued);
	font-size: 14px;
}

.summary .stat {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.summary .count {
	color: var(--foreground-normal);
	font-weight: 600;
}

.group {
	margin-bottom: 32px;
}

.group-count {
	margin-left: 8px;
}

.expand-icon {
	float: right;
	transform: rotate(90deg);
	transition: transform var(--fast) var(--transition);
}

.expand-icon.active {
	transform: rotate(0);
}

.version {
	flex-shrink: 0;
	margin-left: 12px;
}

.detail-meta {
	display: flex;
	align-items: center;
	gap: 8px;
}

.detail-entries {
	margin-top: 20px;
}

.detail-label {
	margin-bottom: 8px;
	color: var(--foreground-subdued);
	font-size: 13px;
}

.detail-entry {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 0;
}

.detail-entry-name {
	flex-grow: 1;
}

.detail-notice {
	margin-top: 20px;
}
</style>
