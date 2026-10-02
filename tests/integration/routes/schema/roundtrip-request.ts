import type supertest from 'supertest';
import { createRequest } from '../../fixtures/request-agent.mjs';

// Match the schema tests' 20-minute deadline so HTTP timeouts do not preempt their assertions.
const request = ((host: string) =>
	createRequest(host).timeout({ response: 1200000, deadline: 1200000 })) as unknown as typeof supertest;

export const setupRequest = ((host: string) =>
	createRequest(host, { setup: true }).timeout({
		response: 1200000,
		deadline: 1200000,
	})) as unknown as typeof supertest;

export default request;
