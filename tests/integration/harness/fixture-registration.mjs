export const registrationKey = Symbol.for('cairncms.integration.fixtureRegistration');

export function registerFixtureSetup() {
	const registration = globalThis[registrationKey];
	if (!registration) throw new Error('Fixture initialization requires the integration runner');
	if (registration.initialized) throw new Error('Initialize fixtures once at module scope');
	registration.initialized = true;
	registration.timeout = registration.config.hookTimeout;
	return registration.timeout;
}

export function validateFixtureSetup(registration) {
	if (!registration.initialized)
		throw new Error('Missing initializeFixtures() at module scope; register it after file configuration');
	if (registration.timeout !== registration.config.hookTimeout)
		throw new Error('Hook timeout changed after initializeFixtures(); configure the file before initializing fixtures');
}
