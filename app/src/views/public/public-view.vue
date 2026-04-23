<template>
	<div class="public-view" :class="{ branded: isBranded }">
		<div class="container" :class="{ wide }">
			<div class="title-box">
				<div v-if="info?.project?.project_logo" class="logo" :style="{ backgroundColor: info?.project.project_color }">
					<v-image :src="logoURL" :alt="info?.project.project_name || 'Logo'" />
				</div>
				<div v-else class="logo" :style="{ backgroundColor: info?.project?.project_color }">
					<img src="./logo-dark.svg" alt="CairnCMS" class="cairncms-logo" />
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
			<svg
				v-if="!hasCustomBackground"
				class="fallback"
				viewBox="0 0 1152 1152"
				preserveAspectRatio="xMidYMid slice"
				role="presentation"
			>
				<defs>
					<radialGradient id="cx-base" cx="0.5" cy="0.42" r="0.75">
						<stop offset="0" :stop-color="colors.baseTop" />
						<stop offset="0.55" :stop-color="colors.baseMid" />
						<stop offset="1" :stop-color="colors.baseEdge" />
					</radialGradient>
					<radialGradient id="cx-bloom" cx="0.5" cy="0.38" r="0.45">
						<stop offset="0" :stop-color="colors.bloomCore" stop-opacity="0.85" />
						<stop offset="0.18" :stop-color="colors.bloomInner" stop-opacity="0.55" />
						<stop offset="0.45" :stop-color="colors.bloomOuter" stop-opacity="0.18" />
						<stop offset="1" :stop-color="colors.ember" stop-opacity="0" />
					</radialGradient>
				</defs>
				<rect width="1152" height="1152" fill="url(#cx-base)" />
				<g :fill="colors.emberLight" fill-opacity="0.08">
					<polygon points="0,0 420,0 180,360" />
					<polygon points="420,0 900,0 640,300" />
					<polygon points="900,0 1152,0 1152,280" />
					<polygon points="1152,280 1152,640 880,440" />
					<polygon points="0,360 300,540 0,700" />
					<polygon points="0,700 360,820 0,1000" />
					<polygon points="0,1000 420,1152 0,1152" />
					<polygon points="420,1152 820,1152 580,900" />
					<polygon points="820,1152 1152,1152 1152,800" />
					<polygon points="1152,800 1152,640 880,440 640,720" />
				</g>
				<g :fill="colors.ember" fill-opacity="0.12">
					<polygon points="180,360 420,0 640,300" />
					<polygon points="640,300 900,0 880,440" />
					<polygon points="180,360 640,300 420,540" />
					<polygon points="640,300 880,440 620,560" />
					<polygon points="420,540 620,560 480,780" />
					<polygon points="880,440 1152,640 760,720" />
					<polygon points="620,560 880,440 760,720" />
					<polygon points="480,780 760,720 580,900" />
					<polygon points="300,540 420,540 180,700" />
					<polygon points="180,700 420,540 420,820" />
					<polygon points="420,820 480,780 360,960" />
					<polygon points="360,960 580,900 420,1060" />
					<polygon points="760,720 1152,800 820,960" />
					<polygon points="580,900 820,960 680,1100" />
				</g>
				<g class="cx-cream" :fill="colors.cream" fill-opacity="0.22">
					<polygon points="480,220 620,140 560,340" />
					<polygon points="560,340 700,280 620,460" />
					<polygon points="620,460 760,400 680,560" />
					<polygon points="400,280 520,340 420,460" />
					<polygon points="700,180 800,140 740,280" />
					<polygon points="820,340 900,280 880,440" />
					<polygon points="540,480 660,540 580,640" />
				</g>
				<g :fill="colors.dark" fill-opacity="0.35">
					<polygon points="0,0 120,0 0,180" />
					<polygon points="1032,0 1152,0 1152,140" />
					<polygon points="0,960 120,1100 0,1152" />
					<polygon points="1040,1020 1152,1000 1152,1152 1000,1152" />
					<polygon points="1152,420 1000,520 1152,620" />
					<polygon points="0,280 120,420 0,520" />
				</g>
				<g fill="none" :stroke="colors.edgePaper" stroke-opacity="0.08" stroke-width="0.8">
					<polyline points="0,360 180,360 420,0" />
					<polyline points="420,0 640,300 900,0" />
					<polyline points="900,0 880,440 1152,640" />
					<polyline points="880,440 760,720 1152,800" />
					<polyline points="640,300 620,560 480,780" />
					<polyline points="420,540 620,560" />
					<polyline points="300,540 420,540 180,700" />
					<polyline points="180,700 420,820 360,960" />
					<polyline points="360,960 580,900 680,1100" />
					<polyline points="820,960 580,900" />
					<polyline points="420,1060 680,1100" />
					<polyline points="1152,800 820,960" />
				</g>
				<g fill="none" :stroke="colors.edgeBright" stroke-opacity="0.18" stroke-width="1">
					<polyline points="420,0 640,300 900,0" />
					<polyline points="480,220 620,140 700,180 800,140" />
					<polyline points="560,340 700,280 820,340 900,280" />
				</g>
				<rect width="1152" height="1152" fill="url(#cx-bloom)" />
			</svg>
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
import { cssVar } from '@cairncms/utils/browser';
import Color from 'color';

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
	if (!hasCustomBackground.value) return null;

	const url = getRootPath() + `assets/${info.value!.project?.public_background}`;

	return {
		background: `url(${url})`,
		backgroundSize: 'cover',
		backgroundPosition: 'center center',
	};
});

