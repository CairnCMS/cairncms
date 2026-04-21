import { defineEndpoint } from '@cairncms/extensions-sdk';

export default defineEndpoint((router) => {
	router.get('/', (_req, res) => res.send('Hello, World!'));
});
