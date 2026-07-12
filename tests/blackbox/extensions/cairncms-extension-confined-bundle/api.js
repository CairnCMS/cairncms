var CairnBundle = (() => {
	const operationHandler = async ({ options }) => ({
		marker: 'confined-bundle-op',
		received: options.probe ?? null,
		apiKeyKind: options.api_key ? (options.api_key.kind ?? typeof options.api_key) : null,
	});

	// Both endpoint entries run this exact code. Only the gate-validated per-entry
	// capability differs, so a denied items read on one and a successful read on the
	// other proves the broker selects capabilities per entry, not per artifact.
	const readItems = async (request, context) => {
		const reply = await context.host.items.read(request.body.collection, request.body.query ?? {});
		return { body: reply };
	};

	const stampHandler = async (payload, _meta, context) => ({
		...payload,
		stamped: 'by-confined-bundle-hook',
		stamped_by: context.accountability ? context.accountability.user : null,
	});

	return {
		default: {
			'operation:confined-bundle-op': { id: 'confined-bundle-op', handler: operationHandler },
			'endpoint:confined-bundle-reader': { id: 'confined-bundle-reader', handler: readItems },
			'endpoint:confined-bundle-bare': { id: 'confined-bundle-bare', handler: readItems },
			'hook:confined-bundle-hook': {
				id: 'confined-bundle-hook',
				filters: { 'confined_bundle_records.items.create': stampHandler },
				actions: {},
			},
		},
	};
})();
