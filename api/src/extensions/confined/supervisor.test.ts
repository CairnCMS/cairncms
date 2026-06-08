import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSandboxLimits, type SandboxLimits } from './sandbox-limits.js';
import { ConfinedSupervisor } from './supervisor.js';
import { createFrameReader, writeFrame } from './transport.js';
import type {
	ConfinedHostCallMessage,
	ConfinedHostDispatcher,
	ConfinedHostReply,
	ConfinedInvocation,
	ConfinedResult,
	ConfinedRuntimeLimits,
} from './types.js';

const ENGINE_TIMEOUT = 15_000;

function realRequest(args: unknown): Promise<{ status: number | undefined; body: string }> {
	const request = args as { url: string; method?: string };

	return new Promise((resolve, reject) => {
		const client = http.request(request.url, { method: request.method ?? 'GET' }, (response) => {
			let body = '';
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () => resolve({ status: response.statusCode, body }));
		});

		client.on('error', reject);
		client.end();
	});
}

// A loopback dispatcher that crosses real parent code to make a real outbound request.
const loopbackDispatcher: ConfinedHostDispatcher = async (call) => {
	if (call.method === 'request.send') return { ok: true, value: await realRequest(call.args) };
	return { ok: true, value: null };
};

const LIMITS: ConfinedRuntimeLimits = {
	wallClockMs: 5000,
	cpuTimeoutMs: 2000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	acquireTimeoutMs: 0,
	hostCallTimeoutMs: 5000,
	maxHostCalls: 1000,
	maxInFlightHostCalls: 16,
};

function testLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
	const resolved = resolveSandboxLimits({});
	if (!resolved.ok) throw new Error('default sandbox limits should resolve');
	return { ...resolved.limits, ...overrides };
}

function entry(handlerBody: string): string {
	return `var CairnOperation = (() => { const handler = ${handlerBody}; return { default: { id: 'flow-operation.test', handler } }; })();`;
}

function invocation(entrySource: string, overrides: Partial<ConfinedInvocation> = {}): ConfinedInvocation {
	return {
		extensionId: 'local.test',
		contributionId: 'flow-operation.test',
		operationId: 'op-1',
		entrySource,
		options: {},
		input: null,
		accountability: null,
		limits: LIMITS,
		...overrides,
	};
}

function positive(): ConfinedInvocation {
	return invocation(entry('async ({ options }) => ({ ok: true, amount: options.amount })'), { options: { amount: 7 } });
}

/**
 * Generates a plain-node stub child that speaks the framed transport on fd 3. The
 * stub stands in for the real engine so a test can drive a chosen parent-visible
 * outcome without paying the QuickJS load. `jobAction` runs once a job frame arrives.
 */
function framedStubChild(jobAction: string): string {
	return `
import net from 'node:net';
const channel = new net.Socket({ fd: 3, readable: true, writable: true });
let buf = Buffer.alloc(0);
channel.on('data', (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (buf.length >= 4) {
		const len = buf.readUInt32BE(0);
		if (buf.length < 4 + len) break;
		const body = buf.subarray(4, 4 + len);
		buf = buf.subarray(4 + len);
		let message = null;
		try { message = JSON.parse(body.toString('utf8')); } catch { message = null; }
		if (message && message.type === 'job') { ${jobAction} }
	}
});
function sendDone(result) {
	const out = Buffer.from(JSON.stringify({ type: 'done', result }), 'utf8');
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(out.length, 0);
	channel.write(Buffer.concat([header, out]), () => process.exit(0));
}
`;
}

const VALID_CHILD_LIMITS = JSON.stringify({
	parentToChildFrameMax: 64 * 1024 * 1024,
	maxResultBytes: 16 * 1024 * 1024,
});

interface DriveChildOptions {
	onHostCall?: (channel: Duplex, message: ConfinedHostCallMessage) => void;
	// The limits payload the parent always supplies. null omits it, a bad string corrupts it.
	limitsEnv?: string | null;
}

