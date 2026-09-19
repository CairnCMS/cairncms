import chalk from 'chalk';

export const planIntro = 'The following changes will be applied:';

export const confirmPrompt = 'Would you like to continue?';

export function heading(label: string): string {
	return chalk.black.underline.bold(`${label}:`);
}

export function createVerb(): string {
	return chalk.green('Create');
}

export function updateVerb(): string {
	return chalk.blue('Update');
}

export function deleteVerb(): string {
	return chalk.red('Delete');
}
