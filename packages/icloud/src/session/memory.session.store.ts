import type { SessionStore } from './session.store.js';

/** In-memory {@link SessionStore}; primarily for tests and ephemeral sessions. */
export class MemorySessionStore implements SessionStore {
    private readonly store = new Map<string, Uint8Array>();

    async read(key: string): Promise<Uint8Array | null> {
        return this.store.get(key) ?? null;
    }

    async write(key: string, data: Uint8Array): Promise<void> {
        this.store.set(key, data);
    }

    async remove(key: string): Promise<void> {
        this.store.delete(key);
    }
}
