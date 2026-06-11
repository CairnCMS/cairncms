import { describe, expect, it } from 'vitest';
import {
	createConfinedTemplateHost,
	TEMPLATE_RENDER_LIMIT_MS,
	type ConfinedTemplateHostDeps,
} from './host-template.js';
import { TEMPLATE_OUTPUT_BYTES } from './sandbox-limits.js';

const liveSignal = new AbortController().signal;

// The honest stall budget: the engine checks its render deadline between
// template nodes and loop iterations, so the observed event-loop gap must stay
// within the deadline plus slack. The slack absorbs scheduler noise on a
// contended suite runner (parallel test workers saturating cores delay the
// heartbeat by far more than the engine stalls), so the discriminating power
// comes from the hostile templates being sized to run for minutes without the
// limiters: a bounded render passes with room, an unbounded one fails every
// retry.
const STALL_SLACK_MS = 1250;

function makeHost(overrides: Partial<ConfinedTemplateHostDeps> = {}) {
	return createConfinedTemplateHost({
		capabilities: { template: true },
		templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
		...overrides,
	});
}

async function withHeartbeat<T>(work: () => Promise<T>): Promise<{ result: T; maxGapMs: number }> {
	let last = performance.now();
	let maxGapMs = 0;

	const timer = setInterval(() => {
		const now = performance.now();
		maxGapMs = Math.max(maxGapMs, now - last);
		last = now;
	}, 10);

	try {
		const result = await work();
		maxGapMs = Math.max(maxGapMs, performance.now() - last);
		return { result, maxGapMs };
	} finally {
		clearInterval(timer);
	}
}

