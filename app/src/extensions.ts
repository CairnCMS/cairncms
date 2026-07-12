import { AppExtensionConfigs, RefRecord } from '@cairncms/types';
import { App, shallowRef, watch } from 'vue';
import { getInternalDisplays, registerDisplays } from './displays';
import { getInternalInterfaces, registerInterfaces } from './interfaces';
import { getInternalItemViews } from './item-views';
import { i18n } from './lang';
import { getInternalLayouts, registerLayouts } from './layouts';
import { getInternalModules, registerModules } from './modules';
import { getInternalOperations, registerOperations } from './operations';
import { getInternalPanels, registerPanels } from './panels';
import { getRootPath } from './utils/get-root-path';
import { translate } from './utils/translate-object-values';

let customExtensions: AppExtensionConfigs | null = null;

const extensions: RefRecord<AppExtensionConfigs> = {
	interfaces: shallowRef([]),
	displays: shallowRef([]),
	layouts: shallowRef([]),
	modules: shallowRef([]),
	panels: shallowRef([]),
	'item-views': shallowRef([]),
	operations: shallowRef([]),
};

const onHydrateCallbacks: (() => Promise<void>)[] = [];
const onDehydrateCallbacks: (() => Promise<void>)[] = [];

export async function loadExtensions(): Promise<void> {
	try {
		const loaded = import.meta.env.DEV
			? await import(/* @vite-ignore */ '@cairncms-extensions')
			: await import(/* @vite-ignore */ `${getRootPath()}extensions/sources/index.js`);

		// The entrypoint loads and registers each extension in isolation, resolving
		// `ready` once every load has settled and pushed. Await it before exposing the
		// module, so registerExtensions never reads a partially populated inventory and
		// a rejection leaves customExtensions null. Absent on an empty entrypoint.
		await (loaded as { ready?: Promise<unknown> } | null)?.ready;

		customExtensions = loaded;
	} catch (err: any) {
		// eslint-disable-next-line no-console
		console.warn(`Couldn't load extensions`);
		// eslint-disable-next-line no-console
		console.warn(err);
	}
}

export function registerExtensions(app: App): void {
	const interfaces = getInternalInterfaces();
	const displays = getInternalDisplays();
	const layouts = getInternalLayouts();
	const modules = getInternalModules();
	const panels = getInternalPanels();
	const itemViews = getInternalItemViews();
	const operations = getInternalOperations();

	if (customExtensions !== null) {
		interfaces.push(...customExtensions.interfaces);
		displays.push(...customExtensions.displays);
		layouts.push(...customExtensions.layouts);
		modules.push(...customExtensions.modules);
		panels.push(...customExtensions.panels);
		itemViews.push(...(customExtensions['item-views'] ?? []));
		operations.push(...customExtensions.operations);
	}

	registerInterfaces(interfaces, app);
	registerDisplays(displays, app);
	registerLayouts(layouts, app);
	registerPanels(panels, app);
	registerOperations(operations, app);

	watch(
		i18n.global.locale,
		() => {
			extensions.interfaces.value = translate(interfaces);
			extensions.displays.value = translate(displays);
			extensions.layouts.value = translate(layouts);
			extensions.panels.value = translate(panels);
			extensions['item-views'].value = translate(itemViews);
			extensions.operations.value = translate(operations);
		},
		{ immediate: true }
	);

	const { registeredModules, onHydrateModules, onDehydrateModules } = registerModules(modules);

	watch(
		[i18n.global.locale, registeredModules],
		() => {
			extensions.modules.value = translate(registeredModules.value);
		},
		{ immediate: true }
	);

	onHydrateCallbacks.push(onHydrateModules);
	onDehydrateCallbacks.push(onDehydrateModules);
}

export async function onHydrateExtensions() {
	await Promise.all(onHydrateCallbacks.map((onHydrate) => onHydrate()));
}

export async function onDehydrateExtensions() {
	await Promise.all(onDehydrateCallbacks.map((onDehydrate) => onDehydrate()));
}

export function useExtensions(): RefRecord<AppExtensionConfigs> {
	return extensions;
}
