var CairnEndpoint = (() => {
	const handler = async (request, context) => {
		if (request.path === '/items') {
			const reply = await context.host.items.read(request.body.collection, request.body.query ?? {});
			return { body: reply };
		}

		if (request.path === '/contract-violation') {
			return { body: null, headers: { 'x-smuggled': '1' } };
		}

		if (request.path === '/big') {
			return { body: 'x'.repeat(Number(request.query.bytes ?? '0')) };
		}

		return {
			status: 200,
			body: {
				echoed: { method: request.method, path: request.path, query: request.query, body: request.body },
				accountability: context.accountability,
			},
		};
	};

	return { default: { id: 'cairncms-extension-confined-echo-endpoint', handler } };
})();
