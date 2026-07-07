import { PHOTO_LAYOUTS, type PhotoLayout } from './photo.layout.js';
import { PHOTO_NAMINGS, type PhotoNaming } from './photo.naming.js';

/**
 * How an account's photos are organized in the {@link PhotoArchive}
 * ({@link StorageProvider}). The user picks a *preset* (and may override the
 * low-level layout/naming), and the mechanics are derived from it.
 *
 * The choice is made *per account* (see `AccountsService.photoSettings`): each
 * account files its archive under its own preset. The original bytes are always
 * written to the filesystem archive, organized per the chosen
 * {@link FilesystemPreset}.
 */

/** The filesystem preset an account falls back to when it has not pinned its own. */
export const DEFAULT_FILESYSTEM_PRESET: FilesystemPreset = 'immich';

/**
 * A filesystem organization preset — the per-account *baseline* for how photos
 * are filed. Two intent-named presets cover the common cases; either one's layout
 * and naming can be further overridden per account (see
 * `AccountsService.photoSettings`), while the XMP-sidecar behavior always follows
 * the preset.
 *
 * - `immich` (default) → flat, original filenames, plus an XMP sidecar per asset
 *   carrying capture date, favorite rating, and album membership. Optimized for
 *   an Immich external library mounted read-only over the archive.
 * - `browsable` → a `YYYY/YYYY-MM` date tree with original filenames, for a human
 *   browsing the raw files directly.
 */
export type FilesystemPreset = 'immich' | 'browsable';

/** All valid filesystem presets (for config validation). */
export const FILESYSTEM_PRESETS = ['immich', 'browsable'] as const;

/** The resolved on-disk mechanics a filesystem preset compiles down to. */
export interface FilesystemMechanics {
    layout: PhotoLayout;
    naming: PhotoNaming;
    /** Whether to emit an XMP sidecar (`<file>.xmp`) next to each archived asset. */
    sidecars: boolean;
}

/** A resolved filesystem destination: the preset plus the mechanics it compiles to. */
export interface FilesystemDestination extends FilesystemMechanics {
    kind: 'filesystem';
    preset: FilesystemPreset;
}

/** The fully-resolved backup destination the sync job acts on. */
export type Destination = FilesystemDestination;

/**
 * Preset → baseline mechanics. The `layout`/`naming` here are the *defaults* a
 * preset files under; an account may override them ({@link filesystemDestination}
 * takes the resolved values). `sidecars` always follows the preset.
 */
export const PRESET_MECHANICS: Record<FilesystemPreset, FilesystemMechanics> = {
    immich: { layout: 'flat', naming: 'clean', sidecars: true },
    browsable: { layout: 'date', naming: 'clean', sidecars: false },
};

/**
 * Compile a filesystem preset plus the effective (possibly per-account) layout
 * and naming into a concrete destination. The layout/naming are taken as given —
 * the caller resolves per-account overrides against the preset baseline — and
 * only the XMP-sidecar behavior is dictated by the preset.
 */
export function filesystemDestination(preset: FilesystemPreset, mechanics: { layout: PhotoLayout; naming: PhotoNaming }): FilesystemDestination {
    return { kind: 'filesystem', preset, layout: mechanics.layout, naming: mechanics.naming, sidecars: PRESET_MECHANICS[preset].sidecars };
}

/** Whether a resolved destination needs iCloud album membership resolved up front (for grouping or sidecars). */
export function destinationNeedsAlbums(dest: Destination): boolean {
    return dest.layout === 'album' || dest.sidecars;
}

/** Re-exported so callers validating the raw knobs don't need two imports. */
export { PHOTO_LAYOUTS, PHOTO_NAMINGS };
export type { PhotoLayout, PhotoNaming };
