<template>
	<nav ref="navEl">
		<slot />

		<div
			v-if="resizeable"
			class="resize-handle"
			:class="{ active: handleHover }"
			@pointerenter="handleHover = true"
			@pointerleave="handleHover = false"
			@pointerdown.self="onResizeHandlePointerDown"
			@dblclick="resetNavWidth"
		/>
	</nav>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useEventListener } from '@/composables/use-event-listener';
import { debounce } from 'lodash';

const props = defineProps<{
	resizeable?: boolean;
	minWidth?: number;
	maxWidth?: number;
	width?: number;
}>();

const emit = defineEmits<{
	(e: 'update:width', value: number): void;
}>();

const navEl = ref<HTMLElement>();
const resolvedMinWidth = ref<number>(0);
const handleHover = ref<boolean>(false);
const dragging = ref<boolean>(false);
const dragStartX = ref<number>(0);
const dragStartWidth = ref<number>(0);
const currentWidth = ref<number | null>(null);
const rafId = ref<number | null>(null);

onMounted(() => {
	resolvedMinWidth.value = props.minWidth ? props.minWidth : navEl.value?.offsetWidth || 0;

	if (props.width && navEl.value) navEl.value.style.width = `${props.width}px`;
});

useEventListener(window, 'pointermove', onPointerMove);
useEventListener(window, 'pointerup', onPointerUp);

watch(
	currentWidth,
	debounce((newVal) => {
		emit('update:width', newVal);
	}, 300)
);

function onResizeHandlePointerDown(event: PointerEvent) {
	dragging.value = true;
	dragStartX.value = event.pageX;

	if (navEl.value) {
		dragStartWidth.value = navEl.value.offsetWidth;
	}
}

function resetNavWidth() {
	currentWidth.value = resolvedMinWidth.value;

	if (navEl.value) {
		navEl.value.style.width = `${currentWidth.value}px`;
	}
}

function onPointerMove(event: PointerEvent) {
	if (!dragging.value) return;

	rafId.value = window.requestAnimationFrame(() => {
		currentWidth.value = Math.max(resolvedMinWidth.value, dragStartWidth.value + (event.pageX - dragStartX.value));
		if (props.maxWidth && currentWidth.value >= props.maxWidth) currentWidth.value = props.maxWidth;

		if (currentWidth.value > resolvedMinWidth.value && currentWidth.value <= resolvedMinWidth.value + 10) {
			currentWidth.value = resolvedMinWidth.value; // Snap when nearing min width
		}

		if (navEl.value) {
			navEl.value.style.width = `${currentWidth.value}px`;
		}
	});
}

function onPointerUp() {
	if (!dragging.value) return;

	dragging.value = false;

	if (rafId.value) {
		window.cancelAnimationFrame(rafId.value);
	}
}
</script>

<style lang="scss" scoped>
.resize-handle {
	position: absolute;
	top: 0;
	right: -0.125rem;
	bottom: 0;
	width: 0.25rem;
	background-color: var(--primary);
	cursor: ew-resize;
	opacity: 0;
	transition: opacity var(--fast) var(--transition);
	transition-delay: 0;
	user-select: none;
	touch-action: none;
	z-index: 6;

	&:hover,
	&:active {
		opacity: 1;
	}

	&.active {
		transition-delay: var(--slow);
	}
}
</style>
