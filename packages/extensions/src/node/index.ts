export {
	scanCandidateSource,
	MAX_SOURCE_FILE_BYTES,
	MAX_SOURCE_GRAPH_BYTES,
	MAX_SOURCE_FILE_COUNT,
	MAX_SOURCE_IMPORT_ATTEMPTS,
	type ScanSourceDeps,
} from './scan-source.js';
export { classifyEntryPath, realEntryInsideRoot, type EntryPathClass } from './entry-integrity.js';
export { readFileCapped, type CappedReadResult } from './capped-read.js';
export type { LocalExtensionCandidate } from './types.js';
export * from '../validation.js';
