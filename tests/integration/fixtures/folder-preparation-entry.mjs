// Owned test tool: runs the creation-only folder preparation inside the API runtime against the owned database, so the
// integration suite can exercise it on every vendor. The step has no HTTP surface of its own.
const [, , documentPath, outputPath] = process.argv;
if (!documentPath || !outputPath) throw new Error('A desired-config document path and an output path are required.');

const { readFileSync, writeFileSync } = await import('node:fs');

const { validateConfigManifest, validateDesiredConfig } = await import(
	'../../../api/dist/utils/validate-desired-config.js'
);

const { normalizeToInternal } = await import('../../../api/dist/utils/config/wire.js');
const { applyFolderPreparation } = await import('../../../api/dist/utils/apply-folder-preparation.js');
const { getSystemAccountability } = await import('../../../api/dist/utils/get-system-accountability.js');
const { CONFIG_APPLY_ORIGIN } = await import('../../../api/dist/utils/config-contract.js');
const { default: getDatabase } = await import('../../../api/dist/database/index.js');

const document = JSON.parse(readFileSync(documentPath, 'utf8'));
const manifest = validateConfigManifest(document.manifest, documentPath);

const failures = validateDesiredConfig(document, {
	label: documentPath,
	references: 'current-state',
	currentRoleKeys: new Set(),
	currentFolderKeys: new Set(),
});

if (failures.length > 0)
	throw new Error(`Desired config is invalid: ${failures.map((failure) => failure.message).join('; ')}`);

const desired = normalizeToInternal(manifest, document);

const created = await applyFolderPreparation(desired, [], {
	context: {
		mode: 'system',
		reason: 'local config apply',
		accountability: { ...getSystemAccountability(), origin: CONFIG_APPLY_ORIGIN },
	},
});

writeFileSync(outputPath, JSON.stringify([...created]));
await getDatabase().destroy();
