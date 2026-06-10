<template>
	<div class="revision-item" :class="{ last }" @click="$emit('click')">
		<div class="header">
			<span class="dot" :class="revision.activity.action" />
			{{ headerMessage }}
		</div>
		<div class="content">
			<span class="time">{{ time }}</span>
			–
			<user-popover
				v-if="revision.activity.user"
				class="user"
				:user="typeof revision.activity.user === 'string' ? revision.activity.user : revision.activity.user.id"
			>
				<span>{{ user }}</span>
			</user-popover>

			<span v-else>{{ t('private_user') }}</span>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { Revision } from '@/types/revisions';
import { userName } from '@/utils/user-name';
import { format } from 'date-fns';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
	revision: Revision;
	last?: boolean;
}>();

defineEmits<{
	(e: 'click'): void;
}>();

const { t } = useI18n();

const revisionCount = computed(() => {
	return Object.keys(props.revision.delta).length;
});

const headerMessage = computed(() => {
	switch (props.revision.activity.action.toLowerCase()) {
		case 'create':
			return t('revision_delta_created');
		case 'update':
			return t('revision_delta_updated', revisionCount.value);
		case 'delete':
			return t('revision_delta_deleted');
		case 'revert':
			return t('revision_delta_reverted');
		default:
			return t('revision_delta_other');
	}
});

const time = computed(() => {
	return format(new Date(props.revision.activity.timestamp), String(t('date-fns_time')));
});

const user = computed(() => {
	if (props.revision?.activity?.user && typeof props.revision.activity.user === 'object') {
		return userName(props.revision.activity.user);
	}

	return t('private_user');
});
</script>

<style lang="scss" scoped>
.revision-item {
	position: relative;
	margin-bottom: .75rem;
	margin-left: 1rem;

	.header {
		position: relative;
		z-index: 2;
		font-weight: 600;

		.dot {
			position: absolute;
			top: .375rem;
			left: -1.125rem;
			z-index: 2;
			width: .75rem;
			height: .75rem;
			background-color: var(--warning);
			border: 2px solid var(--background-normal);
			border-radius: .5rem;

			&.create {
				background-color: var(--primary);
			}

			&.update {
				background-color: var(--primary);
			}

			&.delete {
				background-color: var(--danger);
			}
		}
	}

	&:not(.last)::after {
		position: absolute;
		top: .75rem;
		left: -.8125rem;
		z-index: 1;
		width: .125rem;
		height: calc(100% + .75rem);
		background-color: var(--background-normal-alt);
		content: '';
	}

	&::before {
		position: absolute;
		top: -.25rem;
		left: -1.5rem;
		z-index: 1;
		width: calc(100% + 2rem);
		height: calc(100% + .625rem);
		background-color: var(--background-normal-alt);
		border-radius: var(--border-radius);
		opacity: 0;
		transition: opacity var(--fast) var(--transition);
		content: '';
		pointer-events: none;
	}

	&:hover {
		cursor: pointer;

		.header {
			.dot {
				border-color: var(--background-normal-alt);
			}
		}

		&::before {
			opacity: 1;
		}
	}

	& + & {
		margin-top: .75rem;
	}
}

.content {
	position: relative;
	z-index: 2;
	color: var(--foreground-subdued);
	line-height: 1rem;

	.time {
		text-transform: lowercase;
		font-feature-settings: 'tnum';
	}

	.user {
		span {
			margin: -.375rem;
			padding: .375rem;
		}

		&:hover {
			color: var(--foreground-normal);
		}
	}
}
</style>
