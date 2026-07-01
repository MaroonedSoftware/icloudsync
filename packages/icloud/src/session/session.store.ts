/**
 * Pluggable persistence for the serialized {@link AuthSession} blob (cookies,
 * trust token, dsid, webservices map, …).
 *
 * The interface is deliberately a string-keyed byte store so an `apps/api`
 * adapter can satisfy it on top of `@maroonedsoftware/storage` (filesystem /
 * S3 / GCS), optionally wrapping the bytes with `@maroonedsoftware/encryption`
 * for encryption at rest — without this package depending on either.
 */
export interface SessionStore {
    /** Return the stored bytes for `key`, or `null` if absent. */
    read(key: string): Promise<Uint8Array | null>;
    /** Write (overwrite) the bytes for `key`. */
    write(key: string, data: Uint8Array): Promise<void>;
    /** Remove `key`; a no-op if it does not exist. */
    remove(key: string): Promise<void>;
}
