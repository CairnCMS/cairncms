module.exports = function registerHooks({ filter }) {
	const secret = 'cairn-transport-probe-secret-7f3a';

	filter('request.error', (errors) => {
		if (!Array.isArray(errors)) return errors;

		return errors.map((error) => {
			if (!error || typeof error !== 'object') return error;

			const extensions = { ...error.extensions, probe_marker: 'request-error-hook', access_token: secret };

			return { ...error, message: `${error.message} access_token=${secret}`, extensions };
		});
	});
};
