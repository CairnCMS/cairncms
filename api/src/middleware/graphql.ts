import { InvalidPayloadException, InvalidQueryException, MethodNotAllowedException } from '@cairncms/exceptions';
import { parseJSON } from '@cairncms/utils';
import type { RequestHandler } from 'express';
import type { DocumentNode } from 'graphql';
import { GraphQLError, getOperationAST } from 'graphql';
import { parseGraphQLQuery } from '../services/graphql/query-gate.js';
import { formatGraphQLErrorDetails } from '../services/graphql/utils/format-graphql-error-details.js';
import type { GraphQLParams } from '../types/index.js';
import asyncHandler from '../utils/async-handler.js';

export const parseGraphQL: RequestHandler = asyncHandler(async (req, res, next) => {
	if (req.method !== 'GET' && req.method !== 'POST') {
		throw new MethodNotAllowedException('GraphQL only supports GET and POST requests.', { allow: ['GET', 'POST'] });
	}

	let query: string | null;
	let variables: Record<string, unknown> | null;
	let operationName: string | null;
	let document: DocumentNode;

	if (req.method === 'GET') {
		query = (req.query['query'] as string | undefined) || null;

		if (req.query['variables']) {
			try {
				variables = parseJSON(req.query['variables'] as string);
			} catch {
				throw new InvalidQueryException(`Variables are invalid JSON.`);
			}
		} else {
			variables = {};
		}

		operationName = (req.query['operationName'] as string | undefined) || null;
	} else {
		query = req.body.query || null;
		variables = req.body.variables || null;
		operationName = req.body.operationName || null;
	}

	if (typeof query !== 'string') {
		throw new InvalidPayloadException('Must provide query string.');
	}

	try {
		document = parseGraphQLQuery(query);
	} catch (err: unknown) {
		if (!(err instanceof GraphQLError)) throw new InvalidPayloadException(`GraphQL schema validation error.`);

		throw new InvalidPayloadException(`GraphQL schema validation error.`, {
			graphqlErrors: formatGraphQLErrorDetails([err]),
		});
	}

	const operationAST = getOperationAST(document, operationName);

	// You can only do `query` through GET
	if (req.method === 'GET' && operationAST?.operation !== 'query') {
		throw new MethodNotAllowedException(`Can only perform a ${operationAST?.operation} from a POST request.`, {
			allow: ['POST'],
		});
	}

	// Prevent caching responses when mutations are made
	if (operationAST?.operation === 'mutation') {
		res.locals['cache'] = false;
	}

	res.locals['graphqlParams'] = {
		document,
		query,
		variables,
		operationName,
		contextValue: { req, res },
	} as GraphQLParams;

	return next();
});
