<template>
	<div class="display-labels">
		<template v-if="!showAsDot">
			<v-chip
				v-for="item in items"
				:key="item.value"
				:style="{
					'--v-chip-color': item.foreground,
					'--v-chip-background-color': item.background,
				}"
				small
				disabled
				:label="false"
				:class="{ 'has-dot': !!item.dotColor }"
			>
				<span v-if="item.dotColor" class="label-dot" :style="{ backgroundColor: item.dotColor }" />
				{{ item.text }}
			</v-chip>
		</template>
		<template v-else>
			<display-color v-for="item in items" :key="item.value" v-tooltip="item.text" :value="item.dotColor ?? item.background" />
		</template>
	</div>
</template>

<script setup lang="ts">
import formatTitle from '@cairncms/format-title';
import { isEmpty } from 'lodash';
import { computed } from 'vue';

type Choice = {
	value: string;
	text: string;
	foreground: string | null;
	background: string | null;
	color: string | null;
};

const props = withDefaults(
	defineProps<{
		value: string | string[];
		type: 'text' | 'string' | 'json' | 'csv';
		format?: boolean;
		showAsDot?: boolean;
		choices?: Choice[];
	}>(),
	{
		format: true,
		choices: () => [],
	}
);

const items = computed(() => {
	let items: string[];

	if (isEmpty(props.value)) items = [];
	else if (props.type === 'string') items = [props.value as string];
	else items = props.value as string[];

	return items.map((item) => {
		const choice = (props.choices || []).find((choice) => choice.value === item);

		let itemStringValue: string;

		if (typeof item === 'object') {
			itemStringValue = JSON.stringify(item);
		} else {
			if (props.format) {
				itemStringValue = formatTitle(item);
			} else {
				itemStringValue = item;
			}
		}

		if (choice === undefined) {
			return {
				value: item,
				text: itemStringValue,
				foreground: 'var(--foreground-normal)',
				background: 'var(--background-normal)',
				dotColor: null,
			};
		} else {
			return {
				value: item,
				text: choice.text || itemStringValue,
				foreground: choice.foreground || 'var(--foreground-normal)',
				background: choice.background || 'var(--background-normal)',
				dotColor: choice.color || null,
			};
		}
	});
});
</script>

<style lang="scss" scoped>
.display-labels {
	display: inline-flex;
}

:deep(.v-chip.small) {
	--v-chip-height-small: 22px;
	--v-chip-padding-small: 0 9px;
	--v-chip-border-radius-small: 16px;
}

.v-chip.has-dot {
	--v-chip-padding-small: 0 10px 0 8px;
}

.label-dot {
	display: inline-block;
	flex-shrink: 0;
	width: 6px;
	height: 6px;
	margin-right: 6px;
	border-radius: 50%;
	vertical-align: middle;
}

.v-chip + .v-chip {
	margin-left: 4px;
}
</style>
