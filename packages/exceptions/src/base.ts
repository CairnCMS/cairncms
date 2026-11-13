// Keeps a direct construction from inferring its details type from the argument, so it keeps the default.
// TODO: Replace with the built-in NoInfer once the repo's TypeScript is 5.4 or later.
type NonInferred<T> = [T][T extends any ? 0 : never];

type DetailsArgument<Extensions> = Record<never, never> extends Extensions
	? [extensions?: Extensions | undefined]
	: [extensions: Extensions];

export class BaseException<Extensions extends object = Record<string, any>> extends Error {
	// Subclasses type these through the generic parameter and must not redeclare them. Under ES2022
	// class fields, a redeclared field resets its value after super() returns.
	status: number;
	code: string;
	extensions: Extensions;

	constructor(message: string, status: number, code: string, ...[extensions]: DetailsArgument<NonInferred<Extensions>>);
	constructor(message: string, status: number, code: string, extensions?: Extensions) {
		super(message);
		this.status = status;
		this.code = code;

		this.extensions = extensions || ({} as Extensions);
	}
}
