import { Channel } from './channel.js';

export const MAX_CHANNEL_FRAMES = 1000;
export const MAX_CHANNEL_BYTES = 8_388_608;

/** Owns subscription channels and their shared receive-buffer budget. */
export class ChannelRegistry {
	private readonly channels = new Map<string, Channel>();
	private frames = 0;
	private bytes = 0;
	private counter = 0;

	constructor(
		private readonly onOverflow: (error: Error) => void,
		private readonly maxFrames: number = MAX_CHANNEL_FRAMES,
		private readonly maxBytes: number = MAX_CHANNEL_BYTES
	) {}

	has(uid: string): boolean {
		return this.channels.has(uid);
	}

	create(uid: string): Channel {
		if (this.channels.has(uid)) {
			throw new Error(`A subscription with uid "${uid}" already exists.`);
		}

		const channel = new Channel((bytes) => {
			this.frames -= 1;
			this.bytes -= bytes;
		});

		this.channels.set(uid, channel);
		return channel;
	}

	delete(uid: string, expectedChannel: Channel): void {
		if (this.channels.get(uid) !== expectedChannel) return;
		expectedChannel.close();
		this.channels.delete(uid);
	}

	allocateUid(): string {
		let candidate: string;

		do {
			this.counter += 1;
			candidate = String(this.counter);
		} while (this.channels.has(candidate));

		return candidate;
	}

	route(uid: string, frame: Record<string, any>, bytes: number): void {
		const channel = this.channels.get(uid);
		if (channel === undefined) return;
		if (channel.tryHandoff(frame)) return;

		if (this.frames + 1 > this.maxFrames || this.bytes + bytes > this.maxBytes) {
			const error = new Error(
				`Realtime receive buffer overflow: the client-wide bound of ${this.maxFrames} frames or ${this.maxBytes} bytes was exceeded.`
			);

			this.failAll(error);
			this.onOverflow(error);
			return;
		}

		this.frames += 1;
		this.bytes += bytes;
		channel.enqueue(frame, bytes);
	}

	fail(uid: string, error: unknown): void {
		this.channels.get(uid)?.fail(error);
		this.channels.delete(uid);
	}

	failAll(error: Error): void {
		for (const channel of this.channels.values()) channel.fail(error);
		this.channels.clear();
	}

	closeAll(): void {
		for (const channel of this.channels.values()) channel.close();
		this.channels.clear();
	}
}
