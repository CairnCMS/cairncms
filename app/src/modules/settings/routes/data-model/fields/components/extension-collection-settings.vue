<template>
	<div v-if="groups.length > 0" class="extension-collection-settings">
		<v-divider
			class="section-head"
			:style="{ '--v-divider-color': 'var(--border-subdued)' }"
			large
			:inline-title="false"
		>
			<template #icon><v-icon name="settings" /></template>
			{{ t('extension_settings_section') }}
		</v-divider>

		<div v-for="group in groups" :key="group.subject" class="owner-group">
			<v-divider class="owner-title">{{ extensionIdentity(group.subject).title }}</v-divider>

			<v-form
				:model-value="edits[group.subject]"
				class="owner-form"
				:fields="group.fields"
				:initial-values="initialValues[group.subject]"
				primary-key="+"
				@update:model-value="edits[group.subject] = $event"
			/>
		</div>
	</div>
</template>

<script setup lang="ts">
import api from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { unexpectedError } from '@/utils/unexpected-error';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { extensionIdentity } from '../../../extensions/components/extension-identity';
import {
	isInlineSecret,
	SECRET_MASK,
	synthesizeSettingsFields,
	type SettingsDeclarationMap,
} from '../../../extensions/components/settings-fields';

type OwnerGroup = {
	subject: string;
	declaration: SettingsDeclarationMap;
	fields: ReturnType<typeof synthesizeSettingsFields>;
};

const props = defineProps<{
	collection: string;
}>();

const { t } = useI18n();
const notificationsStore = useNotificationsStore();

const groups = ref<OwnerGroup[]>([]);
const initialValues = ref<Record<string, Record<string, unknown>>>({});
const edits = ref<Record<string, Record<string, unknown>>>({});

// The collection whose values are on screen. Saves address this, not the live prop, so
// a route change mid-edit can never write one collection's values under another's key.
const loadedCollection = ref<string | null>(null);

let loadToken = 0;

const hasEdits = computed(() =>
	Object.values(edits.value).some((groupEdits) => Object.keys(groupEdits ?? {}).length > 0)
);

watch(() => props.collection, load, { immediate: true });

defineExpose({ hasEdits, save, discard });

function discard() {
	edits.value = {};
}

async function load() {
	const token = ++loadToken;
	const target = props.collection;

	groups.value = [];
	initialValues.value = {};
	edits.value = {};
	loadedCollection.value = null;

	if (target.startsWith('directus_')) return;

	try {
		const owners = await api.get('/extension-settings/owners');
		if (token !== loadToken) return;

		const collectionOwners = (
			owners.data.data as { subject?: string; status: string; declaration?: SettingsDeclarationMap }[]
		)
			.filter((owner) => owner.status === 'available' && owner.subject !== undefined && owner.declaration !== undefined)
			.map((owner) => ({
				subject: owner.subject!,
				declaration: owner.declaration!,
				fields: synthesizeSettingsFields(owner.declaration!, 'collection'),
			}))
			.filter((owner) => owner.fields.length > 0);

		if (collectionOwners.length === 0) return;

		const values = await Promise.all(
			collectionOwners.map((owner) =>
				api.get('/extension-settings', {
					params: { subject: owner.subject, scope: 'collection', scope_key: target },
				})
			)
		);

		if (token !== loadToken) return;

		for (const [index, owner] of collectionOwners.entries()) {
			initialValues.value[owner.subject] = Object.fromEntries(
				(values[index]!.data.data as { key: string; value: unknown }[]).map((row) => [row.key, row.value])
			);
		}

		groups.value = collectionOwners;
		loadedCollection.value = target;
	} catch (error) {
		if (token === loadToken) unexpectedError(error);
	}
}

async function save(): Promise<boolean> {
	const target = loadedCollection.value;
	if (!target) return true;

	try {
		for (const group of groups.value) {
			for (const [key, value] of Object.entries(edits.value[group.subject] ?? {})) {
				// A stale masked secret is not a value: storing the mask would replace the
				// stored secret with the concealment string.
				if (value === SECRET_MASK && isInlineSecret(group.declaration, key)) continue;

				if (value === null) {
					await api.delete('/extension-settings', {
						data: { subject: group.subject, scope: 'collection', scope_key: target, key },
					});
				} else {
					await api.post('/extension-settings', {
						subject: group.subject,
						scope: 'collection',
						scope_key: target,
						key,
						value,
					});
				}
			}
		}

		edits.value = {};
		await load();
		return true;
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

		return false;
	}
}
</script>

<style lang="scss" scoped>
.extension-collection-settings {
	max-width: calc(var(--form-column-max-width) * 2 + var(--form-horizontal-gap));
}

.section-head {
	margin-top: 2.5rem;
}

.owner-group {
	margin-top: 1.5rem;
}

.owner-title :deep(.type-text) {
	font-size: 1rem;
}

.owner-form {
	margin-top: 0.75rem;
}
</style>
