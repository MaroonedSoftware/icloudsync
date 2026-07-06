import { z } from 'zod';
import { PHOTO_LAYOUTS, type PhotoLayout } from './photo.layout.js';
import { PHOTO_NAMINGS, type PhotoNaming } from './photo.naming.js';

/**
 * Where an account's photos are backed up, and how they're organized once there.
 * This is the single user-facing knob that replaces the two orthogonal
 * layout/naming dropdowns: the user picks a *destination* (and, for the
 * filesystem, a *preset*), and the low-level mechanics are derived from it.
 *
 * The choice is made *per account* (see `AccountsService.photoSettings`): one
 * account can archive to the filesystem while another uploads to Immich. The
 * Immich *connection* it uploads to (server URL + API key) is global, configured
 * once in settings ({@link ImmichSettings}) rather than repeated on every account.
 *
 * - `filesystem` writes the original bytes to the {@link PhotoArchive}
 *   ({@link StorageProvider}), organized per the chosen {@link FilesystemPreset}.
 * - `immich` uploads each asset straight into the globally-configured Immich
 *   server via its API, so Immich owns storage entirely (no layout/naming applies).
 */
export type DestinationKind = 'filesystem' | 'immich';

/** All valid per-account destination kinds (for config validation). */
export const DESTINATION_KINDS = ['filesystem', 'immich'] as const;

/** The destination kind an account falls back to when it has not pinned its own. */
export const DEFAULT_DESTINATION_KIND: DestinationKind = 'filesystem';

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

/**
 * A resolved Immich destination: the server to upload into and what to reconcile
 * there. Its fields come straight from the global {@link ImmichSettings} — the
 * account only chooses to *route* here, it does not carry its own connection.
 */
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

/** Whether a resolved destination needs iCloud album membership resolved up front (for grouping, sidecars, or Immich albums). */
export function destinationNeedsAlbums(dest: Destination): boolean {
    if (dest.kind === 'immich') return dest.recreateAlbums;
    return dest.layout === 'album' || dest.sidecars;
}

/**
 * The global Immich *connection* (an `app_settings` row). This is configured once
 * and shared by every account that routes to Immich — the server to upload into,
 * the API key, and the two reconcile behaviors. Which accounts actually use it is
 * a per-account choice (see {@link DestinationKind}); an account set to `immich`
 * with no connection configured here is skipped at sync time.
 */
export const immichSettingsSchema = z.object({
    baseUrl: z.string().trim().url(),
    apiKey: z.string().trim().min(1),
    recreateAlbums: z.boolean().default(true),
    syncFavorites: z.boolean().default(true),
});

/** The shape stored in `app_settings` under the Immich-connection key. */
export type ImmichSettings = z.infer<typeof immichSettingsSchema>;

/**
 * Resolve the global Immich connection into a full {@link ImmichDestination} for
 * the sync job. The account contributes only the decision to route here.
 */
export function immichDestination(settings: ImmichSettings): ImmichDestination {
    return { kind: 'immich', ...settings };
}

/** Re-exported so callers validating the raw knobs don't need two imports. */
export { PHOTO_LAYOUTS, PHOTO_NAMINGS };
export type { PhotoLayout, PhotoNaming };
