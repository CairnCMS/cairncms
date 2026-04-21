import { expect, test, describe } from 'vitest';
import { getInternalInterfaces } from './index';

/**
 * Vite v3 reworked the glob import with its own internal sorting. This test pins the
 * expected interface sort order against future changes in vite's internal sort behavior.
 */

const expectedInterfacesSortOrder = [
	'boolean',
	'input',
	'input-autocomplete-api',
	'input-code',
	'input-hash',
	'input-multiline',
	'input-rich-text-html',
	'input-rich-text-md',
	'system-collection',
];

describe('interfaces', () => {
	test('getInterfaces() should return the expected sorted order of interfaces', () => {
		const interfaces = getInternalInterfaces();
		const interfaceIds = interfaces.map((inter) => inter.id);
		const interfacesToTest = interfaceIds.filter((inter) => expectedInterfacesSortOrder.includes(inter));

		// test all expected sort order
		expect(interfacesToTest).toEqual(expectedInterfacesSortOrder);
		// test whether input interface is the first one among all the input related interfaces
		expect(interfacesToTest.filter((inter) => inter.includes('input')).findIndex((inter) => inter === 'input')).toBe(0);
		// system-collection should be not be at the start after sorting. Currently it is within the folder called "_system",
		// so it will be the first item by default without our added sort logic in getInterface().
		expect(interfacesToTest.findIndex((inter) => inter === 'system-collection')).not.toBe(0);
	});
});
