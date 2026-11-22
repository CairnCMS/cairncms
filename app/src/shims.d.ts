declare module '*.vue' {
	import { DefineComponent } from 'vue';
	// eslint-disable-next-line @typescript-eslint/no-restricted-types -- Vue component declarations use empty generic placeholders for untyped modules.
	const component: DefineComponent<{}, {}, any>;
	export default component;
}

declare module '*.md' {
	import { DefineComponent } from 'vue';
	// eslint-disable-next-line @typescript-eslint/no-restricted-types -- Vue component declarations use empty generic placeholders for untyped modules.
	const component: DefineComponent<{}, {}, any>;
	export default component;
}

declare module '*.yaml' {
	const value: Record<string, any>;
	export default value;
}

declare module '*.json' {
	const value: Record<string, any>;
	export default value;
}

declare module 'jsonlint-mod' {
	const x: any;
	export default x;
}

declare module 'frappe-charts/src/js/charts/AxisChart' {
	export class Chart {
		constructor(element: string, options: Record<string, any>);
	}
}

declare module '@cairncms-extensions' {}

declare module 'codemirror/mode/*' {}

declare module '@mapbox/mapbox-gl-draw-static-mode' {
	import type MapboxDraw from '@mapbox/mapbox-gl-draw';
	const StaticMode: MapboxDraw.DrawCustomMode;
	export default StaticMode;
}