const colors = computed(() => {
	const primary = info.value?.project?.project_color || 'var(--primary)';
	const primaryHex = primary.startsWith('var(--') ? cssVar(primary.substring(4, primary.length - 1)) : primary;
	const p = Color(primaryHex);

	return {
		baseTop: p.darken(0.4).hex(),
		baseMid: p.darken(0.55).hex(),
		baseEdge: p.darken(0.7).hex(),
		bloomCore: p.lighten(0.3).hex(),
		bloomInner: p.lighten(0.2).hex(),
		bloomOuter: p.lighten(0.1).hex(),
		emberLight: p.lighten(0.2).hex(),
		ember: p.hex(),
		cream: p.lighten(0.65).hex(),
		dark: p.darken(0.92).hex(),
		edgePaper: p.lighten(0.85).hex(),
		edgeBright: p.lighten(0.75).hex(),
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
.public-view {
	display: flex;
	width: 100%;
	height: 100%;

	:slotted(.v-icon) {
		--v-icon-color: var(--foreground-subdued);

		margin-left: 4px;
	}

	.container {
		--border-radius: 2px;
		--input-height: 60px;
		--input-padding: 16px; /* (60 - 4 - 24) / 2 */

		z-index: 2;
		display: flex;
		flex-shrink: 0;
		flex-direction: column;
		justify-content: space-between;
		width: 100%;
		max-width: 500px;
		height: 100%;
		padding: 20px;
		overflow-x: hidden;
		overflow-y: auto;

		/* Page Content Spacing */
		font-size: 15px;
		line-height: 24px;
		box-shadow: 0 0 40px 0 rgb(38 50 56 / 0.1);
		transition: max-width var(--medium) var(--transition);

		:slotted(.type-title) {
			font-weight: 800;
			font-size: 42px;
			line-height: 52px;
		}

		.content {
			width: 340px;
			max-width: 100%;
		}

		&.wide {
			max-width: 872px;

			.content {
				width: 712px;
			}
		}

		@media (min-width: 500px) {
			padding: 40px 80px;
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
		background-position: center center;
		background-size: cover;

		.fallback {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			z-index: -1;

			.cx-bloom {
				animation: cx-bloom-pulse 12s ease-in-out infinite;
			}

			.cx-cream polygon {
				animation: cx-cream-shimmer 8s ease-in-out infinite;
			}

			.cx-cream polygon:nth-child(2) {
				animation-delay: -1.1s;
			}
			.cx-cream polygon:nth-child(3) {
				animation-delay: -2.3s;
			}
			.cx-cream polygon:nth-child(4) {
				animation-delay: -3.5s;
			}
			.cx-cream polygon:nth-child(5) {
				animation-delay: -4.7s;
			}
			.cx-cream polygon:nth-child(6) {
				animation-delay: -5.9s;
			}
			.cx-cream polygon:nth-child(7) {
				animation-delay: -6.4s;
			}
		}

		.foreground {
			width: 80%;
			max-width: 400px;
		}

		.note-container {
			position: absolute;
			right: 0;
			bottom: 34px;
			left: 0;
			display: flex;
			align-items: flex-end;
			justify-content: center;
			height: 10px;

			.note {
				max-width: 340px;
				margin: 0 auto;
				padding: 8px 12px;
				color: var(--white);
				font-size: 15px;
				line-height: 24px;
				background-color: rgb(38 50 56 / 0.2);
				border-radius: 2px;
				backdrop-filter: blur(2px);
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
		height: 64px;

		.title {
			margin-top: 2px;
			margin-left: 16px;

			h1 {
				font-weight: 700;
				font-size: 18px;
				line-height: 18px;
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
		width: 56px;
		height: 56px;
		background-color: var(--brand);
		border-radius: calc(var(--border-radius) - 2px);

		img {
			width: 40px;
			height: 40px;
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

@keyframes cx-bloom-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.75;
	}
}

@keyframes cx-cream-shimmer {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.3;
	}
}

@media (prefers-reduced-motion: reduce) {
	.fallback .cx-bloom,
	.fallback .cx-cream polygon {
		animation: none;
	}
}
</style>
