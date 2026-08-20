import { describe, expect, it } from 'vitest';
import { Admission, type AdmissionLimits } from './admission.js';

function makeAdmission(limits: Partial<AdmissionLimits> = {}): Admission {
	return new Admission({
		process: limits.process ?? 1000,
		ip: limits.ip ?? 1000,
		user: limits.user ?? 1000,
		transports: limits.transports ?? { rest: 1000 },
	});
}

describe('Admission', () => {
	it('throws on an unknown transport, distinct from a capacity rejection', () => {
		const admission = makeAdmission();
		expect(() => admission.reserve('graphql', '1.1.1.1')).toThrow(/graphql/);
	});

	describe('per-dimension limits accept at N and reject at N+1', () => {
		it('per-transport', () => {
			const admission = makeAdmission({ transports: { rest: 2 } });
			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
			expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull();
			expect(admission.reserve('rest', '3.3.3.3')).toBeNull();
		});

		it('process-wide', () => {
			const admission = makeAdmission({ process: 2, transports: { rest: 100 } });
			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
			expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull();
			expect(admission.reserve('rest', '3.3.3.3')).toBeNull();
		});

		it('per-IP', () => {
			const admission = makeAdmission({ ip: 2 });
			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();
		});
	});

	it('rolls back the transport slot when a later dimension rejects', () => {
		const admission = makeAdmission({ transports: { rest: 2 }, ip: 1, process: 10 });
		admission.reserve('rest', '1.1.1.1');
		expect(admission.reserve('rest', '1.1.1.1')).toBeNull(); // IP full: increments then rolls back transport

		expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull(); // the transport slot is recovered
		expect(admission.reserve('rest', '3.3.3.3')).toBeNull(); // transport full at 2
	});

	it('rolls back the process slot when a later dimension rejects', () => {
		const admission = makeAdmission({ transports: { rest: 10 }, ip: 1, process: 2 });
		admission.reserve('rest', '1.1.1.1');
		expect(admission.reserve('rest', '1.1.1.1')).toBeNull(); // IP full: increments then rolls back process

		expect(admission.reserve('rest', '2.2.2.2')).not.toBeNull(); // the process slot is recovered
		expect(admission.reserve('rest', '3.3.3.3')).toBeNull(); // process full at 2
	});

	it('rolls back the transport slot when the process limit rejects', () => {
		// A separate transport for the rejected reserve, so its leaked slot would survive closing the REST holder.
		const admission = makeAdmission({ transports: { rest: 1, graphql: 1 }, process: 1, ip: 100 });
		const rest = admission.reserve('rest', '1.1.1.1')!;
		expect(admission.reserve('graphql', '2.2.2.2')).toBeNull(); // process full: increments then rolls back graphql

		rest.close(); // frees the process slot, not the graphql transport slot
		expect(admission.reserve('graphql', '3.3.3.3')).not.toBeNull(); // graphql is free iff the rollback happened
	});

	it('reserves nothing on a rejected reserve, so a freed slot admits the next connection', () => {
		const admission = makeAdmission({ ip: 1 });
		const lease = admission.reserve('rest', '1.1.1.1');
		expect(admission.reserve('rest', '1.1.1.1')).toBeNull();

		lease!.close();
		expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
	});

	it('keeps per-transport slots independent while sharing process and IP totals', () => {
		const admission = makeAdmission({ transports: { rest: 1, graphql: 1 }, process: 10 });
		expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
		expect(admission.reserve('rest', '2.2.2.2')).toBeNull();
		expect(admission.reserve('graphql', '3.3.3.3')).not.toBeNull();

		const shared = makeAdmission({ transports: { rest: 5, graphql: 5 }, process: 2 });
		expect(shared.reserve('rest', '1.1.1.1')).not.toBeNull();
		expect(shared.reserve('graphql', '2.2.2.2')).not.toBeNull();
		expect(shared.reserve('graphql', '3.3.3.3')).toBeNull();
	});

	describe('bidirectional transition', () => {
		it('reserves the user bucket before releasing the IP bucket', () => {
			const admission = makeAdmission({ ip: 1, user: 5 });
			const lease = admission.reserve('rest', '1.1.1.1')!;

			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();
			expect(lease.transitionToUser('alice')).toBe(true);
			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
		});

		it('keeps the IP bucket held when the user bucket is full', () => {
			const admission = makeAdmission({ user: 1, ip: 1 });
			admission.reserve('rest', '9.9.9.9')!.transitionToUser('alice');

			const lease = admission.reserve('rest', '1.1.1.1')!;
			expect(lease.transitionToUser('alice')).toBe(false);
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull(); // the lease still occupies its IP bucket
		});

		it('reverts to anonymous on the retained IP', () => {
			const admission = makeAdmission({ ip: 1, user: 5 });
			const lease = admission.reserve('rest', '1.1.1.1')!;
			lease.transitionToUser('alice');

			expect(lease.transitionToAnonymous()).toBe(true);
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();
		});

		it('keeps the user bucket held when the IP bucket is full on revert', () => {
			const admission = makeAdmission({ ip: 1, user: 1 });
			const lease = admission.reserve('rest', '1.1.1.1')!;
			lease.transitionToUser('alice');
			admission.reserve('rest', '1.1.1.1'); // fills the IP bucket the lease would revert to

			expect(lease.transitionToAnonymous()).toBe(false);

			const other = admission.reserve('rest', '2.2.2.2')!;
			expect(other.transitionToUser('alice')).toBe(false); // the lease still occupies the user bucket
		});
	});

	describe('state-machine guards', () => {
		it('is idempotent for the same user and refuses a different user', () => {
			const admission = makeAdmission({ ip: 1, user: 5 });
			const lease = admission.reserve('rest', '1.1.1.1')!;
			expect(lease.transitionToUser('alice')).toBe(true);
			expect(lease.transitionToUser('alice')).toBe(true);
			expect(lease.transitionToUser('bob')).toBe(false);

			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();
		});

		it('is idempotent for repeated anonymous transitions', () => {
			const admission = makeAdmission();
			const lease = admission.reserve('rest', '1.1.1.1')!;
			expect(lease.transitionToAnonymous()).toBe(true);
			expect(lease.transitionToAnonymous()).toBe(true);
		});

		it('refuses every transition and hold after close', () => {
			const admission = makeAdmission();
			const lease = admission.reserve('rest', '1.1.1.1')!;
			lease.close();

			expect(lease.transitionToUser('alice')).toBe(false);
			expect(lease.transitionToAnonymous()).toBe(false);
			expect(lease.beginWorkHold()).toBeNull();
		});
	});

	it('releases exactly once across a double close', () => {
		const admission = makeAdmission({ ip: 2 });
		const first = admission.reserve('rest', '1.1.1.1')!;
		admission.reserve('rest', '1.1.1.1');

		first.close();
		first.close();

		expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
		expect(admission.reserve('rest', '1.1.1.1')).toBeNull();
	});

	describe('reference-counted work holds', () => {
		it('holds the slot until a single work hold clears', () => {
			const admission = makeAdmission({ ip: 1 });
			const lease = admission.reserve('rest', '1.1.1.1')!;

			const hold = lease.beginWorkHold();
			expect(hold).not.toBeNull();

			lease.close();
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();

			hold!.clear();
			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
		});

		it('allows concurrent holds and releases once, only when the last clears', () => {
			const admission = makeAdmission({ ip: 2 });
			const lease = admission.reserve('rest', '1.1.1.1')!;
			admission.reserve('rest', '1.1.1.1');

			const first = lease.beginWorkHold()!;
			const second = lease.beginWorkHold()!;
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();

			lease.close();
			first.clear();
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();

			first.clear();
			second.clear();
			second.clear();

			expect(admission.reserve('rest', '1.1.1.1')).not.toBeNull();
			expect(admission.reserve('rest', '1.1.1.1')).toBeNull();
		});
	});
});
