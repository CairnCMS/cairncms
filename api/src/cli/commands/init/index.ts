import chalk from 'chalk';
import { execa } from 'execa';
import inquirer from 'inquirer';
import Joi from 'joi';
import type { Knex } from 'knex';
import path from 'node:path';
import ora from 'ora';
import { v4 as uuid } from 'uuid';
import runMigrations from '../../../database/migrations/run.js';
import runSeed from '../../../database/seeds/run.js';
import { generateHash } from '../../../utils/generate-hash.js';
import * as pkg from '../../../utils/package.js';
import type { Credentials } from '../../utils/create-db-connection.js';
import createDBConnection from '../../utils/create-db-connection.js';
import createEnv from '../../utils/create-env/index.js';
import createProjectFiles from '../../utils/create-project-files/index.js';
import { defaultAdminRole, defaultAdminUser } from '../../utils/defaults.js';
import { drivers } from '../../utils/drivers.js';
import resolveProjectPath from '../../utils/resolve-project-path.js';
import { databaseQuestions } from './questions.js';

type SupportedDriver = 'sqlite3' | 'pg' | 'mysql';

const SUPPORTED_INIT_DRIVERS: Record<SupportedDriver, string> = {
	sqlite3: drivers.sqlite3,
	pg: drivers.pg,
	mysql: drivers.mysql,
};

const DB_ALIAS_MAP: Record<string, SupportedDriver> = {
	sqlite: 'sqlite3',
	postgres: 'pg',
	postgresql: 'pg',
	mysql: 'mysql',
	mariadb: 'mysql',
};

interface InitOptions {
	db?: string;
}

export default async function init(projectName: string | undefined, options: InitOptions = {}): Promise<void> {
	const target = await resolveProjectPath(projectName);

	process.chdir(target.absolutePath);

	await createProjectFiles(target.absolutePath, target.name);

	const cairncmsVersion = resolveCairncmsVersion();

	const spinnerCairncms = ora('Installing CairnCMS...').start();
	await execa('npm', ['install', '--save-exact', `cairncms@${cairncmsVersion}`]);
	spinnerCairncms.stop();

	const dbClient = options.db ? resolveDriverAlias(options.db) : await promptDriver();

	const driverPackage = driverPackageFor(dbClient);

	const spinnerDriver = ora('Installing database driver...').start();
	await execa('npm', ['install', driverPackage]);
	spinnerDriver.stop();

	const { credentials, db } = await trySeed(dbClient, target.absolutePath);

	await createEnv(dbClient, credentials, target.absolutePath);

	process.stdout.write('\nCreate your first admin user:\n\n');
	const firstUser = await promptAdmin();
	await insertAdminUser(db, firstUser);
	await db.destroy();

	process.stdout.write(`\nYour project has been created at ${chalk.green(target.absolutePath)}.\n`);
	process.stdout.write(`\nThe configuration can be found in ${chalk.green(path.join(target.absolutePath, '.env'))}\n`);
	process.stdout.write(`\nStart the server by running:\n`);

	if (!target.isCurrentDir) {
		process.stdout.write(`  ${chalk.blue('cd')} ${target.name}\n`);
	}

	process.stdout.write(`  ${chalk.blue('npm run start')}\n`);

	process.exit(0);
}

function driverPackageFor(dbClient: SupportedDriver): string {
	if (dbClient === 'mysql') return 'mysql2';
	return dbClient;
}

function resolveCairncmsVersion(): string {
	const envVersion = process.env['CAIRNCMS_PACKAGE_VERSION'];

	if (envVersion) {
		return envVersion;
	}

	process.stdout.write(
		`${chalk.yellow('Warning:')} CAIRNCMS_PACKAGE_VERSION is not set. Falling back to @cairncms/api version (${
			pkg.version
		}). This usually means init was invoked directly via @cairncms/api rather than the cairncms binary.\n`
	);

	return pkg.version;
}

function resolveDriverAlias(alias: string): SupportedDriver {
	const lowered = alias.toLowerCase();
	const resolved = DB_ALIAS_MAP[lowered];

	if (!resolved) {
		const validAliases = Object.keys(DB_ALIAS_MAP).join(', ');

		process.stdout.write(
			`\n${chalk.red('Error:')} Unknown database alias "${alias}". Valid aliases: ${validAliases}.\n`
		);

		process.stdout.write('mssql, oracle, and cockroachdb are not supported targets for new CairnCMS installs.\n');

		process.exit(1);
	}

	return resolved;
}

async function promptDriver(): Promise<SupportedDriver> {
	const { client } = await inquirer.prompt([
		{
			type: 'list',
			name: 'client',
			message: 'Choose your database client',
			choices: Object.values(SUPPORTED_INIT_DRIVERS),
		},
	]);

	for (const [key, value] of Object.entries(SUPPORTED_INIT_DRIVERS)) {
		if (value === client) return key as SupportedDriver;
	}

	throw new Error('Failed to resolve database driver from selection');
}

async function trySeed(dbClient: SupportedDriver, rootPath: string): Promise<{ credentials: Credentials; db: Knex }> {
	let attemptsRemaining = 5;

	while (attemptsRemaining > 0) {
		const credentials: Credentials = await inquirer.prompt(
			(databaseQuestions[dbClient] as any[]).map((question: ({ client, filepath }: any) => any) =>
				question({ client: dbClient, filepath: rootPath })
			)
		);

		const db = createDBConnection(dbClient, credentials);

		try {
			await runSeed(db);
			await runMigrations(db, 'latest', false);
			return { credentials, db };
		} catch (err: any) {
			process.stdout.write('\nSomething went wrong while seeding the database:\n');
			process.stdout.write(`\n${chalk.red(`[${err.code || 'Error'}]`)} ${err.message}\n`);
			process.stdout.write('\nPlease try again\n\n');

			try {
				await db.destroy();
			} catch {
				// best-effort cleanup; the connection may already be torn down
			}

			attemptsRemaining--;
		}
	}

	process.stdout.write("Couldn't seed the database. Exiting.\n");
	process.exit(1);
}

async function promptAdmin(): Promise<{ email: string; password: string }> {
	const result = await inquirer.prompt([
		{
			type: 'input',
			name: 'email',
			message: 'Email',
			default: 'admin@example.com',
			validate: (input: string) => {
				const emailSchema = Joi.string().email().required();
				const { error } = emailSchema.validate(input);
				if (error) throw new Error('The email entered is not a valid email address!');
				return true;
			},
		},
		{
			type: 'password',
			name: 'password',
			message: 'Password',
			mask: '*',
			validate: (input: string | null) => {
				if (input === null || input === '') throw new Error('The password cannot be empty!');
				return true;
			},
		},
	]);

	result.password = await generateHash(result.password);
	return result;
}

async function insertAdminUser(db: Knex, firstUser: { email: string; password: string }): Promise<void> {
	const userID = uuid();
	const roleID = uuid();

	await db('directus_roles').insert({ id: roleID, ...defaultAdminRole });

	await db('directus_users').insert({
		id: userID,
		email: firstUser.email,
		password: firstUser.password,
		role: roleID,
		...defaultAdminUser,
	});
}
