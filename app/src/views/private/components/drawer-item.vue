<template>
	<v-drawer v-model="internalActive" :title="title" persistent @cancel="cancel">
		<template v-if="template !== null && templateData && primaryKey !== '+'" #title>
			<v-skeleton-loader v-if="loading || templateDataLoading" class="title-loader" type="text" />

			<h1 v-else class="type-title">
				<render-template :collection="templateCollection?.collection" :item="templateData" :template="template" />
			</h1>
		</template>

		<template #subtitle>
			<v-breadcrumb :items="[{ name: collectionInfo?.name, disabled: true }]" />
		</template>

		<template #actions>
			<slot name="actions" />
			<v-button v-tooltip.bottom="t('save')" icon rounded :disabled="!saveAvailable" @click="save">
				<v-icon name="check" />
			</v-button>
		</template>

		<div class="drawer-item-content">
			<file-preview
				v-if="junctionField && file"
				:src="file.src"
				:mime="file.type"
				:width="file.width"
				:height="file.height"
				:title="file.title"
				:in-modal="true"
			/>
			<v-info v-if="emptyForm" :title="t('no_visible_fields')" icon="search" center>
				{{ t('no_visible_fields_copy') }}
			</v-info>
			<div v-else class="drawer-item-order" :class="{ swap: swapFormOrder }">
				<v-form
					v-if="junctionField"
					:disabled="relatedFormDisabled"
					:loading="relatedLoading"
					:show-no-visible-fields="false"
					:initial-values="relatedData"
					:primary-key="relatedPrimaryKey"
					:model-value="internalEdits?.[junctionField]"
					:fields="relatedCollectionFields"
					:validation-errors="relatedValidationErrors"
					:autofocus="!swapFormOrder"
					:show-divider="!swapFormOrder"
					@update:model-value="setRelationEdits"
				/>

				<v-form
					v-model="internalEdits"
					:disabled="junctionFormDisabled"
					:loading="junctionLoading"
					:show-no-visible-fields="false"
					:initial-values="initialValues"
					:autofocus="swapFormOrder"
					:show-divider="swapFormOrder"
					:primary-key="primaryKey"
					:fields="fields"
					:validation-errors="junctionValidationErrors"
				/>
			</div>
		</div>
	</v-drawer>
	<v-dialog v-model="confirmLeave" @esc="confirmLeave = false">
		<v-card>
			<v-card-title>{{ t('unsaved_changes') }}</v-card-title>
			<v-card-text>{{ t('unsaved_changes_copy') }}</v-card-text>
			<v-card-actions>
				<v-button secondary @click="discardAndLeave">
					{{ t('discard_changes') }}
				</v-button>
				<v-button @click="confirmLeave = false">{{ t('keep_editing') }}</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import api from '@/api';
