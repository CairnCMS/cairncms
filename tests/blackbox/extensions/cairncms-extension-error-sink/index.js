export default (router) => {
	router.post('/throw', (req, _res, next) => {
		const propagated = req.body?.password;

		const error = new Error(`error-sink endpoint failure echoing ${propagated}`);

		error.extensions = {
			token: 'keyed-extension-secret-7b3d1e5f',
			detail: `propagated request value was ${propagated}`,
		};

		next(error);
	});
};
