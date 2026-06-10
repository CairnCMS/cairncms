<template>
	<div class="public-view" :class="{ branded: isBranded }">
		<div class="container" :class="{ wide }">
			<div class="title-box">
				<div
					v-if="info?.project?.project_logo"
					class="logo"
					:style="info?.project.project_color ? { backgroundColor: info.project.project_color } : {}"
				>
					<v-image :src="logoURL" :alt="info?.project.project_name || 'Logo'" />
				</div>
				<div
					v-else
					class="logo"
					:style="info?.project?.project_color ? { backgroundColor: info.project.project_color } : {}"
				>
					<img src="../../assets/logo.svg" alt="CairnCMS" class="cairncms-logo" />
				</div>
				<div class="title">
					<h1 class="type-title">{{ info?.project?.project_name }}</h1>
					<p class="subtitle">{{ info?.project?.project_descriptor ?? t('application') }}</p>
				</div>
			</div>

			<div class="content">
				<slot />
			</div>
			<div class="notice">
				<slot name="notice" />
			</div>
		</div>
		<div class="art" :style="artStyles">
			<transition name="scale">
				<v-image v-if="foregroundURL" class="foreground" :src="foregroundURL" :alt="info?.project?.project_name" />
			</transition>
			<div class="note-container">
				<div v-if="info?.project?.public_note" v-md="info?.project.public_note" class="note" />
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { useServerStore } from '@/stores/server';
import { storeToRefs } from 'pinia';
import { getRootPath } from '@/utils/get-root-path';
import { useI18n } from 'vue-i18n';

interface Props {
	wide?: boolean;
}

withDefaults(defineProps<Props>(), {
	wide: false,
});

const { t } = useI18n();
const serverStore = useServerStore();

const { info } = storeToRefs(serverStore);

const isBranded = computed(() => {
	return info.value?.project?.project_color ? true : false;
});

const hasCustomBackground = computed(() => {
	return !!info.value?.project?.public_background;
});

const artStyles = computed(() => {
	if (!hasCustomBackground.value) return {};

	const url = getRootPath() + `assets/${info.value!.project?.public_background}`;

	return {
		background: `url(${url})`,
		backgroundSize: 'cover',
		backgroundPosition: 'center center',
	};
});

const foregroundURL = computed(() => {
	if (!info.value?.project?.public_foreground) return null;
	return '/assets/' + info.value.project?.public_foreground;
});

const logoURL = computed<string | null>(() => {
	if (!info.value?.project?.project_logo) return null;
	return '/assets/' + info.value.project?.project_logo;
});
</script>

<style lang="scss" scoped>
@import '@/styles/mixins/form-field-sizing';

.public-view {
	display: flex;
	width: 100%;
	height: 100%;

	:slotted(.v-icon) {
		--v-icon-color: var(--foreground-subdued);

		margin-left: 0.25rem;
	}

	.container {
		@include form-field-sizing(3.75rem, 1rem);

		z-index: 2;
		display: flex;
		flex-shrink: 0;
		flex-direction: column;
		justify-content: space-between;
		width: 100%;
		max-width: 31.25rem;
		height: 100%;
		padding: 1.25rem;
		overflow-x: hidden;
		overflow-y: auto;

		/* Page Content Spacing */
		font-size: 0.9375rem;
		line-height: 1.5rem;
		box-shadow: 0 0 40px 0 rgb(38 50 56 / 0.1);
		transition: max-width var(--medium) var(--transition);

		:slotted(.type-title) {
			font-weight: 800;
			font-size: 2.625rem;
			line-height: 3.25rem;
		}

		.content {
			width: 21.25rem;
			max-width: 100%;
		}

		&.wide {
			max-width: 54.5rem;

			.content {
				width: 44.5rem;
			}
		}

		@media (min-width: 500px) {
			padding: 2.5rem 5rem;
		}
	}

	.art {
		position: relative;
		z-index: 1;
		display: none;
		flex-grow: 1;
		align-items: center;
		justify-content: center;
		height: 100%;
		background-image: linear-gradient(135deg, var(--primary-10), var(--primary-50));
		background-position: center center;
		background-size: cover;

		.foreground {
			width: 80%;
			max-width: 25rem;
		}

		.note-container {
			position: absolute;
			right: 0;
			bottom: 2.125rem;
			left: 0;
			display: flex;
			align-items: flex-end;
			justify-content: center;
			height: 0.625rem;

			.note {
				max-width: 21.25rem;
				margin: 0 auto;
				padding: 0.5rem 0.75rem;
				color: var(--foreground-normal);
				font-size: 0.9375rem;
				line-height: 1.5rem;
				background-color: rgb(var(--background-page-rgb) / 0.7);
				border-radius: var(--border-radius);
				backdrop-filter: blur(0.125rem);
			}
		}

		@media (min-width: 500px) {
			display: flex;
		}
	}

	.notice {
		display: flex;
		color: var(--foreground-subdued);
	}

	.title-box {
		display: flex;
		align-items: center;
		width: max-content;
		max-width: 100%;
		height: 4rem;

		.title {
			margin-top: 0.125rem;
			margin-left: 1rem;

			h1 {
				font-weight: 700;
				font-size: 1.125rem;
				line-height: 1.125rem;
			}

			.subtitle {
				width: 100%;
				color: var(--foreground-subdued);
			}
		}
	}

	.logo {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.5rem;
		height: 3.5rem;
		background-color: var(--brand);
		border-radius: calc(var(--border-radius) - 0.125rem);

		img {
			width: 2.5rem;
			height: 2.5rem;
			object-fit: contain;
			object-position: center center;
		}
	}

	&.branded :deep(.v-button) {
		--v-button-background-color: var(--foreground-normal-alt);
		--v-button-background-color-hover: var(--foreground-normal-alt);
		--v-button-background-color-active: var(--foreground-normal-alt);
	}

	&.branded :deep(.v-input) {
		--v-input-border-color-focus: var(--foreground-normal);
		--v-input-box-shadow-color-focus: var(--foreground-normal);
	}

	&.branded :deep(.v-input.solid) {
		--v-input-border-color-focus: var(--foreground-subdued);
	}
}

.scale-enter-active,
.scale-leave-active {
	transition: all 600ms var(--transition);
}

.scale-enter-from,
.scale-leave-to {
	position: absolute;
	transform: scale(0.95);
	opacity: 0;
}
</style>
