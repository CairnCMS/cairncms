import { describe, expect, it } from 'vitest';
import { getMapboxTransformRequest, transformMapboxUrl } from './basemap';

const TOKEN = 'pk.test-token';

describe('transformMapboxUrl', () => {
	it('resolves a style url', () => {
		expect(transformMapboxUrl('mapbox://styles/mapbox/light-v11', TOKEN)).toBe(
			`https://api.mapbox.com/styles/v1/mapbox/light-v11?access_token=${TOKEN}`
		);
	});

	it('resolves a glyph url', () => {
		expect(transformMapboxUrl('mapbox://fonts/mapbox/{fontstack}/{range}.pbf', TOKEN)).toBe(
			`https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${TOKEN}`
		);
	});

	it('resolves a sprite json url', () => {
		expect(transformMapboxUrl('mapbox://sprites/mapbox/light-v11.json', TOKEN)).toBe(
			`https://api.mapbox.com/styles/v1/mapbox/light-v11/sprite.json?access_token=${TOKEN}`
		);
	});

	it('resolves a high-dpi sprite image url', () => {
		expect(transformMapboxUrl('mapbox://sprites/mapbox/light-v11@2x.png', TOKEN)).toBe(
			`https://api.mapbox.com/styles/v1/mapbox/light-v11/sprite@2x.png?access_token=${TOKEN}`
		);
	});

	it('resolves a sprite base url without a suffix', () => {
		expect(transformMapboxUrl('mapbox://sprites/mapbox/light-v11', TOKEN)).toBe(
			`https://api.mapbox.com/styles/v1/mapbox/light-v11/sprite?access_token=${TOKEN}`
		);
	});

	it('resolves a single tileset source url', () => {
		expect(transformMapboxUrl('mapbox://mapbox.mapbox-streets-v8', TOKEN)).toBe(
			`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure&access_token=${TOKEN}`
		);
	});

	it('resolves a composite tileset source url', () => {
		expect(transformMapboxUrl('mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2', TOKEN)).toBe(
			`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure&access_token=${TOKEN}`
		);
	});

	it('resolves a source url that already carries query parameters', () => {
		expect(transformMapboxUrl('mapbox://mapbox.mapbox-streets-v8?fresh=1', TOKEN)).toBe(
			`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure&fresh=1&access_token=${TOKEN}`
		);
	});

	it('resolves a tile url', () => {
		expect(transformMapboxUrl('mapbox://tiles/mapbox.satellite/1/2/3.webp', TOKEN)).toBe(
			`https://api.mapbox.com/v4/mapbox.satellite/1/2/3.webp?access_token=${TOKEN}`
		);
	});

	it('leaves a non-mapbox url untouched and adds no token', () => {
		const url = 'https://tiles.example.com/{z}/{x}/{y}.png';
		expect(transformMapboxUrl(url, TOKEN)).toBe(url);
	});
});

describe('getMapboxTransformRequest', () => {
	it('returns undefined without a token', () => {
		expect(getMapboxTransformRequest(undefined)).toBeUndefined();
		expect(getMapboxTransformRequest('')).toBeUndefined();
	});

	it('rewrites mapbox urls', () => {
		const transform = getMapboxTransformRequest(TOKEN)!;

		expect(transform('mapbox://styles/mapbox/light-v11')).toEqual({
			url: `https://api.mapbox.com/styles/v1/mapbox/light-v11?access_token=${TOKEN}`,
		});
	});

	it('never sends the token to a non-mapbox url', () => {
		const transform = getMapboxTransformRequest(TOKEN)!;

		expect(transform('https://tiles.example.com/1/2/3.png')).toBeUndefined();
		expect(transform('https://fonts.openmaptiles.org/{fontstack}/{range}.pbf')).toBeUndefined();
	});
});
