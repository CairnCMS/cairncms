import supertest from 'supertest';
import { requestFailure, setupProblem } from './request-diagnostics.mjs';

const responseContexts = new WeakMap();

export function assertSetupResponse(response) {
	const details = responseContexts.get(response);
	if (!details) throw new Error('Setup response has no recorded request context');
	const problem = setupProblem(details.method, details.path, details.context.send, response, details.context.query);
	if (problem) throw requestFailure({ ...details, problem });
	return response;
}

export function createRequest(host, { setup = false } = {}) {
	const agent = supertest.agent(host).timeout({ response: 10_000, deadline: 30_000 });

	for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
		const original = agent[method].bind(agent);

		agent[method] = (path) => {
			const test = original(path);
			const context = { query: Object.fromEntries(new URL(path, host).searchParams) };
			let expectedStatus;
			const expect = test.expect.bind(test);

			test.expect = (...args) => {
				if (typeof args[0] === 'number') expectedStatus = args[0];
				return expect(...args);
			};

			for (const name of ['send', 'query']) {
				const call = test[name].bind(test);

				test[name] = (...args) => {
					context[name] =
						typeof args[0] === 'string' && name === 'query'
							? Object.fromEntries(new URLSearchParams(args[0]))
							: args[0];

					return call(...args);
				};
			}

			const end = test.end.bind(test);

			test.end = (callback) =>
				end((error, response) => {
					if (response) responseContexts.set(response, { method, path, context, response });
					const assertedRejection = expectedStatus >= 300 && response?.status === expectedStatus;

					const problem =
						setup && response && !assertedRejection
							? setupProblem(method, path, context.send, response, context.query)
							: undefined;

					if (error || problem) callback(requestFailure({ method, path, context, response, error, problem }), response);
					else callback(null, response);
				});

			return test;
		};
	}

	return agent;
}
