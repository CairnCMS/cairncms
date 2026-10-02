import { BaseException } from '@cairncms/exceptions';

export class AdminMutationUnverifiedTransactionException extends BaseException {
	constructor() {
		super(
			'An administrator-affecting role change was refused because it ran inside a transaction whose isolation could not be verified.',
			500,
			'ADMIN_MUTATION_UNVERIFIED_TRANSACTION'
		);
	}
}
