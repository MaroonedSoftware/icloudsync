/** How backed-up photo files are organized on disk under `<account>/`. */
export type PhotoLayout = 'flat' | 'date' | 'album';

/** All valid layout names (for config validation). */
export const PHOTO_LAYOUTS = ['flat', 'date', 'album'] as const;

/** The layout an account falls back to when it has not pinned its own override. */
export const DEFAULT_PHOTO_LAYOUT: PhotoLayout = 'flat';

/** Make an arbitrary string (album name, etc.) safe as a single path segment. */
function safeSegment(value: string): string {
    const cleaned = value.replace(/[/\\\x00]/g, '_').replace(/^\.+/, '').trim();
    return cleaned.length > 0 ? cleaned : '_';
}

/** The minimal asset shape the layout needs. */
export interface LayoutAsset {
    recordName: string;
    /** Capture date in epoch milliseconds, when known. */
    assetDate?: number;
}

/**
 * Compute the grouping folder(s) an asset is filed under for the chosen layout,
 * or `undefined` for `flat`. The archive composes the final key as
 * `<account>/<group?>/<recordName>/<filename>`, so the unique `recordName`
 * folder always guarantees no collisions regardless of layout.
 *
 * - `flat` → no grouping (`undefined`).
 * - `date` → `YYYY/YYYY-MM` from the capture date (`undated` when missing).
 * - `album` → the asset's album name via `albumOf` (`Unsorted` when it's in none).
 */
export function layoutGroup(layout: PhotoLayout, asset: LayoutAsset, albumOf?: (recordName: string) => string | undefined): string | undefined {
    if (layout === 'flat') return undefined;

    if (layout === 'date') {
        if (asset.assetDate == null) return 'undated';
        const date = new Date(asset.assetDate);
        if (Number.isNaN(date.getTime())) return 'undated';
        const year = String(date.getUTCFullYear());
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        return `${year}/${year}-${month}`;
    }

    // album
    const album = albumOf?.(asset.recordName);
    return album ? safeSegment(album) : 'Unsorted';
}
