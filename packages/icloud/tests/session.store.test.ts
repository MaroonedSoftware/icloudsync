import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionStore } from '../src/session/file.session.store.js';
import { MemorySessionStore } from '../src/session/memory.session.store.js';
import type { SessionStore } from '../src/session/session.store.js';

function contract(name: string, make: () => Promise<{ storage: SessionStore; cleanup: () => Promise<void> }>) {
    describe(name, () => {
        let storage: SessionStore;
        let cleanup: () => Promise<void>;

        beforeEach(async () => {
            ({ storage, cleanup } = await make());
        });
        afterEach(async () => {
            await cleanup();
        });

        it('returns null for a missing key', async () => {
            expect(await storage.read('missing')).toBeNull();
        });

        it('writes then reads back bytes', async () => {
            const data = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
            await storage.write('session.json', data);
            const read = await storage.read('session.json');
            expect(read).not.toBeNull();
            expect(new TextDecoder().decode(read!)).toBe('{"hello":"world"}');
        });

        it('overwrites on a second write', async () => {
            await storage.write('k', new TextEncoder().encode('first'));
            await storage.write('k', new TextEncoder().encode('second'));
            expect(new TextDecoder().decode((await storage.read('k'))!)).toBe('second');
        });

        it('removes a key (and tolerates removing a missing one)', async () => {
            await storage.write('k', new Uint8Array([1]));
            await storage.remove('k');
            expect(await storage.read('k')).toBeNull();
            await expect(storage.remove('k')).resolves.toBeUndefined();
        });
    });
}

contract('MemorySessionStore', async () => ({
    storage: new MemorySessionStore(),
    cleanup: async () => {},
}));

contract('FileSessionStore', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'icloudsync-'));
    return {
        storage: new FileSessionStore(dir),
        cleanup: async () => {
            await rm(dir, { recursive: true, force: true });
        },
    };
});