/**
 * Spawns the real child host and drives it over the framed transport, so the test can
 * inject a malformed job, a malformed host reply, or a bad limits payload that the
 * supervisor never would.
 */
function driveChildHost(job: unknown, options: DriveChildOptions = {}): Promise<ConfinedResult> {
	const childTs = fileURLToPath(new URL('./child-host.ts', import.meta.url));
	const limitsEnv = options.limitsEnv === undefined ? VALID_CHILD_LIMITS : options.limitsEnv;

	const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };
	if (limitsEnv !== null) env['CONFINED_SANDBOX_LIMITS'] = limitsEnv;

	return new Promise<ConfinedResult>((resolve) => {
		const child = spawn(process.execPath, ['--loader', 'tsx', childTs], {
			stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
			env,
		});

		const channel = child.stdio[3] as Duplex;
		channel.on('error', () => undefined);

		const read = createFrameReader({
			maxFrameBytes: 64 * 1024 * 1024,
			onFrame: (message) => {
				const record = message as { type?: string; id?: number; result?: ConfinedResult };

				if (record.type === 'host-call' && typeof record.id === 'number' && options.onHostCall) {
					options.onHostCall(channel, message as ConfinedHostCallMessage);
					return;
				}

				if (record.type === 'done' && record.result) {
					resolve(record.result);
					child.kill('SIGKILL');
				}
			},
			onProtocolViolation: () => {
				child.kill('SIGKILL');
				resolve({ ok: false, error: { code: 'crash', message: 'protocol violation' } });
			},
		});

		channel.on('data', read);

		// A child that exits without a done frame (a fail-closed startup) surfaces as a
		// channel close. Resolve it as a crash so a bad-limits test does not hang.
		channel.on('close', () => resolve({ ok: false, error: { code: 'crash', message: 'channel closed' } }));

		writeFrame(channel, job, () => undefined);
	});
}

// The real built artifact, exercised under plain node when a build is present.
const builtChildPath = fileURLToPath(new URL('../../../dist/extensions/confined/child-host.js', import.meta.url));
const builtChildExists = existsSync(builtChildPath);

