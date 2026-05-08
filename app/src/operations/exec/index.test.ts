import { describe, expect, it } from 'vitest';

import config from './index';

describe('Overview', () => {
	it('Renders empty array', () => {
		expect(config.overview()).toEqual([]);
	});
});

describe('Options', () => {
	it('Returns the code field as the only option', () => {
		expect(config.options()).toHaveLength(1);
	});
});