import { useEditsGuard } from '@/composables/use-edits-guard';
import { useFieldPermissions } from '@/composables/use-field-permissions';
import {
	hasConditionalItemPermission,
	itemActionAllowed,
	useItemPermissions,
} from '@/composables/use-item-permissions';
import { useTemplateData } from '@/composables/use-template-data';
import { useFieldsStore } from '@/stores/fields';
import { usePermissionsStore } from '@/stores/permissions';
import { useRelationsStore } from '@/stores/relations';
import { useUserStore } from '@/stores/user';
import { getDefaultValuesFromFields } from '@/utils/get-default-values-from-fields';
import { pickWritable } from '@/utils/pick-writable';
import { unexpectedError } from '@/utils/unexpected-error';
import { validateItem } from '@/utils/validate-item';
import FilePreview from '@/views/private/components/file-preview.vue';
import { useCollection } from '@cairncms/composables';
import { Field, ItemPermissions, Permission, Relation } from '@cairncms/types';
import { getEndpoint } from '@cairncms/utils';
import { cloneDeep, isEmpty, merge, set } from 'lodash';
import { computed, ref, toRefs, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

interface Props {
	collection: string;
	active?: boolean;
	primaryKey?: string | number | null;
	edits?: Record<string, any>;
	junctionField?: string | null;
	disabled?: boolean;
	// There's an interesting case where the main form can be a newly created item ('+'), while
	// it has a pre-selected related item it needs to alter. In that case, we have to fetch the
	// related data anyway.
	relatedPrimaryKey?: string | number;
	// If this drawer-item is opened from a relational interface, we need to force-block the field
	// that relates back to the parent item.
	circularField?: string | null;
	junctionFieldLocation?: string;
}

const props = withDefaults(defineProps<Props>(), {
	active: undefined,
	primaryKey: null,
	edits: undefined,
	junctionField: null,
	disabled: false,
	relatedPrimaryKey: '+',
	circularField: null,
	junctionFieldLocation: 'bottom',
});

const emit = defineEmits(['update:active', 'input']);

function isNewKey(key: string | number | null | undefined): boolean {
	return key === '+';
}

function isExistingKey(key: string | number | null | undefined): boolean {
	return key !== '+' && key !== null && key !== undefined;
}

function keyMode(key: string | number | null | undefined): 'create' | 'update' | null {
	if (isNewKey(key)) return 'create';
	if (isExistingKey(key)) return 'update';
	return null;
}

function meaningfulContentKeys(
	edits: Record<string, any> | null | undefined,
	identityFields: (string | null | undefined)[]
): string[] {
	if (!edits) return [];
	const identity = identityFields.filter((field): field is string => !!field);
	return Object.keys(edits).filter((key) => key.startsWith('$') === false && identity.includes(key) === false);
}

function hasMeaningfulContent(
	edits: Record<string, any> | null | undefined,
	identityFields: (string | null | undefined)[]
): boolean {
	return meaningfulContentKeys(edits, identityFields).length > 0;
}

function stripStaging(edits: Record<string, any>): Record<string, any> {
	const stripped: Record<string, any> = {};

	for (const key of Object.keys(edits)) {
		if (key.startsWith('$') === false) stripped[key] = edits[key];
	}

	return stripped;
}

function stripKey(edits: Record<string, any>, key: string | null): Record<string, any> {
	if (!key) return { ...edits };

	const rest = { ...edits };
	delete rest[key];
	return rest;
}

function fieldWritable(fields: string[] | null, field: string | null | undefined): boolean {
	if (!fields || !field) return false;
	return fields.includes('*') || fields.includes(field);
}

type SaveTarget = { fields: Field[]; state: Record<string, any>; isNew: boolean };

type SaveOperation = {
	available: boolean;
	emit: Record<string, any>;
	junction: SaveTarget | null;
	related: SaveTarget | null;
};

const { t, te } = useI18n();

const junctionValidationErrors = ref<any[]>([]);
const relatedValidationErrors = ref<any[]>([]);

const fieldsStore = useFieldsStore();
const relationsStore = useRelationsStore();
const userStore = useUserStore();
const permissionsStore = usePermissionsStore();

const { collection } = toRefs(props);

const { internalActive } = useActiveState();

const internalEdits = ref<Record<string, any>>({});
const junctionData = ref<Record<string, any> | null>(null);
const relatedData = ref<Record<string, any> | undefined>(undefined);
const junctionLoading = ref(false);
const relatedLoading = ref(false);
const junctionLoaded = ref(false);
const relatedLoaded = ref(false);

const loading = computed(() => junctionLoading.value || relatedLoading.value);

const initialValues = computed<Record<string, any> | null>(() => {
	if (junctionData.value === null && relatedData.value === undefined) return null;

	const composed = { ...(junctionData.value ?? {}) };

	if (props.junctionField && relatedData.value !== undefined) {
		composed[props.junctionField] = relatedData.value;
	}

	return composed;
});

const {
	junctionFieldInfo,
	relatedCollection,
	relatedCollectionInfo,
	setRelationEdits,
	relatedPrimaryKeyField,
	collectionField,
} = useRelation();

useDataLoaders();

const { info: collectionInfo, primaryKeyField } = useCollection(collection);

const { operation, junctionFormDisabled, relatedFormDisabled, saveAvailable } = useGating();

const { save, cancel } = useActions();

const isNew = computed(() => props.primaryKey === '+' && props.relatedPrimaryKey === '+');

const swapFormOrder = computed(() => {
	return props.junctionFieldLocation === 'top';
});

const hasEdits = computed(() => !isEmpty(internalEdits.value));
const { confirmLeave, leaveTo } = useEditsGuard(hasEdits);
const router = useRouter();

function discardAndLeave() {
	if (!leaveTo.value) return;
	internalEdits.value = {};
	confirmLeave.value = false;
	router.push(leaveTo.value);
}

const title = computed(() => {
	const collection = relatedCollectionInfo?.value || collectionInfo.value!;

	if (te(`collection_names_singular.${collection.collection}`)) {
		return isNew.value
			? t('creating_unit', {
					unit: t(`collection_names_singular.${collection.collection}`),
			  })
			: t('editing_unit', {
					unit: t(`collection_names_singular.${collection.collection}`),
			  });
	}

	return isNew.value
		? t('creating_in', { collection: collection.name })
		: t('editing_in', { collection: collection.name });
});

const { fields: relatedCollectionFields } = useFieldPermissions(
	relatedCollection as any,
	computed(() => props.relatedPrimaryKey === '+')
);

const { fields: fieldsWithPermissions } = useFieldPermissions(
	collection,
	computed(() => props.primaryKey === '+')
);

const fields = computed(() => {
	if (props.circularField) {
		return fieldsWithPermissions.value.map((field: Field) => {
			if (field.field === props.circularField) {
				set(field, 'meta.readonly', true);
			}

			return field;
		});
	} else {
		return fieldsWithPermissions.value;
	}
});

const fieldsWithoutCircular = computed(() => {
	if (props.circularField) {
		return fields.value.filter((field) => {
			return field.field !== props.circularField;
		});
	} else {
		return fields.value;
	}
});

const emptyForm = computed(() => {
	const visibleFieldsRelated = relatedCollectionFields.value.filter((field: Field) => !field.meta?.hidden);
	const visibleFieldsJunction = fields.value.filter((field: Field) => !field.meta?.hidden);
	return visibleFieldsRelated.length + visibleFieldsJunction.length === 0;
});

const templatePrimaryKey = computed(() =>
	junctionFieldInfo.value ? String(props.relatedPrimaryKey) : String(props.primaryKey)
);

const templateCollection = computed(() => relatedCollectionInfo.value || collectionInfo.value);
const { templateData, loading: templateDataLoading } = useTemplateData(templateCollection, templatePrimaryKey);

const template = computed(
	() => relatedCollectionInfo.value?.meta?.display_template || collectionInfo.value?.meta?.display_template || null
);

const { file } = useFile();

function useFile() {
	const isDirectusFiles = computed(() => {
		return relatedCollection.value === 'directus_files';
	});

	const file = computed(() => {
		if (isDirectusFiles.value === false || !initialValues.value || !props.junctionField) return null;
		const fileData = initialValues.value?.[props.junctionField];
		if (!fileData) return null;

		const src = `assets/${fileData.id}?key=system-large-contain`;
		return { ...fileData, src };
	});

	return { file, isDirectusFiles };
}

function useActiveState() {
	const localActive = ref(false);

	const internalActive = computed({
		get() {
			return props.active ?? localActive.value;
		},
		set(newActive: boolean) {
			localActive.value = newActive;
			emit('update:active', newActive);
		},
	});

	return { internalActive };
}

function useDataLoaders() {
	const noSeed = Symbol('no-seed');

	let junctionGeneration = 0;
	let relatedGeneration = 0;
	let adoptedEdits: unknown = noSeed;
	let relatedSeedRef: unknown = noSeed;
	let junctionOwner: string | null = null;
	let relatedOwner: { junction: string; key: string; collection: string | null } | null = null;

	watch(
		() => [props.active, props.collection, props.primaryKey, props.junctionField],
		() => loadJunctionData(),
		{ immediate: true }
	);

	watch(
		() => [props.active, relatedCollection.value, props.relatedPrimaryKey, props.junctionField],
		() => loadRelatedData(),
		{ immediate: true }
	);

	watch(
		() => [
			props.active,
			props.collection,
			props.primaryKey,
			props.relatedPrimaryKey,
			relatedCollection.value,
			props.junctionField,
			props.edits,
		],
		() => reconcileEdits(),
		{ immediate: true }
	);

	function reconcileEdits() {
		if (props.active !== true) {
			internalEdits.value = {};
			adoptedEdits = noSeed;
			relatedSeedRef = noSeed;
			junctionOwner = null;
			relatedOwner = null;
			return;
		}

		const freshSeed = props.edits !== adoptedEdits;
		const seed = props.edits ? cloneDeep(props.edits) : {};
		const junctionField = props.junctionField;

		let draft = { ...internalEdits.value };

		const currentJunction = `${props.collection}::${String(props.primaryKey)}`;

		if (junctionOwner === null || currentJunction !== junctionOwner) {
			draft = freshSeed ? stripKey(seed, junctionField) : {};
			junctionOwner = currentJunction;
			relatedOwner = null;
		}

		if (junctionField) {
			const currentKey = String(props.relatedPrimaryKey);
			const currentCollection = relatedCollection.value;
			const relatedFresh = props.edits !== relatedSeedRef;

			const identityMatches =
				relatedOwner !== null && relatedOwner.junction === currentJunction && relatedOwner.key === currentKey;

			const collectionCompatible =
				relatedOwner !== null &&
				(relatedOwner.collection === currentCollection ||
					(relatedFresh === false && (currentCollection === null || relatedOwner.collection === null)));

			const sameTarget = identityMatches && collectionCompatible;

			if (sameTarget) {
				if (relatedOwner!.collection === null && currentCollection !== null)
					relatedOwner!.collection = currentCollection;
				if (relatedFresh) relatedSeedRef = props.edits;
			} else if (relatedFresh) {
				if (seed[junctionField] !== undefined) draft[junctionField] = seed[junctionField];
				else delete draft[junctionField];

				relatedOwner = { junction: currentJunction, key: currentKey, collection: currentCollection };
				relatedSeedRef = props.edits;
			} else {
				delete draft[junctionField];
				relatedOwner = { junction: currentJunction, key: currentKey, collection: currentCollection };
			}
		}

		internalEdits.value = draft;
		adoptedEdits = props.edits;
	}

	function loadJunctionData() {
		const token = ++junctionGeneration;

		junctionLoading.value = false;
		junctionLoaded.value = false;
		junctionData.value = null;
		junctionValidationErrors.value = [];

		if (props.active !== true) return;

		if (isExistingKey(props.primaryKey)) fetchItem(token);
	}

	function loadRelatedData() {
		const token = ++relatedGeneration;

		relatedLoading.value = false;
		relatedLoaded.value = false;
		relatedData.value = undefined;
		relatedValidationErrors.value = [];

		if (props.active !== true) return;
		if (!props.junctionField || !relatedCollection.value) return;
		if (isExistingKey(props.relatedPrimaryKey) === false) return;

		fetchRelatedItem(token);
	}

	async function fetchItem(token: number) {
		junctionLoading.value = true;

		const baseEndpoint = getEndpoint(props.collection);

		const endpoint = props.collection.startsWith('directus_')
			? `${baseEndpoint}/${props.primaryKey}`
			: `${baseEndpoint}/${encodeURIComponent(props.primaryKey!)}`;

		let fields = '*';

		if (props.junctionField) {
			fields = `*,${props.junctionField}.*`;
		}

		try {
			const response = await api.get(endpoint, { params: { fields } });

			if (token !== junctionGeneration) return;

			junctionData.value = response.data.data;
			junctionLoaded.value = true;
		} catch (err: any) {
			if (token !== junctionGeneration) return;

			unexpectedError(err);
		} finally {
			if (token === junctionGeneration) junctionLoading.value = false;
		}
	}

	async function fetchRelatedItem(token: number) {
		const collection = relatedCollection.value!;

		relatedLoading.value = true;

		const baseEndpoint = getEndpoint(collection);

		const endpoint = collection.startsWith('directus_')
			? `${baseEndpoint}/${props.relatedPrimaryKey}`
			: `${baseEndpoint}/${encodeURIComponent(props.relatedPrimaryKey)}`;

		try {
			const response = await api.get(endpoint);

			if (token !== relatedGeneration) return;

			relatedData.value = response.data.data;
			relatedLoaded.value = true;
		} catch (err: any) {
			if (token !== relatedGeneration) return;

			unexpectedError(err);
		} finally {
			if (token === relatedGeneration) relatedLoading.value = false;
		}
	}
}

function useRelation() {
	const junctionFieldInfo = computed(() => {
		if (!props.junctionField) return null;

		return fieldsStore.getField(props.collection, props.junctionField);
	});

	const relatedCollection = computed<string | null>(() => {
		if (!props.junctionField) return null;

		// If this is a m2m/m2a, there will be 2 relations associated with this field
		const relations = relationsStore.getRelationsForField(props.collection, props.junctionField);

		const relationForField = relations.find((relation: Relation) => {
			return relation.collection === props.collection && relation.field === props.junctionField;
		});

		if (!relationForField) return null;

		if (relationForField.related_collection) return relationForField.related_collection;

		if (relationForField.meta?.one_collection_field) {
			return (
				props.edits?.[relationForField.meta.one_collection_field] ||
				junctionData.value?.[relationForField.meta.one_collection_field] ||
				null
			);
		}

		return null;
	});

	const collectionField = computed<string | null>(() => {
		if (!props.junctionField) return null;

		const relations = relationsStore.getRelationsForField(props.collection, props.junctionField);

		const relationForField = relations.find((relation: Relation) => {
			return relation.collection === props.collection && relation.field === props.junctionField;
		});

		return relationForField?.meta?.one_collection_field ?? null;
	});

	const { info: relatedCollectionInfo, primaryKeyField: relatedPrimaryKeyField } = useCollection(relatedCollection);

	return {
		junctionFieldInfo,
		relatedCollection,
		relatedCollectionInfo,
		setRelationEdits,
		relatedPrimaryKeyField,
		collectionField,
	};

	function setRelationEdits(edits: any) {
		if (!props.junctionField) return;

		internalEdits.value[props.junctionField] = edits;
	}
}

function useGating() {
	const activeSource = computed(() => internalActive.value);

	const junctionCapabilityKey = computed<string | number | null>(() =>
		isExistingKey(props.primaryKey) ? props.primaryKey ?? null : null
	);

	const junctionCapabilityEnabled = computed(
		() =>
			internalActive.value === true &&
			isExistingKey(props.primaryKey) === true &&
			hasConditionalItemPermission(props.collection, ['update'])
	);

	const { itemPermissions: junctionItemPermissions } = useItemPermissions(
		collection,
		junctionCapabilityKey,
		junctionCapabilityEnabled,
		activeSource
	);

	const relatedCapabilityKey = computed<string | number | null>(() =>
		isExistingKey(props.relatedPrimaryKey) ? props.relatedPrimaryKey ?? null : null
	);

	const relatedCapabilityEnabled = computed(
		() =>
			internalActive.value === true &&
			!!props.junctionField &&
			!!relatedCollection.value &&
			isExistingKey(props.relatedPrimaryKey) === true &&
			hasConditionalItemPermission(relatedCollection.value as string, ['update'])
	);

	const { itemPermissions: relatedItemPermissions } = useItemPermissions(
		relatedCollection as any,
		relatedCapabilityKey,
		relatedCapabilityEnabled,
		activeSource
	);

	const junctionWritableFields = computed<string[] | null>(() =>
		writableFields(
			props.collection,
			isExistingKey(props.primaryKey) ? 'update' : 'create',
			junctionItemPermissions.value
		)
	);

	const relatedWritableFields = computed<string[] | null>(() => {
		if (!relatedCollection.value) return null;

		return writableFields(
			relatedCollection.value,
			isExistingKey(props.relatedPrimaryKey) ? 'update' : 'create',
			relatedItemPermissions.value
		);
	});

	const junctionRelationWritable = computed(() => {
		if (fieldWritable(junctionWritableFields.value, props.junctionField) === false) return false;
		if (collectionField.value) return fieldWritable(junctionWritableFields.value, collectionField.value);
		return true;
	});

	const junctionMode = computed(() => keyMode(props.primaryKey));

	const relatedMode = computed(() => (props.junctionField ? keyMode(props.relatedPrimaryKey) : null));

	const junctionAuthorized = computed(() => {
		if (junctionMode.value === 'create') return createAvailable(props.collection);

		if (junctionMode.value === 'update') {
			return itemActionAllowed(
				props.collection,
				'update',
				junctionItemPermissions.value,
				junctionLoaded.value,
				junctionItemPermissions.value !== null
			);
		}

		return false;
	});

	const relatedRowAuthorized = computed(() => {
		if (!props.junctionField || !relatedCollection.value) return false;
		if (relatedMode.value === 'create') return createAvailable(relatedCollection.value);

		if (relatedMode.value === 'update') {
			return itemActionAllowed(
				relatedCollection.value,
				'update',
				relatedItemPermissions.value,
				relatedLoaded.value,
				relatedItemPermissions.value !== null
			);
		}

		return false;
	});

	const junctionContentEdits = computed<Record<string, any>>(() => {
		if (!props.junctionField) return internalEdits.value;

		const rest = { ...internalEdits.value };
		delete rest[props.junctionField];
		return rest;
	});

	const relatedContentEdits = computed<Record<string, any>>(() =>
		props.junctionField ? internalEdits.value[props.junctionField] ?? {} : {}
	);

	const junctionFiltered = computed(() => pickWritable(junctionContentEdits.value, junctionWritableFields.value));
	const relatedFiltered = computed(() => pickWritable(relatedContentEdits.value, relatedWritableFields.value));

	const junctionHasContent = computed(() =>
		hasMeaningfulContent(junctionFiltered.value, [primaryKeyField.value?.field, collectionField.value])
	);

	const relatedHasContent = computed(() =>
		hasMeaningfulContent(relatedFiltered.value, [relatedPrimaryKeyField.value?.field])
	);

	const relatedOp = computed<'none' | 'content' | 'link' | 'create'>(() => {
		if (!props.junctionField || !relatedCollection.value) return 'none';
		if (junctionRelationWritable.value === false) return 'none';

		if (relatedMode.value === 'create') return relatedRowAuthorized.value ? 'create' : 'none';

		if (relatedMode.value === 'update') {
			if (relatedRowAuthorized.value && relatedHasContent.value) return 'content';
			if (junctionMode.value === 'create') return 'link';
		}

		return 'none';
	});

	const junctionFormDisabled = computed(() => props.disabled || junctionAuthorized.value === false);

	const relatedFormDisabled = computed(
		() =>
			props.disabled ||
			relatedRowAuthorized.value === false ||
			junctionRelationWritable.value === false ||
			junctionAuthorized.value === false
	);

	const operation = computed(() => buildOperation());

	const saveAvailable = computed(
		() => props.disabled === false && internalActive.value === true && operation.value.available
	);

	return { operation, junctionFormDisabled, relatedFormDisabled, saveAvailable };

	function buildOperation(): SaveOperation {
		if (!props.junctionField) {
			let available = false;
			if (junctionMode.value === 'create') available = junctionAuthorized.value;
			else if (junctionMode.value === 'update') available = junctionAuthorized.value && junctionHasContent.value;

			const emit: Record<string, any> = { ...junctionFiltered.value };

			if (junctionMode.value === 'update' && primaryKeyField.value) {
				emit[primaryKeyField.value.field] = props.primaryKey;
			}

			const existing = junctionMode.value === 'create' ? {} : initialValues.value ?? {};
			const state = merge({}, defaultsFor(fieldsWithoutCircular.value), existing, stripStaging(emit));

			return {
				available,
				emit,
				junction: { fields: fieldsWithoutCircular.value, state, isNew: junctionMode.value === 'create' },
				related: null,
			};
		}

		const junctionField = props.junctionField;
		const op = relatedOp.value;
		const relatedReady = op !== 'none' && junctionAuthorized.value;

		const junctionUpdateChange =
			junctionMode.value === 'update' && junctionAuthorized.value && junctionHasContent.value;

		const available = junctionUpdateChange || relatedReady;

		let related: Record<string, any> | null = null;

		if (op === 'content') {
			related = { ...relatedFiltered.value };
			if (relatedPrimaryKeyField.value) related[relatedPrimaryKeyField.value.field] = props.relatedPrimaryKey;
		} else if (op === 'create') {
			related = { ...relatedFiltered.value };
		} else if (op === 'link') {
			related = relatedPrimaryKeyField.value ? { [relatedPrimaryKeyField.value.field]: props.relatedPrimaryKey } : {};
		}

		const emit: Record<string, any> = { ...junctionFiltered.value };
		if (related !== null) emit[junctionField] = related;
		if (collectionField.value && op !== 'none') emit[collectionField.value] = relatedCollection.value;
		if (junctionMode.value === 'update' && primaryKeyField.value) emit[primaryKeyField.value.field] = props.primaryKey;

		const includeJunction =
			junctionMode.value === 'create' ||
			(junctionMode.value === 'update' && (junctionHasContent.value || op !== 'none'));

		let junction: SaveTarget | null = null;

		if (includeJunction) {
			const existing = junctionMode.value === 'create' ? {} : initialValues.value ?? {};
			const state = merge({}, defaultsFor(fieldsWithoutCircular.value), existing, stripStaging(junctionFiltered.value));

			if (related !== null) state[junctionField] = related;

			junction = { fields: fieldsWithoutCircular.value, state, isNew: junctionMode.value === 'create' };
		}

		let relatedTarget: SaveTarget | null = null;

		if (op === 'content' || op === 'create') {
			const existing = relatedMode.value === 'create' ? {} : initialValues.value?.[junctionField] ?? {};

			const state = merge(
				{},
				defaultsFor(relatedCollectionFields.value),
				existing,
				stripStaging(relatedFiltered.value)
			);

			relatedTarget = { fields: relatedCollectionFields.value, state, isNew: relatedMode.value === 'create' };
		}

		return { available, emit, junction, related: relatedTarget };
	}

	function defaultsFor(fields: Field[]): Record<string, any> {
		return getDefaultValuesFromFields(fields).value;
	}

	function createAvailable(collectionName: string | null): boolean {
		if (!collectionName) return false;
		if (userStore.currentUser?.role?.admin_access === true) return true;
		return !!permissionsStore.getPermissionsForUser(collectionName, 'create');
	}

	function writableFields(
		collectionName: string,
		action: 'create' | 'update',
		itemPermissions: ItemPermissions | null
	): string[] | null {
		if (userStore.currentUser?.role?.admin_access === true) return ['*'];

		const permission = permissionsStore.getPermissionsForUser(collectionName, action);
		if (!permission) return null;

		if (action === 'update' && isUnconditional(permission) === false) {
			return itemPermissions?.update.fields ?? null;
		}

		return permission.fields ?? null;
	}

	function isUnconditional(permission: Permission): boolean {
		return !permission.permissions || Object.keys(permission.permissions).length === 0;
	}
}

function useActions() {
	return { save, cancel };

	function save() {
		if (saveAvailable.value !== true) return;

		const plan = operation.value;
		if (plan.available === false) return;

		if (plan.related) {
			const errors = validateItem(plan.related.state, plan.related.fields, plan.related.isNew);

			if (errors.length > 0) {
				relatedValidationErrors.value = errors;
				return;
			}
		}

		relatedValidationErrors.value = [];

		if (plan.junction) {
			const errors = validateItem(plan.junction.state, plan.junction.fields, plan.junction.isNew);

			if (errors.length > 0) {
				junctionValidationErrors.value = errors;
				return;
			}
		}

		junctionValidationErrors.value = [];

		emit('input', plan.emit);

		internalActive.value = false;
		internalEdits.value = {};
	}

	function cancel() {
		junctionValidationErrors.value = [];
		relatedValidationErrors.value = [];
		internalActive.value = false;
		internalEdits.value = {};
	}
}
</script>

<style lang="scss" scoped>
.v-divider {
	margin: 3.25rem 0;
}

.drawer-item-content {
	padding: var(--content-padding);
	padding-bottom: var(--content-padding-bottom);

	.file-preview {
		margin-bottom: var(--form-vertical-gap);
	}
	.drawer-item-order {
		&.swap {
			display: flex;
			flex-direction: column-reverse;
		}
	}
}
</style>
