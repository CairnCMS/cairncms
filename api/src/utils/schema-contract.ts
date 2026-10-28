export const SUPPORTED_SNAPSHOT_VERSIONS = [1, 2] as const;

export type SnapshotVersion = (typeof SUPPORTED_SNAPSHOT_VERSIONS)[number];

export const LATEST_SNAPSHOT_VERSION: SnapshotVersion = 2;

/**
 * The format written when the caller chooses no version: a new snapshot file, stdout, or `GET /schema/snapshot`
 * without a `version`. A later release changes the default to version 2. Request a version explicitly to pin it.
 */
export const DEFAULT_SNAPSHOT_VERSION: SnapshotVersion = 1;
