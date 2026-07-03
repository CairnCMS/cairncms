<template>
	<v-drawer
		:model-value="modelValue"
		:title="subject"
		:subtitle="t('extension_settings_drawer_subtitle')"
		icon="settings"
		persistent
		@update:model-value="$emit('update:modelValue', $event)"
		@cancel="cancel"
	>
		<div class="drawer-content">
			<v-notice v-if="settings?.status === 'unavailable'" type="warning">
				<div>
					{{ t(settingsReasonKey(settings.reason?.code)) }}
					<code v-if="settings.reason?.detail" class="diagnostic-detail">{{ settings.reason.detail }}</code>
				</div>
			</v-notice>

			<template v-else>
				<v-progress-circular v-if="loading && showSpinner" indeterminate class="loading" />

				<template v-if="!loading">
					<v-notice v-if="loadError" type="danger">{{ t('extension_settings_load_failed') }}</v-notice>

					<template v-else>
						<v-notice v-if="hasConfigKeys" type="info" class="config-notice">
							{{ t('extension_settings_config_notice') }}
						</v-notice>

						<v-notice v-if="fields.length === 0 && !hasConfigKeys">
							{{ t('extension_settings_no_global_keys') }}
						</v-notice>

						<v-form
							v-if="fields.length > 0"
							v-model="edits"
							class="settings-form"
							:fields="fields"
							:initial-values="initialValues"
							primary-key="+"
						/>
					</template>
				</template>
			</template>
		</div>

		<template #actions>
			<v-button
				v-if="settings?.status === 'available'"
				v-tooltip.bottom="t('save')"
				icon
				rounded
				:disabled="!hasEdits"
				:loading="saving"
				@click="save"
			>
				<v-icon name="check" />
			</v-button>
		</template>
	</v-drawer>
</template>

<script setup lang="ts">
import api from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { unexpectedError } from '@/utils/unexpected-error';
import formatTitle from '@cairncms/format-title';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { settingsReasonKey } from './settings-reason';

type SettingDeclaration = {
	type: 'string' | 'number' | 'boolean';
	scope?: 'global' | 'collection';
	secret?: { source: 'inline' | 'config' };
	appReadable?: boolean;
	presentation?: { order?: number; width?: 'half' | 'full' };
};

const FIELD_TYPES: Record<SettingDeclaration['type'], string> = {
	string: 'string',
	number: 'float',
	boolean: 'boolean',
};

const props = defineProps<{
	modelValue: boolean;
	subject: string;
	settings?: { status: 'available' | 'unavailable'; reason?: { code: string; detail: string } };
	resolveDeclaration: (subject: string) => Promise<Record<string, SettingDeclaration> | undefined>;
}>();

const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();
const notificationsStore = useNotificationsStore();

const loading = ref(false);
const showSpinner = ref(false);
const loadError = ref(false);
const saving = ref(false);
const declaration = ref<Record<string, SettingDeclaration>>({});
const initialValues = ref<Record<string, unknown>>({});
const edits = ref<Record<string, unknown>>({});

const hasEdits = computed(() => Object.keys(edits.value).length > 0);

const hasConfigKeys = computed(() => Object.values(declaration.value).some((decl) => decl.secret?.source === 'config'));

const fields = computed(() => {
	const entries = Object.entries(declaration.value).filter(
		([, decl]) => (decl.scope ?? 'global') === 'global' && decl.secret?.source !== 'config'
	);

	const sorted = entries
		.map(([key, decl], index) => ({ key, decl, order: decl.presentation?.order ?? index + 1000 }))
		.sort((a, b) => a.order - b.order);

	return sorted.map(({ key, decl }, index) => ({
		field: key,
		name: formatTitle(key),
		type: FIELD_TYPES[decl.type],
		meta: {
			field: key,
			width: decl.presentation?.width ?? 'full',
			sort: index + 1,
			interface:
				decl.secret?.source === 'inline' ? 'system-extension-secret' : decl.type === 'boolean' ? 'boolean' : 'input',
		},
		schema: null,
	}));
});

watch(
	() => props.modelValue,
	async (open) => {
		if (!open) return;

		edits.value = {};
		if (props.settings?.status !== 'available') return;

		loading.value = true;
		loadError.value = false;
		showSpinner.value = false;

		// The declaration usually resolves from the page's prefetch, so the spinner only
		// appears when the values read is genuinely slow, not as a one-frame flash.
		const spinnerTimer = setTimeout(() => (showSpinner.value = true), 150);

		try {
			const [resolved, values] = await Promise.all([
				props.resolveDeclaration(props.subject),
				api.get('/extension-settings', { params: { subject: props.subject, scope: 'global', scope_key: '' } }),
			]);

			// An available owner always has a declaration, so an unresolved one means the
			// listing and the owners state disagree, and the form must not render empty.
			if (resolved === undefined) {
				loadError.value = true;
				return;
			}

			declaration.value = resolved;

			initialValues.value = Object.fromEntries(
				(values.data.data as { key: string; value: unknown }[]).map((row) => [row.key, row.value])
			);
		} catch (error) {
			loadError.value = true;
			unexpectedError(error);
		} finally {
			clearTimeout(spinnerTimer);
			loading.value = false;
		}
	},
	// The drawer is created open (v-if plus model-value together), so the first load
	// must fire on mount, not only on a later reopen.
	{ immediate: true }
);

function cancel() {
	edits.value = {};
	emit('update:modelValue', false);
}

async function save() {
	saving.value = true;

	try {
		for (const [key, value] of Object.entries(edits.value)) {
			if (value === null) {
				await api.delete('/extension-settings', {
					data: { subject: props.subject, scope: 'global', scope_key: '', key },
				});
			} else {
				await api.post('/extension-settings', {
					subject: props.subject,
					scope: 'global',
					scope_key: '',
					key,
					value,
				});
			}
		}

		edits.value = {};
		emit('update:modelValue', false);
	} catch (error: any) {
		const code = error?.response?.data?.errors?.[0]?.extensions?.code;

		if (code === 'INVALID_CONFIG') {
			notificationsStore.add({
				title: t('extension_settings_key_not_configured'),
				type: 'error',
				dialog: true,
			});
		} else {
			unexpectedError(error);
		}
	} finally {
		saving.value = false;
	}
}
</script>

<style lang="scss" scoped>
.drawer-content {
	padding: var(--content-padding);
	padding-top: 0;
	display: flex;
	flex-direction: column;
	gap: 1.25rem;
}

.loading {
	margin: 2rem auto;
}

.diagnostic-detail {
	display: block;
	margin-top: 0.5rem;
	font-family: var(--family-monospace);
	font-size: 0.8125rem;
}
</style>
