import type { Accountability } from '@cairncms/types';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import { ForbiddenException } from '../exceptions/index.js';
import type {
	AbstractServiceOptions,
	PortableSnapshot,
	Snapshot,
	SnapshotDiff,
	SnapshotDiffWithHash,
	SnapshotWithHash,
} from '../types/index.js';
import { applyDiff } from '../utils/apply-diff.js';
import { toKeyFormSnapshot, type KeyFormState } from '../utils/folder-references.js';
import { getPortableSnapshot } from '../utils/get-portable-snapshot.js';
import { getSnapshot } from '../utils/get-snapshot.js';
import { getTargetSnapshotDiff } from '../utils/get-target-snapshot-diff.js';
import { getVersionedHash } from '../utils/get-versioned-hash.js';
import { DEFAULT_SNAPSHOT_VERSION, type SnapshotVersion } from '../utils/schema-contract.js';
import { validateApplyDiff } from '../utils/validate-diff.js';
import { validateSnapshot } from '../utils/validate-snapshot.js';

export class SchemaService {
	knex: Knex;
	accountability: Accountability | null;

	constructor(options: Omit<AbstractServiceOptions, 'schema'>) {
		this.knex = options.knex ?? getDatabase();
		this.accountability = options.accountability ?? null;
	}

	async snapshot(options: { version: 1 }): Promise<Snapshot>;
	async snapshot(options: { version: 2 }): Promise<PortableSnapshot>;
	async snapshot(options?: { version?: SnapshotVersion }): Promise<Snapshot | PortableSnapshot>;
	async snapshot(options?: { version?: SnapshotVersion }): Promise<Snapshot | PortableSnapshot> {
		if (this.accountability?.admin !== true) throw new ForbiddenException();

		const currentSnapshot = await getSnapshot({ database: this.knex });

		if ((options?.version ?? DEFAULT_SNAPSHOT_VERSION) === 2) {
			return getPortableSnapshot(currentSnapshot, { database: this.knex });
		}

		return currentSnapshot;
	}

	async apply(payload: SnapshotDiffWithHash): Promise<void> {
		if (this.accountability?.admin !== true) throw new ForbiddenException();

		const currentSnapshot = await this.snapshot({ version: 1 });
		const keyForm = await toKeyFormSnapshot(currentSnapshot, { database: this.knex });
		const snapshotWithHash: SnapshotWithHash = { ...currentSnapshot, hash: getVersionedHash(keyForm.snapshot) };

		if (!validateApplyDiff(payload, snapshotWithHash)) return;

		await applyDiff(currentSnapshot, payload.diff, { database: this.knex });
	}

	async diff(
		snapshot: Snapshot | PortableSnapshot,
		options?: { currentSnapshot?: Snapshot; currentKeyForm?: KeyFormState; force?: boolean }
	): Promise<SnapshotDiff | null> {
		if (this.accountability?.admin !== true) throw new ForbiddenException();

		validateSnapshot(snapshot, options?.force);

		const currentSnapshot = options?.currentSnapshot ?? (await getSnapshot({ database: this.knex }));

		const diff = await getTargetSnapshotDiff(snapshot, {
			current: currentSnapshot,
			...(options?.currentKeyForm ? { currentKeyForm: options.currentKeyForm } : {}),
			database: this.knex,
		});

		if (diff.collections.length === 0 && diff.fields.length === 0 && diff.relations.length === 0) {
			return null;
		}

		return diff;
	}

	getHashedSnapshot(snapshot: Snapshot): SnapshotWithHash {
		const snapshotHash = getVersionedHash(snapshot);

		return {
			...snapshot,
			hash: snapshotHash,
		};
	}
}
