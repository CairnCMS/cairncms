export default {
	endpoints: [
		{
			name: 'cairn-fixture-bundle-endpoint',
			config: (router) => {
				router.get('/', (_req, res) => res.send('cairn-fixture-bundle-endpoint-ok'));
			},
		},
	],
	hooks: [],
	operations: [],
};
