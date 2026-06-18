import marker from '#marker';

export default (router) => {
	router.get('/marker', (_req, res) => res.json({ marker }));
};
