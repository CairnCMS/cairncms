import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmPrompt, createVerb, deleteVerb, heading, planIntro, updateVerb } from './presentation.js';

describe('presentation primitives', () => {
	let originalLevel: typeof chalk.level;

	beforeEach(() => {
		originalLevel = chalk.level;
		chalk.level = 1;
	});

	afterEach(() => {
		chalk.level = originalLevel;
	});

	it('emit the exact styled tokens the apply surfaces previously inlined', () => {
		expect(planIntro).toBe('The following changes will be applied:');
		expect(confirmPrompt).toBe('Would you like to continue?');
		expect(heading('Collections')).toBe(chalk.black.underline.bold('Collections:'));
		expect(heading('Fields')).toBe(chalk.black.underline.bold('Fields:'));
		expect(heading('Relations')).toBe(chalk.black.underline.bold('Relations:'));
		expect(createVerb()).toBe(chalk.green('Create'));
		expect(updateVerb()).toBe(chalk.blue('Update'));
		expect(deleteVerb()).toBe(chalk.red('Delete'));
	});
});