describe('ConfinedSupervisor', () => {
	let tmpDir: string;
	let echoChild: string;
	let crashChild: string;
	let garbageChild: string;
	let secretMessageChild: string;
	let oversizeFrameChild: string;
	let server: http.Server;
	let loopbackUrl: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), 'confined-sup-'));

		echoChild = join(tmpDir, 'echo-child.mjs');
		writeFileSync(echoChild, framedStubChild("sendDone({ ok: true, value: 'from-stub' });"));

		crashChild = join(tmpDir, 'crash-child.mjs');
		writeFileSync(crashChild, framedStubChild('process.exit(1);'));

		garbageChild = join(tmpDir, 'garbage-child.mjs');
		writeFileSync(garbageChild, framedStubChild("sendDone({ ok: 'maybe', junk: true });"));

		secretMessageChild = join(tmpDir, 'secret-message-child.mjs');

		writeFileSync(
			secretMessageChild,
			framedStubChild("sendDone({ ok: false, error: { code: 'timeout', message: 'sk_live_LEAKED_FROM_CHILD' } });")
		);

		// Declares a frame far larger than any parent cap without sending its body, so the
		// parent must reject it on the header alone.
		oversizeFrameChild = join(tmpDir, 'oversize-frame-child.mjs');

		writeFileSync(
			oversizeFrameChild,
			framedStubChild('const h = Buffer.allocUnsafe(4); h.writeUInt32BE(256 * 1024 * 1024, 0); channel.write(h);')
		);

		server = http.createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ pong: true }));
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		loopbackUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/charges`;
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		server.close();
	});

	it(
		'runs an operation in a spawned child and returns its result (dev tsx path)',
		async () => {
			const result = await new ConfinedSupervisor().invoke(positive());
			expect(result).toEqual({ ok: true, value: { ok: true, amount: 7 } });
		},
		ENGINE_TIMEOUT
	);

	it('runs a plain-js stub child with no loader', async () => {
		const supervisor = new ConfinedSupervisor({ childPath: echoChild, childExecArgv: [] });
		const result = await supervisor.invoke(positive());
		expect(result).toEqual({ ok: true, value: 'from-stub' });
	});

	// Drives the actual built child-host.js under plain node, the real production path:
	// fd-3 framed transport over the spawned child's socketpair, no tsx loader. Runs only
	// when a build is present (the suite cannot build the artifact itself).
	it.skipIf(!builtChildExists)(
		'runs an operation in the real built child-host.js under plain node',
		async () => {
			const supervisor = new ConfinedSupervisor({ childPath: builtChildPath, childExecArgv: [] });
			const result = await supervisor.invoke(positive());
			expect(result).toEqual({ ok: true, value: { ok: true, amount: 7 } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'does not leak a host process.env secret into the child',
		async () => {
			process.env['CONFINED_SUP_SECRET'] = 'host-secret-must-not-leak';

			try {
				const result = await new ConfinedSupervisor().invoke(
					invocation(
						entry(
							'() => ({ secret: (typeof process !== "undefined" && process.env) ? (process.env.CONFINED_SUP_SECRET ?? null) : null })'
						)
					)
				);

				expect(result.ok).toBe(true);
				if (result.ok) expect((result.value as Record<string, unknown>)['secret']).toBeNull();
			} finally {
				delete process.env['CONFINED_SUP_SECRET'];
			}
		},
		ENGINE_TIMEOUT
	);

	it(
		'kills a runaway allocation loop by the wall-clock backstop',
		async () => {
			// Allocation loops evade the in-engine CPU timeout, and a generous memory limit
			// trips only after seconds. The parent wall-clock kill is the bound.
			const result = await new ConfinedSupervisor().invoke(
				invocation(entry('() => { const a = []; while (true) { a.push(new Array(100000).fill(7)); } }'), {
					limits: { ...LIMITS, cpuTimeoutMs: 10_000, memoryBytes: 256 * 1024 * 1024, wallClockMs: 800 },
				})
			);

			expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
		},
		ENGINE_TIMEOUT
	);

	it('isolates a child crash as a structured error without crashing the parent', async () => {
		const supervisor = new ConfinedSupervisor({ childPath: crashChild, childExecArgv: [] });
		const result = await supervisor.invoke(positive());

		expect(result).toMatchObject({ ok: false, error: { code: 'crash' } });

		// The parent is still alive and usable after the child crash.
		const echo = new ConfinedSupervisor({ childPath: echoChild, childExecArgv: [] });
		expect(await echo.invoke(positive())).toEqual({ ok: true, value: 'from-stub' });
	});

	it(
		'rejects an over-capacity invocation with a busy error',
		async () => {
			const supervisor = new ConfinedSupervisor({ limits: testLimits({ maxProcesses: 1 }) });

			const first = supervisor.invoke(positive());
			const second = await supervisor.invoke(positive());

			expect(second).toMatchObject({ ok: false, error: { code: 'busy' } });

			await first;
		},
		ENGINE_TIMEOUT
	);

	it('clamps a malformed child result to an internal error', async () => {
		const supervisor = new ConfinedSupervisor({ childPath: garbageChild, childExecArgv: [] });
		const result = await supervisor.invoke(positive());

		expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
	});

	it('replaces a child-supplied error message with a parent-owned canonical message', async () => {
		const supervisor = new ConfinedSupervisor({ childPath: secretMessageChild, childExecArgv: [] });
		const result = await supervisor.invoke(positive());

		expect(result).toEqual({ ok: false, error: { code: 'timeout', message: 'the operation exceeded its time limit' } });
		expect(JSON.stringify(result)).not.toContain('sk_live_LEAKED_FROM_CHILD');
	});

	it(
		'the child fails closed on a malformed job',
		async () => {
			const result = await driveChildHost({ type: 'job' });
			expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'the child fails closed when the parent omits its sandbox limits',
		async () => {
			const result = await driveChildHost({ type: 'job', invocation: positive() }, { limitsEnv: null });
			expect(result).toMatchObject({ ok: false, error: { code: 'crash' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'the child fails closed on a malformed sandbox limits payload',
		async () => {
			const result = await driveChildHost({ type: 'job', invocation: positive() }, { limitsEnv: 'not-json' });
			expect(result).toMatchObject({ ok: false, error: { code: 'crash' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'the child fails closed on a partial sandbox limits payload',
		async () => {
			const result = await driveChildHost(
				{ type: 'job', invocation: positive() },
				{ limitsEnv: JSON.stringify({ parentToChildFrameMax: 64 * 1024 * 1024 }) }
			);

			expect(result).toMatchObject({ ok: false, error: { code: 'crash' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'completes a brokered loopback request over the framed transport',
		async () => {
			const supervisor = new ConfinedSupervisor({ hostDispatcher: loopbackDispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async ({ options }, { host }) => { await host.log.info("calling"); const res = await host.request.send({ url: options.url, method: "GET" }); return { ok: res.ok, status: res.value.status, body: res.value.body }; }'
					),
					{ options: { url: loopbackUrl } }
				)
			);

			expect(result.ok).toBe(true);

			if (result.ok) {
				const value = result.value as Record<string, unknown>;
				expect(value['ok']).toBe(true);
				expect(value['status']).toBe(200);
				expect(String(value['body'])).toContain('pong');
			}
		},
		ENGINE_TIMEOUT
	);

	it(
		'lets the guest catch a host call denial',
		async () => {
			const dispatcher: ConfinedHostDispatcher = async () => ({
				ok: false,
				error: { code: 'denied', message: 'nope' },
			});

			const supervisor = new ConfinedSupervisor({ hostDispatcher: dispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async (_p, { host }) => { const res = await host.request.send({ url: "x" }); return { ok: res.ok, code: res.error.code }; }'
					)
				)
			);

			expect(result).toEqual({ ok: true, value: { ok: false, code: 'denied' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'serves a call through the per-invocation dispatcher over the construction-time one',
		async () => {
			const construction: ConfinedHostDispatcher = async () => ({ ok: true, value: 'construction' });
			const perInvoke: ConfinedHostDispatcher = async () => ({ ok: true, value: 'per-invoke' });
			const supervisor = new ConfinedSupervisor({ hostDispatcher: construction });

			const result = await supervisor.invoke(
				invocation(
					entry('async (_p, { host }) => { const res = await host.settings.get("k"); return { v: res.value }; }')
				),
				perInvoke
			);

			expect(result).toEqual({ ok: true, value: { v: 'per-invoke' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'bounds a hanging host call by the wall-clock kill',
		async () => {
			const dispatcher: ConfinedHostDispatcher = () => new Promise<ConfinedHostReply>(() => undefined);
			const supervisor = new ConfinedSupervisor({ hostDispatcher: dispatcher });

			const result = await supervisor.invoke(
				invocation(entry('async (_p, { host }) => { await host.request.send({ url: "x" }); return { ok: true }; }'), {
					limits: { ...LIMITS, wallClockMs: 800 },
				})
			);

			expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'denies host calls when no dispatcher is configured',
		async () => {
			const result = await new ConfinedSupervisor().invoke(
				invocation(
					entry(
						'async (_p, { host }) => { const res = await host.request.send({ url: "x" }); return { ok: res.ok, code: res.error.code }; }'
					)
				)
			);

			expect(result).toEqual({ ok: true, value: { ok: false, code: 'unsupported' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'denies an unknown host method at the parent',
		async () => {
			const supervisor = new ConfinedSupervisor({ hostDispatcher: loopbackDispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async () => { const res = await __hostCall("evil.method", {}); return { ok: res.ok, code: res.error.code }; }'
					)
				)
			);

			expect(result).toEqual({ ok: true, value: { ok: false, code: 'unsupported' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'denies an oversized host call payload at the parent',
		async () => {
			const supervisor = new ConfinedSupervisor({ hostDispatcher: loopbackDispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async (_p, { host }) => { const big = "x".repeat(300000); const res = await host.request.send({ url: "x", body: big }); return { ok: res.ok, code: res.error.code }; }'
					)
				)
			);

			expect(result).toEqual({ ok: true, value: { ok: false, code: 'invalid_request' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'bounds a hanging host call by the per-call timeout while the operation continues',
		async () => {
			const dispatcher: ConfinedHostDispatcher = () => new Promise<ConfinedHostReply>(() => undefined);
			const supervisor = new ConfinedSupervisor({ hostDispatcher: dispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async (_p, { host }) => { const res = await host.request.send({ url: "x" }); return { ok: res.ok, code: res.error.code }; }'
					),
					{ limits: { ...LIMITS, hostCallTimeoutMs: 300, wallClockMs: 5000 } }
				)
			);

			expect(result).toEqual({ ok: true, value: { ok: false, code: 'timeout' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'rate-limits host calls past the per-invocation cap',
		async () => {
			const dispatcher: ConfinedHostDispatcher = async () => ({ ok: true, value: { status: 200 } });
			const supervisor = new ConfinedSupervisor({ hostDispatcher: dispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async (_p, { host }) => { let ok = 0; let limited = 0; for (let i = 0; i < 6; i++) { const r = await host.request.send({ url: "x" }); if (r.ok) ok++; else if (r.error.code === "rate_limited") limited++; } return { ok, limited }; }'
					),
					{ limits: { ...LIMITS, maxHostCalls: 3 } }
				)
			);

			expect(result).toEqual({ ok: true, value: { ok: 3, limited: 3 } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'turns a malformed host reply into a guest-visible denial',
		async () => {
			const result = await driveChildHost(
				{
					type: 'job',
					invocation: invocation(
						entry(
							'async (_p, { host }) => { const r = await host.request.send({ url: "x" }); return { ok: r.ok, code: r.error.code }; }'
						)
					),
				},
				{
					onHostCall: (channel, message) => {
						writeFrame(channel, { type: 'host-reply', id: message.id, reply: { ok: true } }, () => undefined);
					},
				}
			);

			expect(result).toEqual({ ok: true, value: { ok: false, code: 'internal' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'counts a timed-out dispatcher as in-flight until it settles, capping abandoned work',
		async () => {
			const dispatcher: ConfinedHostDispatcher = () => new Promise<ConfinedHostReply>(() => undefined);
			const supervisor = new ConfinedSupervisor({ hostDispatcher: dispatcher });

			const result = await supervisor.invoke(
				invocation(
					entry(
						'async (_p, { host }) => { let timedOut = 0; let limited = 0; for (let i = 0; i < 4; i++) { const r = await host.request.send({ url: "x" }); if (r.error.code === "timeout") timedOut++; else if (r.error.code === "rate_limited") limited++; } return { timedOut, limited }; }'
					),
					{ limits: { ...LIMITS, hostCallTimeoutMs: 200, maxInFlightHostCalls: 2, wallClockMs: 5000 } }
				)
			);

			expect(result).toEqual({ ok: true, value: { timedOut: 2, limited: 2 } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'aborts an in-flight host call when the invocation finishes',
		async () => {
			let capturedSignal: AbortSignal | undefined;

			const dispatcher: ConfinedHostDispatcher = (_call, _context, signal) => {
				capturedSignal = signal;
				return new Promise<ConfinedHostReply>(() => undefined);
			};

			const supervisor = new ConfinedSupervisor({ hostDispatcher: dispatcher });

			// The guest starts a host call but never awaits it, then returns.
			const result = await supervisor.invoke(
				invocation(entry('async (_p, { host }) => { host.request.send({ url: "x" }); return { ok: true }; }'))
			);

			expect(result).toEqual({ ok: true, value: { ok: true } });
			expect(capturedSignal?.aborted).toBe(true);
		},
		ENGINE_TIMEOUT
	);

	it('rejects an oversized child-to-parent frame before parsing it', async () => {
		const supervisor = new ConfinedSupervisor({ childPath: oversizeFrameChild, childExecArgv: [] });
		const result = await supervisor.invoke(positive());

		expect(result).toMatchObject({ ok: false, error: { code: 'crash' } });
	});

	it(
		'returns a parent-owned invalid-result when the child cannot fit the result under the cap',
		async () => {
			const supervisor = new ConfinedSupervisor({ limits: testLimits({ maxResultBytes: 1024 }) });

			const result = await supervisor.invoke(invocation(entry('() => ({ blob: "x".repeat(5000) })')));

			expect(result).toMatchObject({ ok: false, error: { code: 'invalid-result' } });
			expect(JSON.stringify(result)).not.toContain('xxxx');
		},
		ENGINE_TIMEOUT
	);

	it(
		'delivers a 256KB result without truncating the frame',
		async () => {
			const supervisor = new ConfinedSupervisor();

			const result = await supervisor.invoke(invocation(entry('() => ({ blob: "x".repeat(256 * 1024) })')));

			expect(result.ok).toBe(true);
			if (result.ok) expect(String((result.value as Record<string, unknown>)['blob']).length).toBe(256 * 1024);
		},
		ENGINE_TIMEOUT
	);

	it(
		'returns an uncorrupted framed result when the guest writes console output',
		async () => {
			const result = await new ConfinedSupervisor().invoke(
				invocation(entry('() => { try { console.log("noise"); } catch (e) {} return { ok: true, n: 1 }; }'))
			);

			expect(result).toEqual({ ok: true, value: { ok: true, n: 1 } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'gives the guest no require across the spawn boundary',
		async () => {
			const result = await new ConfinedSupervisor().invoke(invocation(entry('() => ({ require: typeof require })')));

			expect(result).toEqual({ ok: true, value: { require: 'undefined' } });
		},
		ENGINE_TIMEOUT
	);

	it(
		'denies the guest a host file read via node:fs across the spawn boundary',
		async () => {
			const result = await new ConfinedSupervisor().invoke(
				invocation(
					entry(
						'async () => { try { const fs = await import("node:fs"); fs.readFileSync("/etc/hostname"); return { read: true }; } catch (e) { return { read: false, denied: String((e && e.message) || e) }; } }'
					)
				)
			);

			expect(result.ok).toBe(true);

			if (result.ok) {
				const value = result.value as Record<string, unknown>;
				expect(value['read']).toBe(false);
				expect(String(value['denied'])).toMatch(/disabled|access/i);
			}
		},
		ENGINE_TIMEOUT
	);

	it(
		'denies a Function escape any reach to host authority across the spawn boundary',
		async () => {
			process.env['CONFINED_SUP_PROBE_SECRET'] = 'host-secret-must-not-leak';

			try {
				const result = await new ConfinedSupervisor().invoke(
					invocation(
						entry(
							'() => { const g = Function("return this")(); return { hostSecret: (g.process && g.process.env) ? (g.process.env.CONFINED_SUP_PROBE_SECRET ?? null) : null, require: typeof g.require }; }'
						)
					)
				);

				expect(result.ok).toBe(true);

				if (result.ok) {
					const value = result.value as Record<string, unknown>;
					expect(value['hostSecret']).toBeNull();
					expect(value['require']).toBe('undefined');
				}
			} finally {
				delete process.env['CONFINED_SUP_PROBE_SECRET'];
			}
		},
		ENGINE_TIMEOUT
	);
});
