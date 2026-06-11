<template>
	<div class="v-info" :class="[type, { center }]">
		<div v-if="icon !== false" class="icon">
			<v-icon large :name="icon" />
		</div>
		<h2 class="title type-title">{{ title }}</h2>
		<p class="content"><slot /></p>
		<slot name="append" />
	</div>
</template>

<script setup lang="ts">
import VIcon from './v-icon/v-icon.vue';

interface Props {
	/** The title to display in the info */
	title: string;
	/** What icon to render above the title */
	icon?: string | false;
	/** Styling of the info */
	type?: 'info' | 'success' | 'warning' | 'danger';
	/** Displays the info centered */
	center?: boolean;
}

withDefaults(defineProps<Props>(), {
	icon: false,
	type: 'info',
	center: false,
});
</script>

<style lang="scss" scoped>
.v-info {
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
}

.icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 6.25rem;
	height: 6.25rem;
	margin-bottom: 1rem;
	border-radius: 50%;
}

.info .icon {
	color: var(--foreground-subdued);
	background-color: var(--background-normal);
}

.success .icon {
	color: var(--success);
	background-color: var(--success-alt);
}

.warning .icon {
	color: var(--warning);
	background-color: var(--warning-alt);
}

.danger .icon {
	color: var(--danger);
	background-color: var(--danger-alt);
}

.title {
	margin-bottom: 0.5rem;
}

.content {
	max-width: 18.75rem;
	color: var(--foreground-subdued);
	line-height: 1.375rem;

	&:not(:last-child) {
		margin-bottom: 1.5rem;
	}
}

.center {
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
}
</style>
