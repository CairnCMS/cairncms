import { beforeEach } from 'vitest';
import { registerFixtureSetup } from './fixture-registration.mjs';

// Vitest resolves automatic fixtures inside this native hook, before the body timer.
export function initializeFixtures() {
	beforeEach(() => undefined, registerFixtureSetup());
}
