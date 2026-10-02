import { describe, test, expect } from 'vitest';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

describe('literal > group', () => {
	describe('nested group', () => {
		test('first', () => expect(1).toBe(1));
		test('second', () => expect(2).toBe(2));
	});
});

test('outside', () => expect(3).toBe(3));
