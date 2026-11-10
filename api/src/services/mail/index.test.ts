import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient } from 'knex-mock-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type VerifyCallback = (error: Error | null) => void;

const hoisted = vi.hoisted(() => ({
	env: {} as Record<string, unknown>,
	warn: vi.fn(),
	transporter: { verify: vi.fn(), sendMail: vi.fn() },
	db: null as unknown as Knex,
}));

vi.mock('../../env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../env.js')>();

	const proxy = new Proxy(actual.default, {
		get(target, prop) {
			return prop in hoisted.env ? hoisted.env[prop as string] : Reflect.get(target, prop);
		},
	});

	return { ...actual, default: proxy, getEnv: () => proxy };
});

vi.mock('../../logger.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../logger.js')>();

	const proxy = new Proxy(actual.default, {
		get(target, prop) {
			return prop === 'warn' ? hoisted.warn : Reflect.get(target, prop);
		},
	});

	return { ...actual, default: proxy };
});

vi.mock('../../database/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../database/index.js')>();
	return { ...actual, default: () => hoisted.db };
});

vi.mock('nodemailer', () => ({ default: { createTransport: () => hoisted.transporter } }));

const schema: SchemaOverview = { collections: {}, relations: [] };

async function loadServices() {
	const { MailService } = await import('./index.js');
	const { ActivityService } = await import('../activity.js');
	return { MailService, ActivityService };
}

beforeEach(() => {
	vi.resetModules();

	for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
	Object.assign(hoisted.env, { EMAIL_TRANSPORT: 'smtp', EMAIL_VERIFY_SETUP: true, EMAIL_FROM: 'sender@example.com' });

	hoisted.warn.mockReset();
	hoisted.transporter.verify.mockReset();
	hoisted.transporter.sendMail.mockReset().mockResolvedValue({ messageId: 'test-message' });

	hoisted.db = vi.mocked(knex.default({ client: MockClient }));
	createTracker(hoisted.db).on.select('directus_settings').response([]);
});

describe('MailService setup verification', () => {
	it('checks the transport once while an earlier check is pending or has failed', async () => {
		const { MailService } = await loadServices();
		const callbacks: VerifyCallback[] = [];

		hoisted.transporter.verify.mockImplementation((callback: VerifyCallback) => {
			callbacks.push(callback);
		});

		new MailService({ schema, knex: hoisted.db });
		new MailService({ schema, knex: hoisted.db });
		const sender = new MailService({ schema, knex: hoisted.db });

		await sender.send({ to: 'recipient@example.com', subject: 'Sent during the check', html: '<p>Body</p>' });

		expect(callbacks).toHaveLength(1);
		callbacks[0]!(new Error('connect ECONNREFUSED'));
		new MailService({ schema, knex: hoisted.db });

		expect(hoisted.transporter.verify).toHaveBeenCalledTimes(1);
		expect(hoisted.warn).toHaveBeenCalledTimes(2);
		expect(hoisted.warn).toHaveBeenNthCalledWith(1, 'Email connection failed:');
		expect(hoisted.warn).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'connect ECONNREFUSED' }));
		expect(hoisted.transporter.sendMail).toHaveBeenCalledTimes(1);

		expect(hoisted.transporter.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({ to: 'recipient@example.com', subject: 'Sent during the check' })
		);
	});

	it('checks the transport once across repeated activity service construction', async () => {
		const { ActivityService } = await loadServices();

		new ActivityService({ schema, knex: hoisted.db });
		new ActivityService({ schema, knex: hoisted.db });
		new ActivityService({ schema, knex: hoisted.db });

		expect(hoisted.transporter.verify).toHaveBeenCalledTimes(1);
	});

	it('does not check the transport when EMAIL_VERIFY_SETUP is false', async () => {
		hoisted.env['EMAIL_VERIFY_SETUP'] = false;
		const { MailService } = await loadServices();

		new MailService({ schema, knex: hoisted.db });
		new MailService({ schema, knex: hoisted.db });

		expect(hoisted.transporter.verify).not.toHaveBeenCalled();
	});

	it('fails every construction when no transport is configured', async () => {
		hoisted.env['EMAIL_TRANSPORT'] = 'unrecognized-transport';
		const { MailService } = await loadServices();

		expect(() => new MailService({ schema, knex: hoisted.db })).toThrow(TypeError);
		expect(() => new MailService({ schema, knex: hoisted.db })).toThrow(TypeError);

		expect(hoisted.warn).toHaveBeenCalledTimes(2);
		expect(hoisted.warn).toHaveBeenCalledWith('Illegal transport given for email. Check the EMAIL_TRANSPORT env var.');
	});
});
