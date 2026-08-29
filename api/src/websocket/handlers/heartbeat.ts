import type { WebSocket } from 'ws';

export function startHeartbeat(ws: WebSocket, periodMs: number, onDead: () => void): () => void {
	let stopped = false;
	let deadline: ReturnType<typeof setTimeout>;

	const onExpire = () => {
		teardown();
		onDead();
	};

	const armDeadline = () => {
		deadline = setTimeout(onExpire, 2 * periodMs);
	};

	const pingTimer = setInterval(() => ws.ping(), periodMs);

	const onPong = () => {
		if (stopped) return;
		clearTimeout(deadline);
		armDeadline();
	};

	function teardown() {
		if (stopped) return;
		stopped = true;
		clearInterval(pingTimer);
		clearTimeout(deadline);
		ws.off('pong', onPong);
	}

	armDeadline();
	ws.on('pong', onPong);

	return teardown;
}
