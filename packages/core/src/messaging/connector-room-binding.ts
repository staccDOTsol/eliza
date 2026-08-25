/**
 * Encodes durable connector account/server bindings inside room metadata.
 * The array form preserves multiple connector accounts that share one
 * canonical platform room while remaining portable across database adapters.
 */

import type { Metadata } from "../types/index.ts";

const CONNECTOR_BINDINGS_KEY = "connectorBindings";

export interface ConnectorRoomBinding {
	source: string;
	accountId: string;
	serverId: string;
}

function normalizeBinding(value: unknown): ConnectorRoomBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const source = typeof record.source === "string" ? record.source.trim() : "";
	const accountId =
		typeof record.accountId === "string" ? record.accountId.trim() : "";
	const serverId =
		typeof record.serverId === "string" ? record.serverId.trim() : "";
	return source && accountId && serverId
		? { source, accountId, serverId }
		: undefined;
}

/** Return only well-formed persisted connector bindings. */
export function getConnectorRoomBindings(
	metadata: unknown,
): ConnectorRoomBinding[] {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return [];
	}
	const raw = (metadata as Record<string, unknown>)[CONNECTOR_BINDINGS_KEY];
	if (!Array.isArray(raw)) return [];
	const bindings = new Map<string, ConnectorRoomBinding>();
	for (const value of raw) {
		const binding = normalizeBinding(value);
		if (!binding) continue;
		bindings.set(
			`${binding.source}\u0000${binding.accountId}\u0000${binding.serverId}`,
			binding,
		);
	}
	return [...bindings.values()];
}

/**
 * Shallow-merge ordinary room metadata while unioning canonical connector
 * bindings so one account reconciliation cannot erase another account.
 */
export function mergeConnectorRoomMetadata(
	existing: Metadata | undefined,
	incoming: Metadata | undefined,
	binding?: ConnectorRoomBinding,
): Metadata | undefined {
	const merged: Record<string, unknown> = {
		...(existing ?? {}),
		...(incoming ?? {}),
	};
	const bindings = new Map<string, ConnectorRoomBinding>();
	for (const candidate of [
		...getConnectorRoomBindings(existing),
		...getConnectorRoomBindings(incoming),
		...(binding ? [binding] : []),
	]) {
		const normalized = normalizeBinding(candidate);
		if (!normalized) continue;
		bindings.set(
			`${normalized.source}\u0000${normalized.accountId}\u0000${normalized.serverId}`,
			normalized,
		);
	}
	if (bindings.size > 0) {
		merged[CONNECTOR_BINDINGS_KEY] = [...bindings.values()];
	} else {
		delete merged[CONNECTOR_BINDINGS_KEY];
	}
	return Object.keys(merged).length > 0 ? (merged as Metadata) : undefined;
}
