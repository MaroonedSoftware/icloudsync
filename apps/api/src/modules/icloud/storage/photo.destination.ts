import { z } from 'zod';
import { PHOTO_LAYOUTS, type PhotoLayout } from './photo.layout.js';
import { PHOTO_NAMINGS, type PhotoNaming } from './photo.naming.js';

/**
 * Where an account's photos are backed up, and how they're organized once there.
 * This is the single user-facing knob that replaces the two orthogonal
 * layout/naming dropdowns: the user picks a *destination* (and, for the
 * filesystem, a *preset*), and the low-level mechanics are derived from it.
 *
 * - `filesystem` writes the original bytes to the {@link PhotoArchive}
 *   ({@link StorageProvider}), organized per the chosen {@link FilesystemPreset}.
 * - `immich` uploads each asset straight into an Immich server via its API, so
 *   Immich owns storage entirely (no layout/naming applies).
 */
export type DestinationKind = 'filesystem' | 'immich';

/**
 * A filesystem organization preset. Rather than exposing `layout × naming = 9`
 * combinations, three intent-named presets cover the real cases:
 *
 * - `immich` (default) → flat, original filenames, plus an XMP sidecar per asset
 *   carrying capture date, favorite rating, and album membership. Optimized for
 *   an Immich external library mounted read-only over the archive.
 * - `browsable` → a `YYYY/YYYY-MM` date tree with original filenames, for a human
 *   browsing the raw files directly.
 * - `custom` → the advanced escape hatch: the raw {@link PhotoLayout} /
 *   {@link PhotoNaming} knobs, for people who organize the archive their own way.
 *   This is also where pre-existing installs land (their configured layout/naming
 *   are honored verbatim).
 */
export type FilesystemPreset = 'immich' | 'browsable' | 'custom';

/** All valid filesystem presets (for config validation). */
export const FILESYSTEM_PRESETS = ['immich', 'browsable', 'custom'] as const;

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

/** A resolved Immich destination: the server to upload into and what to reconcile there. */
export interface ImmichDestination {
    kind: 'immich';
    /** Base URL of the Immich server, e.g. `https://immich.example.com`. */
    baseUrl: string;
    /** An Immich API key with upload + album permissions. */
    apiKey: string;
    /** Recreate each iCloud album as an Immich album and add the assets to it. */
    recreateAlbums: boolean;
    /** Mark iCloud favorites as favorites in Immich on upload. */
    syncFavorites: boolean;
}

/** The fully-resolved backup destination the sync job acts on. */
export type Destination = FilesystemDestination | ImmichDestination;

/**
 * Fixed preset → mechanics. `custom` is intentionally absent: it resolves from
 * the stored `photos_layout` / `photos_naming` settings, which the caller passes
 * to {@link filesystemDestination}.
 */
export const PRESET_MECHANICS: Record<Exclude<FilesystemPreset, 'custom'>, FilesystemMechanics> = {
    immich: { layout: 'flat', naming: 'clean', sidecars: true },
    browsable: { layout: 'date', naming: 'clean', sidecars: false },
};

/**
 * Compile a filesystem preset into a concrete destination. For a fixed preset the
 * mechanics come from {@link PRESET_MECHANICS}; for `custom` they come from the
 * caller's stored layout/naming (sidecars off — the browsable/custom archives are
 * for direct human browsing, not an Immich mount).
 */
export function filesystemDestination(preset: FilesystemPreset, custom: { layout: PhotoLayout; naming: PhotoNaming }): FilesystemDestination {
    if (preset === 'custom') {
        return { kind: 'filesystem', preset, layout: custom.layout, naming: custom.naming, sidecars: false };
    }
    return { kind: 'filesystem', preset, ...PRESET_MECHANICS[preset] };
}

/** Whether a resolved destination needs iCloud album membership resolved up front (for grouping, sidecars, or Immich albums). */
export function destinationNeedsAlbums(dest: Destination): boolean {
    if (dest.kind === 'immich') return dest.recreateAlbums;
    return dest.layout === 'album' || dest.sidecars;
}

/**
 * The persisted destination config (an `app_settings` row). Filesystem stores
 * only the preset (layout/naming for `custom` live in their own legacy settings,
 * kept for backward compatibility); Immich stores its full connection config.
 */
export const destinationSettingSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('filesystem'), preset: z.enum(FILESYSTEM_PRESETS) }),
    z.object({
        kind: z.literal('immich'),
        baseUrl: z.string().trim().url(),
        apiKey: z.string().trim().min(1),
        recreateAlbums: z.boolean().default(true),
        syncFavorites: z.boolean().default(true),
    }),
]);

/** The shape stored in `app_settings` under the destination key. */
export type DestinationSetting = z.infer<typeof destinationSettingSchema>;

/**
 * The patch a client may PATCH to change the destination. Same shape as the
 * stored value; the service resolves it into a {@link Destination} for the job.
 */
export const destinationPatchSchema = destinationSettingSchema;

/** Re-exported so callers validating the raw knobs don't need two imports. */
export { PHOTO_LAYOUTS, PHOTO_NAMINGS };
export type { PhotoLayout, PhotoNaming };
