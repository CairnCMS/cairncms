import type { AuthMode } from '../config.js';
import type { SocketClient } from './base.js';

export interface RealtimeControllerAccess {
	broadcast: (frame: string, filter?: { user?: string; role?: string }) => void;
	clients: () => Set<SocketClient>;
}

export interface RealtimeAccess {
	transport: (key: string) => RealtimeControllerAccess | null;
	info: () => {
		rest: { authentication: AuthMode; path: string } | false;
		graphql: { authentication: AuthMode; path: string } | false;
		heartbeat: number;
	};
}

let activeAccess: RealtimeAccess | null = null;

export function getActiveRealtime(): RealtimeAccess | null {
	return activeAccess;
}

export function setActiveRealtime(access: RealtimeAccess): void {
	activeAccess = access;
}

export function clearActiveRealtime(access: RealtimeAccess): void {
	if (activeAccess === access) activeAccess = null;
}
