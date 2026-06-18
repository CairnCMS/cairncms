<template>
	<component
		:is="url ? 'a' : 'div'"
		v-tooltip.right="urlTooltip"
		:href="url"
		:target="url ? '_blank' : undefined"
		:rel="url ? 'noopener noreferrer' : undefined"
		class="module-bar-logo"
		:class="{ loading: showLoader }"
	>
		<template v-if="customLogoPath">
			<transition name="fade">
				<v-progress-linear v-if="showLoader" indeterminate rounded @animationiteration="stopSpinnerIfQueueIsEmpty" />
			</transition>
			<img class="custom-logo" :src="customLogoPath" alt="Project Logo" />
		</template>
		<div v-else class="logo" :class="{ running: showLoader }" @animationiteration="stopSpinnerIfQueueIsEmpty" />
	</component>
</template>

<script lang="ts" setup>
import { useRequestsStore } from '@/stores/requests';
import { useSettingsStore } from '@/stores/settings';
import { computed, ref, toRefs, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getRootPath } from '@/utils/get-root-path';

const { t } = useI18n();

const requestsStore = useRequestsStore();
const settingsStore = useSettingsStore();

const customLogoPath = computed<string | null>(() => {
	if (settingsStore.settings === null) return null;
	if (!settingsStore.settings?.project_logo) return null;
	return `${getRootPath()}assets/${settingsStore.settings.project_logo}`;
});

const showLoader = ref(false);

const { queueHasItems } = toRefs(requestsStore);

watch(
	() => queueHasItems.value,
	(hasItems) => {
		if (hasItems) showLoader.value = true;
	}
);

const url = computed(() => settingsStore.settings?.project_url);

const urlTooltip = computed(() => {
	return settingsStore.settings?.project_url ? t('view_project') : false;
});

function stopSpinnerIfQueueIsEmpty() {
	if (queueHasItems.value === false) showLoader.value = false;
}
</script>

<style lang="scss" scoped>
.module-bar-logo {
	--v-progress-linear-height: 0.125rem;
	--v-progress-linear-color: var(--white);
	--v-progress-linear-background-color: rgb(255 255 255 / 0.5);

	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 3.75rem;
	height: 3.75rem;
	padding: 0.75rem;
	background-color: var(--brand);

	.v-progress-linear {
		position: absolute;
		right: 0.625rem;
		bottom: 0.3125rem;
		left: 0.625rem;
		width: 2.5rem;
	}

	.custom-logo {
		display: block;
		width: 2.5rem;
		height: 2.5rem;
		object-fit: contain;
	}

	.logo {
		position: absolute;
		top: 1.125rem;
		left: 0.625rem;
		width: 2.5rem;
		height: 2rem;
		margin: 0 auto;
		overflow: hidden;
	}

	.logo::before {
		content: '';
		display: block;
		width: 37.5rem;
		height: 2rem;
		background-image: url('../../../assets/sprite.svg');
		background-repeat: no-repeat;
		background-size: 37.5rem 2rem;
		background-position: 0 0;
	}

	.logo.running::before {
		animation: 600ms run steps(15, jump-none) infinite;
	}
}

.fade-enter-active {
	transition: opacity var(--slow) var(--transition);
}

.fade-leave-active {
	transition: opacity var(--medium) var(--transition);
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

@keyframes run {
	100% {
		transform: translate3d(-35rem, 0, 0);
	}
}
</style>
