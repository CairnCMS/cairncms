import type { RasterSourceSpecification, RequestParameters, StyleSpecification } from 'maplibre-gl';
import { getTheme } from '@/utils/get-theme';
import { useSettingsStore } from '@/stores/settings';

const MAPBOX_API = 'https://api.mapbox.com';

export type BasemapSource = {
	name: string;
	type: 'raster' | 'tile' | 'style';
	url: string;
	tileSize?: number;
	attribution?: string;
};

const defaultBasemap: BasemapSource = {
	name: 'OpenStreetMap',
	type: 'raster',
	url: 'https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png',
	tileSize: 256,
	attribution: '© OpenStreetMap contributors',
};

const baseStyle = {
	version: 8 as const,
	glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
};

export function getBasemapSources(): BasemapSource[] {
	const settingsStore = useSettingsStore();

	if (settingsStore.settings?.mapbox_key) {
		return [getDefaultMapboxBasemap(), defaultBasemap, ...(settingsStore.settings?.basemaps || [])];
	}

	return [defaultBasemap, ...(settingsStore.settings?.basemaps || [])];
}

export function getStyleFromBasemapSource(basemap: BasemapSource): StyleSpecification | string {
	if (basemap.type == 'style') {
		const token = useSettingsStore().settings?.mapbox_key;
		return token ? transformMapboxUrl(basemap.url, token) : basemap.url;
	}

	const source: RasterSourceSpecification = { type: 'raster' };

	if (basemap.attribution) source.attribution = basemap.attribution;

	if (basemap.type == 'raster') {
		source.tiles = expandUrl(basemap.url);
		source.tileSize = basemap.tileSize || 512;
	}

	if (basemap.type == 'tile') {
		source.url = basemap.url;
	}

	return {
		...baseStyle,
		sources: { [basemap.name]: source },
		layers: [{ id: basemap.name, source: basemap.name, type: 'raster' }],
	};
}

function expandUrl(url: string): string[] {
	const urls = [];
	let match = /\{([a-z])-([a-z])\}/.exec(url);

	if (match) {
		// char range
		const startCharCode = match[1].charCodeAt(0);
		const stopCharCode = match[2].charCodeAt(0);
		let charCode;

		for (charCode = startCharCode; charCode <= stopCharCode; ++charCode) {
			urls.push(url.replace(match[0], String.fromCharCode(charCode)));
		}

		return urls;
	}

	match = /\{(\d+)-(\d+)\}/.exec(url);

	if (match) {
		// number range
		const stop = parseInt(match[2], 10);

		for (let i = parseInt(match[1], 10); i <= stop; i++) {
			urls.push(url.replace(match[0], i.toString()));
		}

		return urls;
	}

	match = /\{(([a-z0-9]+)(,([a-z0-9]+))+)\}/.exec(url);

	if (match) {
		// csv
		const subdomains = match[1].split(',');

		for (const subdomain of subdomains) {
			urls.push(url.replace(match[0], subdomain));
		}

		return urls;
	}

	urls.push(url);
	return urls;
}

function getDefaultMapboxBasemap(): BasemapSource {
	const defaultMapboxBasemap: BasemapSource = {
		name: 'Mapbox',
		type: 'style',
		url: 'mapbox://styles/mapbox/light-v11',
	};

	if (getTheme() === 'dark') {
		defaultMapboxBasemap.url = 'mapbox://styles/mapbox/dark-v11';
	}

	return defaultMapboxBasemap;
}

export function getMapboxTransformRequest(token: string | undefined) {
	if (!token) return undefined;

	return (url: string): RequestParameters | undefined => {
		if (url.startsWith('mapbox://')) return { url: transformMapboxUrl(url, token) };

		return undefined;
	};
}

export function transformMapboxUrl(url: string, token: string): string {
	if (!url.startsWith('mapbox://')) return url;

	const path = url.slice('mapbox://'.length);

	if (path.startsWith('styles/')) {
		return appendAccessToken(`${MAPBOX_API}/styles/v1/${path.slice('styles/'.length)}`, token);
	}

	if (path.startsWith('fonts/')) {
		return appendAccessToken(`${MAPBOX_API}/fonts/v1/${path.slice('fonts/'.length)}`, token);
	}

	if (path.startsWith('sprites/')) {
		const rest = path.slice('sprites/'.length);
		const separator = rest.indexOf('/');
		const user = rest.slice(0, separator);
		const styleAndSuffix = rest.slice(separator + 1);
		const suffixMatch = /^([^.@]+)(.*)$/.exec(styleAndSuffix);
		const style = suffixMatch ? suffixMatch[1] : styleAndSuffix;
		const suffix = suffixMatch ? suffixMatch[2] : '';
		return appendAccessToken(`${MAPBOX_API}/styles/v1/${user}/${style}/sprite${suffix}`, token);
	}

	if (path.startsWith('tiles/')) {
		return appendAccessToken(`${MAPBOX_API}/v4/${path.slice('tiles/'.length)}`, token);
	}

	const queryStart = path.indexOf('?');
	const tilesets = queryStart === -1 ? path : path.slice(0, queryStart);
	const existingQuery = queryStart === -1 ? '' : path.slice(queryStart + 1);
	const query = ['secure', existingQuery].filter(Boolean).join('&');
	return appendAccessToken(`${MAPBOX_API}/v4/${tilesets}.json?${query}`, token);
}

function appendAccessToken(url: string, token: string): string {
	return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
}
