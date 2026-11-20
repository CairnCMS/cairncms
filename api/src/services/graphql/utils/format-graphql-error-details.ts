import type { GraphQLError, GraphQLFormattedError } from 'graphql';

/** Returns each error in the specification's formatted shape, which carries no stack trace. */
export function formatGraphQLErrorDetails(errors: readonly GraphQLError[]): GraphQLFormattedError[] {
	return errors.map((error) => error.toJSON());
}
