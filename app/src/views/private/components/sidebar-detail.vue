<template>
	<div class="sidebar-detail" :class="{ open: sidebarOpen }">
		<button v-tooltip.left="!sidebarOpen && title" class="toggle" :class="{ open: active }" @click="toggle">
			<div class="icon">
				<v-badge :dot="badge === true" bordered :value="badge" :disabled="!badge">
					<v-icon :name="icon" />
				</v-badge>
			</div>
			<div v-show="sidebarOpen" class="title">
				{{ title }}
			</div>
			<div v-if="!close" class="icon">
				<v-icon class="expand-icon" :name="active ? 'expand_less' : 'expand_more'" />
			</div>
		</button>
		<div v-if="close" v-show="sidebarOpen" class="close" @click="sidebarOpen = false">
			<v-icon name="close" />
		</div>
		<transition-expand class="scroll-container">
			<div v-show="active">
				<div class="content">
					<slot />
				</div>
			</div>
		</transition-expand>
	</div>
</template>

<script lang="ts" setup>
import { toRefs } from 'vue';
import { useAppStore } from '@/stores/app';
import { useGroupable } from '@cairncms/composables';

const props = defineProps<{
	icon: string;
	title: string;
	badge?: boolean | string | number;
	close?: boolean;
}>();

const { active, toggle } = useGroupable({
	value: props.title,
	group: 'sidebar-detail',
});

const appStore = useAppStore();
const { sidebarOpen } = toRefs(appStore);
</script>

<style>
body {
	--sidebar-detail-icon-color: var(--foreground-normal-alt);
	--sidebar-detail-color: var(--foreground-normal-alt);
	--sidebar-detail-color-active: var(--primary);
}
</style>

<style lang="scss" scoped>
.sidebar-detail {
	--v-badge-offset-x: 0.1875rem;
	--v-badge-offset-y: 0.25rem;
	--v-badge-border-color: var(--background-normal-alt);
	--v-badge-background-color: var(--primary);
	--v-badge-color: var(--background-normal);

	display: contents;

	:deep(.type-label) {
		margin-bottom: 0.25rem;
		font-size: 0.875rem;
	}

	.toggle {
		position: relative;
		display: flex;
		flex-shrink: 0;
		justify-content: space-between;
		width: 100%;
		height: 3.75rem;
		color: var(--sidebar-detail-color);
		background-color: var(--background-normal-alt);

		.icon {
			--v-icon-color: var(--sidebar-detail-icon-color);

			display: flex;
			align-items: center;
			justify-content: center;
			width: 3.75rem;
			height: 100%;
		}

		&.open,
		&:hover {
			color: var(--sidebar-detail-color-active);

			.icon {
				--v-icon-color: var(--sidebar-detail-color-active);
			}
		}
	}

	.close {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.75rem;
		height: 3.75rem;
		color: var(--foreground-normal);
		cursor: pointer;
		transition: opacity var(--fast) var(--transition), color var(--fast) var(--transition);

		.v-icon {
			pointer-events: none;
		}

		&:hover {
			color: var(--sidebar-detail-color-active);
		}
	}

	&.open {
		.toggle {
			.close {
				opacity: 1;
				pointer-events: auto;
			}
		}
	}

	.title {
		position: absolute;
		top: 50%;
		left: 3.25rem;
		overflow: hidden;
		white-space: nowrap;
		transform: translateY(-50%);
	}

	.scroll-container {
		overflow-x: hidden;
		overflow-y: auto;
	}

	.content {
		padding: 1rem;

		:deep(.page-description) {
			margin-bottom: 0.5rem;
			color: var(--foreground-subdued);
		}

		:deep(.page-description a) {
			color: var(--primary);
		}
	}

	.expand-icon {
		color: var(--foreground-subdued);
	}
}
</style>
