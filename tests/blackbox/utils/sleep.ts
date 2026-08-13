export function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(() => {
			resolve();
		}, ms);
	});
}

export function delayedSleep(ms: number) {
	let sleepHasStarted = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveSleep!: () => void;

	const finished = new Promise<void>((resolve) => {
		resolveSleep = resolve;
	});

	return {
		start() {
			if (sleepHasStarted) return;
			sleepHasStarted = true;
			timer = setTimeout(resolveSleep, ms);
		},
		cancel() {
			if (timer) clearTimeout(timer);
		},
		finished,
	};
}