describe('createConfinedTemplateHost', () => {
	it('denies without the template capability', async () => {
		for (const capabilities of [{}, { template: false }]) {
			const host = makeHost({ capabilities });
			const reply = await host.renderLiquid({ template: 'x' }, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}
	});

	it('renders a plain template with data', async () => {
		const host = makeHost();
		const reply = await host.renderLiquid({ template: 'Hello {{ name }}!', data: { name: 'world' } }, liveSignal);
		expect(reply).toEqual({ ok: true, value: 'Hello world!' });
	});

	it('renders an absent variable as empty without data', async () => {
		const host = makeHost();
		const reply = await host.renderLiquid({ template: '{{ missing }}.' }, liveSignal);
		expect(reply).toEqual({ ok: true, value: '.' });
	});

	it('rejects a non-string template and non-object data', async () => {
		const host = makeHost();

		for (const args of [{}, { template: 7 }, { template: 'x', data: 'y' }, { template: 'x', data: [1] }]) {
			const reply = await host.renderLiquid(args, liveSignal);
			expect(reply, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}
	});

	it('rejects malformed option and delimiter shapes', async () => {
		const host = makeHost();

		for (const options of [
			'verbose',
			{ engine: 'liquid' },
			{ delimiters: 'braces' },
			{ delimiters: { weird: '<' } },
			{ delimiters: { outputLeft: '' } },
			{ delimiters: { outputLeft: 'x'.repeat(9) } },
			{ delimiters: { tagLeft: 7 } },
		]) {
			const reply = await host.renderLiquid({ template: 'x', options }, liveSignal);
			expect(reply, JSON.stringify(options)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}
	});

	it('settles with a timeout on an aborted call without rendering', async () => {
		const controller = new AbortController();
		controller.abort();

		const host = makeHost();
		const reply = await host.renderLiquid({ template: '{{ name }}', data: { name: 'x' } }, controller.signal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});
});

describe('custom delimiters', () => {
	it('renders the reference output delimiters while default braces pass through untouched', async () => {
		const host = makeHost();

		const reply = await host.renderLiquid(
			{
				template: 'x {# name #} y {{ name }}',
				data: { name: 'world' },
				options: { delimiters: { outputLeft: '{#', outputRight: '#}' } },
			},
			liveSignal
		);

		expect(reply).toEqual({ ok: true, value: 'x world y {{ name }}' });
	});

	it('renders custom tag delimiters while default tags pass through untouched', async () => {
		const host = makeHost();

		const reply = await host.renderLiquid(
			{
				template: '<% if ok %>Y<% endif %> {% if ok %}no{% endif %}',
				data: { ok: true },
				options: { delimiters: { tagLeft: '<%', tagRight: '%>' } },
			},
			liveSignal
		);

		expect(reply).toEqual({ ok: true, value: 'Y {% if ok %}no{% endif %}' });
	});
});

describe('filesystem denial', () => {
	it('fails include, render, and layout by construction with a sanitized error', async () => {
		const host = makeHost();

		for (const template of [
			"{% include 'package.json' %}",
			"{% render 'package.json' %}",
			"{% layout 'frame' %}body",
		]) {
			const reply = await host.renderLiquid({ template }, liveSignal);

			expect(reply, template).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

			const message = (reply as { error: { message: string } }).error.message;
			expect(message).not.toContain('node_modules');
			expect(message).not.toContain(process.cwd());
			expect(message).not.toContain('\n');
		}
	});
});

describe('hostile templates', () => {
	it('terminates a CPU loop within the stall budget', { retry: 2 }, async () => {
		const host = makeHost();

		const { result, maxGapMs } = await withHeartbeat(() =>
			host.renderLiquid(
				{ template: '{% for a in (1..2000) %}{% for b in (1..2000) %}{% endfor %}{% endfor %}' },
				liveSignal
			)
		);

		expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		expect((result as { error: { message: string } }).error.message).toContain('limit');
		expect(maxGapMs).toBeLessThanOrEqual(TEMPLATE_RENDER_LIMIT_MS + STALL_SLACK_MS);
	});

	it('terminates a doubling expansion bomb within the stall budget', { retry: 2 }, async () => {
		const host = makeHost();

		let bomb = '{% capture c0 %}aaaaaaaaaaaaaaaa{% endcapture %}';

		for (let i = 1; i <= 40; i++) {
			bomb += `{% capture c${i} %}{{ c${i - 1} }}{{ c${i - 1} }}{% endcapture %}`;
		}

		bomb += '{{ c40 }}';

		const { result, maxGapMs } = await withHeartbeat(() => host.renderLiquid({ template: bomb }, liveSignal));

		expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		expect(maxGapMs).toBeLessThanOrEqual(TEMPLATE_RENDER_LIMIT_MS + STALL_SLACK_MS);
	});

	it('refuses a giant range up front through the memory budget', { retry: 2 }, async () => {
		const host = makeHost();

		const { result, maxGapMs } = await withHeartbeat(() =>
			host.renderLiquid({ template: '{% for i in (1..999999999) %}x{% endfor %}' }, liveSignal)
		);

		expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		expect(maxGapMs).toBeLessThanOrEqual(TEMPLATE_RENDER_LIMIT_MS + STALL_SLACK_MS);
	});

	it('terminates deep nesting within the stall budget without crashing', { retry: 2 }, async () => {
		const host = makeHost();
		const template = '{% if true %}'.repeat(3000) + 'x' + '{% endif %}'.repeat(3000);

		const { result, maxGapMs } = await withHeartbeat(() => host.renderLiquid({ template }, liveSignal));

		expect(result).toHaveProperty('ok');
		expect(maxGapMs).toBeLessThanOrEqual(TEMPLATE_RENDER_LIMIT_MS + STALL_SLACK_MS);
	});
});

describe('the output cap', () => {
	it('refuses output over the cap', async () => {
		const host = makeHost({ templateOutputBytes: 1024 });

		const reply = await host.renderLiquid({ template: '{% for i in (1..200) %}xxxxxxxxxx{% endfor %}' }, liveSignal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('refuses output whose serialized form inflates past the cap', async () => {
		// Quotes serialize to two bytes each, so the raw output fits the cap while
		// the serialized reply value does not.
		const host = makeHost({ templateOutputBytes: 1024 });

		const reply = await host.renderLiquid({ template: '{% for i in (1..600) %}"{% endfor %}' }, liveSignal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});
});
