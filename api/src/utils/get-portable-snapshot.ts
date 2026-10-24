import type { Knex } from 'knex';
import { UnprocessableEntityException } from '../exceptions/index.js';
import type { PortableSnapshot, Snapshot } from '../types/index.js';
import { toKeyFormSnapshot } from './folder-references.js';

export async function getPortableSnapshot(snapshot: Snapshot, options: { database: Knex }): Promise<PortableSnapshot> {
	const { snapshot: keyForm, unresolved } = await toKeyFormSnapshot(snapshot, options);
	const [reference] = unresolved;

	if (reference) {
		throw new UnprocessableEntityException(
			`Field "${reference.field}" references folder ${JSON.stringify(reference.value)} at ${
				reference.path
			}, which does not exist. Select another folder for this field and take the snapshot again.`
		);
	}

	const { directus, ...rest } = keyForm;

	return { ...rest, version: 2, release: directus };
}
