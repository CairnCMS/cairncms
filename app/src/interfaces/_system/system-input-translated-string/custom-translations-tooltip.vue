<template>
	<div class="custom-translations-display">
		<v-menu class="menu" show-arrow>
			<template #activator="{ toggle, deactivate, active }">
				<v-icon
					v-tooltip.bottom="translations && translations.length === 0 && t('translations')"
					:small="false"
					class="icon"
					:class="{ active }"
					name="info"
					tabindex="-1"
					@click.stop="clicked(toggle)"
					@blur="deactivate"
				></v-icon>
			</template>

			<v-list class="translations">
				<v-list-item v-if="translations.length === 0">
					<v-list-item-content>
						<div class="header">
							<div class="lang">
								{{ t('loading') }}
							</div>
						</div>
					</v-list-item-content>
				</v-list-item>
				<v-list-item v-for="item in translations" v-else :key="item.language">
					<v-list-item-content>
						<div class="header">
							<div class="lang">
								<v-icon name="translate" small />
								{{ item.language }}
							</div>
						</div>
						<ValueNull v-if="!item.value" />
						<div v-else class="translation-item-text">{{ item.value }}</div>
					</v-list-item-content>
				</v-list-item>
			</v-list>
		</v-menu>
	</div>
</template>

<script lang="ts" setup>
import type { Translation } from '@/stores/translations';
import { fetchAll } from '@/utils/fetch-all';
import { Ref, ref } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
	translationKey: string;
}

const props = defineProps<Props>();

const translations: Ref<Translation[]> = ref([]);
const loading = ref(false);

const { t } = useI18n();

const fetchTranslation = async () => {
	loading.value = true;

	try {
		translations.value = await fetchAll(`/translations`, {
			params: {
				fields: ['language', 'key', 'value'],
				sort: ['language'],
				filter: {
					key: { _eq: props.translationKey },
				},
			},
		});
	} catch {
		translations.value = [];
	} finally {
		loading.value = false;
	}
};

const clicked = (toggleTooltip: () => void) => {
	toggleTooltip();

	if (!loading.value && translations.value.length === 0) {
		fetchTranslation();
	}
};
</script>

<style lang="scss" scoped>
.v-list {
	width: 18.75rem;
}
.custom-translations-display {
	display: flex;
	align-items: center;

	.icon {
		color: var(--foreground-subdued);
		opacity: 0;
		transition: opacity var(--fast) var(--transition);
	}

	&:hover .icon,
	.icon.active {
		opacity: 1;
	}
}

.translation-display-text {
	margin-right: 0.25rem;
	padding: 0.125rem 0;
}

.translation-item-text {
	padding-top: 0.125rem;
}
.translation-display-text,
.translation-item-text {
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.header {
	display: flex;
	gap: 1.25rem;
	align-items: center;
	justify-content: space-between;
	color: var(--foreground-subdued);
	font-size: 0.75rem;

	.lang {
		font-weight: 600;
	}

	.v-icon {
		margin-right: 0.25rem;
	}

	.v-progress-linear {
		flex: 1;
		width: unset;
		max-width: 6.25rem;
		border-radius: 0.125rem;
	}
}

.v-list-item-content {
	padding-top: 0.25rem;
	padding-bottom: 0.125rem;
}

.v-list-item:not(:first-child) {
	.header {
		padding-top: 0.5rem;
		border-top: var(--border-width) solid var(--border-subdued);
	}
}
</style>
