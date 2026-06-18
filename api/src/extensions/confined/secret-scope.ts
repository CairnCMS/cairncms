import { randomBytes } from 'node:crypto';

// What a per-invocation secret handle points at. The scope stores the location of a
// sensitive value, never the plaintext, so a handle is meaningless on its own and the
// brokered-use path resolves it from its source at the moment of use.
export type ConfinedSecretBinding =
	| { kind: 'flow-operation-option'; operationId: string; key: string }
	| { kind: 'extension-setting'; extensionId: string; contributionId: string; key: string };

/**
 * Per-invocation registry of opaque secret-reference tokens. One scope is shared by
 * a confined invocation's option preparation and its host broker, so a token minted
 * for a sensitive option and a token minted by settings.get live in one namespace.
 * That single namespace is what request-denial and log redaction check, so neither
 * can be bypassed by routing a token through the other surface. Tokens are 192-bit
 * random and meaningless outside the invocation that minted them.
 */
export class ConfinedSecretScope {
	private readonly bindings = new Map<string, ConfinedSecretBinding>();
	private readonly resolved = new Set<string>();

	mint(binding: ConfinedSecretBinding): string {
		const ref = randomBytes(24).toString('base64url');
		this.bindings.set(ref, binding);
		return ref;
	}

	// True when a string contains any minted token. Substring matching mirrors log
	// redaction so an embedded token (`Bearer <ref>`) is caught too.
	containsRef(value: string): boolean {
		for (const ref of this.bindings.keys()) {
			if (value.includes(ref)) return true;
		}

		return false;
	}

	// The minted tokens, added to redaction contexts so a token echoed into a log or
	// a Flow revision is scrubbed.
	refs(): string[] {
		return [...this.bindings.keys()];
	}

	// Resolves a token to what it points at, for the brokered-use path that swaps the
	// real secret in at the moment of an outbound call. A token not minted in this
	// scope resolves to undefined, so a forged or cross-invocation token never resolves.
	resolve(ref: string): ConfinedSecretBinding | undefined {
		return this.bindings.get(ref);
	}

	// Records a real secret value the broker resolved for brokered use, so it is scrubbed
	// from logs and an echoing upstream response even though it never reaches the guest.
	registerResolved(value: string): void {
		if (value.length > 0) this.resolved.add(value);
	}

	// The resolved real secret values, for scrubbing an upstream response that echoes an
	// injected secret back to the guest.
	resolvedSecrets(): string[] {
		return [...this.resolved];
	}

	// Everything that must be scrubbed from logs and revisions: the opaque refs and the
	// resolved real values.
	redactionValues(): string[] {
		return [...this.bindings.keys(), ...this.resolved];
	}
}
