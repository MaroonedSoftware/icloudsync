import { createHash } from 'node:crypto';

/**
 * How an archived photo's *filename* is composed within its layout folder. This
 * replaces the old per-photo `<recordName>/` sub-folder (an opaque CloudKit GUID
 * that made the archive unbrowsable) with a real filename sitting directly in
 * the group folder. All three schemes are collision-safe — the sync job appends
 * a short deterministic token when two different assets would otherwise claim the
 * same name (see {@link withSuffix} / {@link shortHash}).
 *
 * - `clean` → the original filename as-is (prettiest); disambiguated only on a
 *   real collision, so the first-synced photo keeps the clean name.
 * - `datetime` → the capture timestamp prefixed to the filename
 *   (`20240315-143022_IMG_0001.HEIC`): fully deterministic, sorts
 *   chronologically, and collisions are near-impossible.
 * - `hash` → a 6-char hash of the record id inserted before the extension
 *   (`IMG_0001~a1b2c3.HEIC`): simplest and guaranteed unique with no lookups.
 */
export type PhotoNaming = 'clean' | 'datetime' | 'hash';

/** All valid naming schemes (for config validation). */
export const PHOTO_NAMINGS = ['clean', 'datetime', 'hash'] as const;

/** The minimal asset shape a naming scheme needs. */
export interface NamingAsset {
    recordName: string;
    /** Original filename from iCloud, when known. */
    filename?: string;
    /** Capture date in epoch milliseconds, when known (used by `datetime`). */
    assetDate?: number;
}

/** Make a filename safe to use as a single path segment, or `undefined` if nothing survives. */
function sanitize(filename: string | undefined): string | undefined {
    if (!filename) return undefined;
    const cleaned = filename.replace(/[/\\\x00]/g, '_').replace(/^\.+/, '').trim();
    return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * A short, stable per-record token used to disambiguate colliding filenames.
 * Derived from the CloudKit `recordName` so the same asset always yields the same
 * suffix across runs (keeping re-syncs idempotent).
 */
export function shortHash(recordName: string): string {
    return createHash('sha1').update(recordName).digest('hex').slice(0, 6);
}

/** Split a filename into stem + extension (extension includes the dot, empty when there is none). */
function splitExt(name: string): { stem: string; ext: string } {
    const dot = name.lastIndexOf('.');
    // dot <= 0 covers "no extension" and a name that is only a leading dot.
    return dot <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** Insert a suffix before the extension: `IMG.HEIC` + `~ab12cd` → `IMG~ab12cd.HEIC`. */
export function withSuffix(leaf: string, suffix: string): string {
    const { stem, ext } = splitExt(leaf);
    return `${stem}${suffix}${ext}`;
}

/** Format a capture date as `YYYYMMDD-HHMMSS` in UTC, or `undated` when unknown/invalid. */
function stamp(assetDate: number | undefined): string {
    if (assetDate == null) return 'undated';
    const date = new Date(assetDate);
    if (Number.isNaN(date.getTime())) return 'undated';
    const pad = (n: number): string => String(n).padStart(2, '0');
    const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
    const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
    return `${day}-${time}`;
}

/**
 * Compute the filename segment an asset is archived under for the chosen scheme.
 * The archive composes the final key as `<account>/<group?>/<leaf>`, so this
 * value is a single path segment (never contains a separator). When the original
 * filename is missing or sanitizes away, the `recordName` stands in as the stem.
 *
 * The result is collision-agnostic: `hash` is inherently unique, while `clean`
 * and `datetime` can theoretically collide and are made safe by the sync job,
 * which appends `~<shortHash>` when a *different* asset already holds the name.
 */
export function namingLeaf(naming: PhotoNaming, asset: NamingAsset): string {
    const name = sanitize(asset.filename) ?? asset.recordName;
    if (naming === 'datetime') return `${stamp(asset.assetDate)}_${name}`;
    if (naming === 'hash') return withSuffix(name, `~${shortHash(asset.recordName)}`);
    return name; // clean
}
