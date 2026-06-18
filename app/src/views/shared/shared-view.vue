<template>
	<div class="shared" :class="{ inline }">
		<div class="inline-container">
			<header>
				<div class="container">
					<div class="title-box">
						<div
							v-if="serverInfo?.project?.project_logo"
							class="logo"
							:style="serverInfo?.project?.project_color ? { backgroundColor: serverInfo.project.project_color } : {}"
						>
							<img :src="logoURL!" :alt="serverInfo?.project.project_name || 'Logo'" />
						</div>
						<div
							v-else
							class="logo"
							:style="serverInfo?.project?.project_color ? { backgroundColor: serverInfo.project.project_color } : {}"
						>
							<img src="../../assets/logo.svg" alt="CairnCMS" class="cairncms-logo" />
						</div>
						<div class="title">
							<p class="subtitle">{{ serverInfo?.project?.project_name }}</p>
							<slot name="title">
								<h1 class="type-title">{{ title ?? t('share_access_page') }}</h1>
							</slot>
						</div>
					</div>
				</div>
			</header>

			<div class="container">
				<div class="content">
					<slot />
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { useServerStore } from '@/stores/server';
import { getRootPath } from '@/utils/get-root-path';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

defineProps<{
	title?: string;
	inline?: boolean;
}>();

const serverStore = useServerStore();

const { info: serverInfo } = storeToRefs(serverStore);

const { t } = useI18n();

const logoURL = computed<string | null>(() => {
	if (!serverStore.info?.project?.project_logo) return null;
	return getRootPath() + `assets/${serverStore.info.project?.project_logo}`;
});
</script>

<style scoped lang="scss">
@import '@/styles/mixins/form-field-sizing';

.shared {
	@include form-field-sizing(3.75rem, 1rem);

	width: 100%;
	height: 100%;
	padding-bottom: 4rem;
	overflow: auto;
	background-color: var(--background-subdued);
}

.inline-container {
	display: contents;
}

header {
	margin-bottom: 2rem;
	padding: 0.625rem;
	background-color: var(--background-page);
	border-bottom: var(--border-width) solid var(--border-subdued);
}

.container {
	max-width: 53.5rem;
	margin: 0 auto;
}

.title-box {
	display: flex;
	align-items: center;
	width: max-content;
	max-width: 100%;
	height: 3.75rem;
	margin-top: 0.125rem;

	.title {
		margin-left: 1rem;

		h1 {
			color: var(--foreground-normal);
			font-weight: 700;
			font-size: 1.5rem;
			line-height: 1.5rem;
		}

		.subtitle {
			width: 100%;
			color: var(--foreground-subdued);
		}
	}
}

.logo {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 3.75rem;
	height: 3.75rem;
	background-color: var(--brand);
	border-radius: var(--border-radius);

	img {
		width: 2.5rem;
		height: 2.5rem;
		object-fit: contain;
		object-position: center center;
	}
}

.content {
	padding: 2rem;
	background-color: var(--background-page);
	border-radius: var(--border-radius);
	box-shadow: 0px 4px 12px rgba(56, 62, 71, 0.08);
}

.inline {
	display: flex;
	align-items: center;
	justify-content: center;

	.inline-container {
		display: block;
		width: 100%;
		max-width: 53.5rem;
		padding: 2rem;
		background-color: var(--background-page);
		border-radius: var(--border-radius);
		box-shadow: 0px 4px 12px rgba(56, 62, 71, 0.08);

		@media (min-width: 618px) {
			width: 38.625rem;
		}
	}

	header {
		padding: 0;
		border-bottom: 0;
	}

	.container {
		display: contents;
	}

	.content {
		display: contents;
	}
}
</style>
