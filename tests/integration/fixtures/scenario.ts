import { createIdentityTest } from './identities';
import type { Api, EnvironmentOptions } from './environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';

export function createScenarioTest(options: {
	environment?: EnvironmentOptions;
	prepare: (api: Api, vendor: string) => Promise<void>;
	cleanup: (api: Api, vendor: string) => Promise<void>;
}) {
	return createIdentityTest(options.environment ?? {}).extend<{ scenarioState: Prerequisite<void>; scenario: void }>({
		scenarioState: [
			async ({ apiState, identityState, vendor, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				if (!identityState.ok) return use(identityState);
				const api = apiState.value;

				await capturePrerequisite<void>(
					async (ready) => {
						try {
							await options.prepare(api, vendor);
							await ready();
						} finally {
							try {
								await options.cleanup(api, vendor);
							} catch (error) {
								teardownFailures.push(error);
							}
						}
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		scenario: [
			async ({ api, identities, scenarioState, task, skip }, use) => {
				void api;
				void identities;
				requirePrerequisite(scenarioState, 'scenario setup', { task, skip });
				await use();
			},
			{ auto: true },
		],
	});
}
