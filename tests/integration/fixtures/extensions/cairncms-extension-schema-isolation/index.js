const COLLECTION = 'schema_cache_tenant_records';

export default (router, { services, database, exceptions }) => {
	router.post('/reveal', async (req, res, next) => {
		try {
			if (!req.accountability?.user) throw new exceptions.ForbiddenException();

			const special = req.schema.collections[COLLECTION].fields.secret.special;
			const concealed = special.indexOf('conceal');
			if (concealed === -1) throw new Error('Expected a concealed secret field');
			special.splice(concealed, 1);

			const items = new services.ItemsService(COLLECTION, {
				knex: database,
				schema: req.schema,
				accountability: req.accountability,
			});

			res.json({ data: await items.readByQuery({ fields: ['id', 'tenant', 'secret'] }) });
		} catch (error) {
			next(error);
		}
	});
};
