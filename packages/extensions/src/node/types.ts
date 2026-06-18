/**
 * The minimal input the source scanner reads: the package root for containment
 * and relative-path reporting, and the resolved entry source paths it scans from.
 */
export type LocalExtensionCandidate = {
	root: string;
	entries: string[];
};
