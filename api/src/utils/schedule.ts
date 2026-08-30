import cron, { type Logger, type TaskOptions } from 'node-cron';
import logger from '../logger.js';
import { createRunCoordinator, isCoordinationEnabled, ScheduleCoordinationError } from '../schedule-coordination.js';

export interface ScheduledJob {
	stop(): Promise<void>;
}

function nodeCronLoggerAdapter(scheduleId: string): Logger {
	return {
		info: () => undefined,
		debug: () => undefined,
		warn: () => logger.warn({ scheduleId }, 'Scheduled task warning'),
		error: (message, err) => {
			const cause = message instanceof Error ? message : err;

			if (cause instanceof ScheduleCoordinationError) {
				logger.error(
					cause.occurrence === undefined ? { scheduleId } : { scheduleId, occurrence: cause.occurrence },
					'Schedule coordination failed'
				);
			} else {
				logger.error({ scheduleId }, 'Scheduled task failed');
			}
		},
	};
}

export function scheduleSynchronizedJob(
	id: string,
	rule: string,
	cb: (fireDate: Date) => void | Promise<void>,
	enabled?: () => boolean
): ScheduledJob | null {
	if (!cron.validate(rule)) {
		logger.error({ scheduleId: id }, 'Skipping schedule trigger with an invalid cron expression');
		return null;
	}

	const options: TaskOptions = {
		name: id,
		logger: nodeCronLoggerAdapter(id),
	};

	if (isCoordinationEnabled()) {
		options.distributed = true;
		const coordinator = createRunCoordinator(id);

		// Extension tasks register during CLI startup, so evaluate the live gate before each claim.
		options.runCoordinator = enabled
			? { shouldRun: (key, ttlMs) => (enabled() ? coordinator.shouldRun(key, ttlMs) : false) }
			: coordinator;
	}

	const task = cron.schedule(
		rule,
		(context) => {
			if (enabled && !enabled()) return;
			return cb(context.date);
		},
		options
	);

	const stop = async () => {
		await task.destroy();
	};

	return { stop };
}
