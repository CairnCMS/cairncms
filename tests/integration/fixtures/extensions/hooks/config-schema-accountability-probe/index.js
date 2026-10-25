module.exports = function registerHooks({ action }) {
	const record = (event) => (meta, context) => {
		const hasAccountability = Boolean(context) && 'accountability' in context;

		console.log(
			JSON.stringify({
				wiredSchemaProbe: true,
				event,
				meta: meta ?? null,
				hasAccountability,
				accountability: hasAccountability ? context.accountability : undefined,
			})
		);
	};

	action('collections.create', record('collections.create'));
	action('fields.create', record('fields.create'));
};
