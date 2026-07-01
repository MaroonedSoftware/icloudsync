import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionStore } from './session.store.js';

/** Replace anything outside a safe filename charset. */
function sanitize(key: string): string {
    return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Filesystem-backed {@link SessionStore}. Defaults to `~/.icloudsync`; files are
 * written with `0600` permissions since the blob contains live session
 * material. This is the standalone / dev default — `apps/api` is expected to
 * inject a `@maroonedsoftware/storage`-backed adapter instead.
 */
export class FileSessionStore implements SessionStore {
    constructor(private readonly dir: string = path.join(homedir(), '.icloudsync')) {}

    private file(key: string): string {
        return path.join(this.dir, sanitize(key));
    }

    async read(key: string): Promise<Uint8Array | null> {
        try {
            return new Uint8Array(await readFile(this.file(key)));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    }

    async write(key: string, data: Uint8Array): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        await writeFile(this.file(key), data, { mode: 0o600 });
    }

    async remove(key: string): Promise<void> {
        try {
            await rm(this.file(key));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
}
