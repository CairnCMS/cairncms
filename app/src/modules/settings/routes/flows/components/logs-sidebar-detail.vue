<template>
	<sidebar-detail :title="t('logs')" icon="fact_check" :badge="revisionsCount">
		<v-progress-linear v-if="loading" indeterminate />

		<div v-else-if="revisionsCount === 0" class="empty">{{ t('no_logs') }}</div>

		<v-detail
			v-for="group in revisionsByDate"
			v-else
			:key="group.dateFormatted"
			:label="group.dateFormatted"
			class="revisions-date-group"
			start-open
		>
			<div class="scroll-container">
				<div v-for="revision in group.revisions" :key="revision.id" class="log">
					<button @click="previewing = revision">
						<v-icon name="play_arrow" color="var(--primary)" small />
						{{ revision.timeRelative }}
					</button>
				</div>
			</div>
		</v-detail>
	</sidebar-detail>

	<v-drawer
		:model-value="!!previewing"
		:title="previewing ? previewing.timestampFormatted : t('logs')"
		icon="fact_check"
		@cancel="previewing = null"
		@esc="previewing = null"
	>
		<div class="content">
			<div class="steps">
				<div class="step">
					<div class="header">
						<span class="dot" />
						<span class="type-label">
							{{ t('trigger') }}
							<span class="subdued">&nbsp;{{ usedTrigger?.name }}</span>
						</span>
					</div>

					<div class="inset">
						<v-detail v-if="triggerData.options" :label="t('options')">
							<pre class="json selectable">{{ triggerData.options }}</pre>
						</v-detail>

						<v-detail v-if="triggerData.trigger" :label="t('payload')">
							<pre class="json selectable">{{ triggerData.trigger }}</pre>
						</v-detail>

						<v-detail v-if="triggerData.accountability" :label="t('accountability')">
							<pre class="json selectable">{{ triggerData.accountability }}</pre>
						</v-detail>
					</div>
				</div>

				<div v-for="step of steps" :key="step.id" class="step">
					<div class="header">
						<span class="dot" :class="step.status" />
						<span v-tooltip="step.key" class="type-label">
							{{ step.name }}
							<span class="subdued">&nbsp;{{ step.operationType }}</span>
						</span>
					</div>

					<div class="inset">
						<v-detail v-if="step.options" :label="t('options')">
							<pre class="json selectable">{{ step.options }}</pre>
						</v-detail>

						<v-detail v-if="step.data" :label="t('payload')">
							<pre class="json selectable">{{ step.data }}</pre>
						</v-detail>
					</div>
				</div>
			</div>
		</div>
	</v-drawer>
</template>

<script lang="ts" setup>
import { useRevisions } from '@/composables/use-revisions';
import { useExtensions } from '@/extensions';
import type { FlowRaw } from '@cairncms/types';
import { Action } from '@cairncms/constants';
import { computed, ref, toRefs, unref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getTriggers } from '../triggers';

const { t } = useI18n();

interface Props {
	flow: FlowRaw;
}

const props = defineProps<Props>();

const { flow } = toRefs(props);

const { triggers } = getTriggers();
const { operations } = useExtensions();

const usedTrigger = computed(() => {
	return triggers.find((trigger) => trigger.id === unref(flow).trigger);
});

const { revisionsByDate, revisionsCount, loading } = useRevisions(
	ref('directus_flows'),
	computed(() => unref(flow).id),
	{
		action: Action.RUN,
	}
);

const previewing = ref();

const triggerData = computed(() => {
	if (!unref(previewing)?.data) return { trigger: null, accountability: null, options: null };

	const { data } = unref(previewing).data;

	return {
		trigger: data.$trigger,
		accountability: data.$accountability,
		options: props.flow.options,
	};
});

const steps = computed(() => {
	if (!unref(previewing)?.data?.steps) return [];
	const { steps } = unref(previewing).data;

	return steps.map(
		({
			operation,
			status,
			key,
			options,
		}: {
			operation: string;
			status: 'reject' | 'resolve' | 'unknown';
			key: string;
			options: Record<string, any>;
		}) => {
			const operationConfiguration = props.flow.operations.find((operationConfig) => operationConfig.id === operation);

			const operationType = operations.value.find((operation) => operation.id === operationConfiguration?.type);

			return {
				id: operation,
				name: operationConfiguration?.name ?? key,
				data: unref(previewing).data?.data?.[key] ?? null,
				options: options ?? null,
				operationType: operationType?.name ?? operationConfiguration?.type ?? '--',
				key,
				status,
			};
		}
	);
});
</script>

<style lang="scss" scoped>
.v-progress-linear {
	margin: 1.5rem 0;
}

.content {
	padding: var(--content-padding);
}

.log {
	position: relative;
	display: block;

	button {
		position: relative;
		z-index: 2;
		display: block;
		width: 100%;
		text-align: left;
	}

	&::before {
		position: absolute;
		top: -.25rem;
		left: -.25rem;
		z-index: 1;
		width: calc(100% + .5rem);
		height: calc(100% + .5rem);
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
		margin-top: .5rem;
	}
}

.json {
	background-color: var(--background-subdued);
	font-family: var(--family-monospace);
	border-radius: var(--border-radius);
	padding: 1.25rem;
	margin-top: 1.25rem;
	white-space: pre-wrap;
}

.steps {
	position: relative;

	.step {
		position: relative;

		&::after {
			content: '';
			position: absolute;
			width: var(--border-width);
			left: -.6875rem;
			top: 0;
			background-color: var(--border-subdued);
			height: 100%;
		}

		&:first-child::after {
			top: .5rem;
			height: calc(100% - .5rem);
		}

		&:last-child::after {
			height: .75rem;
		}

		.inset {
			padding-top: .75rem;
			padding-bottom: 2rem;

			.v-detail + .v-detail {
				margin-top: .75rem;
			}
		}

		.subdued {
			color: var(--foreground-subdued);
		}
	}

	.mono {
		font-family: var(--family-monospace);
		color: var(--foreground-subdued);
	}

	.dot {
		position: absolute;
		top: .375rem;
		left: -1rem;
		z-index: 2;
		width: .75rem;
		height: .75rem;
		background-color: var(--primary);
		border: 2px solid var(--background-page);
		border-radius: .5rem;

		&.resolve {
			background-color: var(--primary);
		}

		&.reject {
			background-color: var(--secondary);
		}
	}
}

.empty {
	margin-left: .125rem;
	color: var(--foreground-subdued);
	font-style: italic;
}
</style>
