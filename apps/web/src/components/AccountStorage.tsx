import { useEffect, useRef, useState } from 'react';
import { api, type AccountSettings, type DestinationKind, type FilesystemPreset, type PhotoLayout, type PhotoNaming } from '../api.js';
import { LAYOUTS, NAMINGS, PRESETS } from './Settings.js';

// How often to re-check whether a prefix change's file move has finished.
const RELOCATE_POLL_MS = 3000;

/**
 * The per-account "where photos go" options: each filesystem preset (from the
 * shared PRESETS list) plus an Immich upload. Encoded as `filesystem:<preset>` or
 * `immich` so the single dropdown maps cleanly to the destination + preset fields.
 */
type DestinationChoice = `filesystem:${FilesystemPreset}` | 'immich';
const DESTINATION_OPTIONS: { value: DestinationChoice; label: string; hint: string }[] = [
    ...PRESETS.map(p => ({ value: `filesystem:${p.value}` as DestinationChoice, label: p.label, hint: p.hint })),
    {
        value: 'immich',
        label: 'Immich (upload via API)',
        hint: 'Upload each photo to the Immich server configured in Settings. Immich owns storage, dedupes by checksum, and builds the timeline from metadata.',
    },
];
const choiceHint = (v: DestinationChoice): string => DESTINATION_OPTIONS.find(o => o.value === v)?.hint ?? '';

/**
 * Per-account setting for the on-disk organization (layout + file naming). Each
 * control lists the concrete options; an account with no override starts on the
 * built-in default (so the dropdown always shows a real value), and picking
 * anything pins it for this account only. `null` layout/naming means "inherit
 * the default" and is preserved until the user actively changes the control.
 * Mirrors the global Settings panel's load/dirty/save flow.
 */
export function AccountStorage({ accountId, onChange }: { accountId: string; onChange?: () => void }) {
    const [settings, setSettings] = useState<AccountSettings>();
    const [destination, setDestination] = useState<DestinationKind>('filesystem');
    const [preset, setPreset] = useState<FilesystemPreset>('immich');
    const [layout, setLayout] = useState<PhotoLayout | null>(null);
    const [naming, setNaming] = useState<PhotoNaming | null>(null);
    const [prefix, setPrefix] = useState('');
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [moved, setMoved] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [error, setError] = useState<string>();
    const wasRelocating = useRef(false);

    const apply = (s: AccountSettings) => {
        setSettings(s);
        // An unset destination/preset override shows the built-in default (so the
        // dropdown always reflects a real value); picking anything pins it.
        setDestination(s.photosDestination ?? s.defaults.photosDestination);
        setPreset(s.photosPreset ?? s.defaults.photosPreset);
        setLayout(s.photosLayout);
        setNaming(s.photosNaming);
        setPrefix(s.archivePrefix ?? '');
    };

    // Reload whenever the selected account changes.
    useEffect(() => {
        setSettings(undefined);
        setDirty(false);
        setSaved(false);
        setMoved(false);
        api.accountSettings(accountId)
            .then(apply)
            .catch(err => setError(String(err)));
    }, [accountId]);

    const relocating = settings?.relocating ?? false;
    const relocationError = settings?.relocationError ?? null;

    // While a prefix change's file move runs, poll until it finishes. Only the
    // relocation state is refreshed so an in-progress edit isn't clobbered.
    useEffect(() => {
        if (!relocating) return;
        const id = setInterval(() => {
            void api
                .accountSettings(accountId)
                .then(s => setSettings(prev => (prev ? { ...prev, relocating: s.relocating, relocationError: s.relocationError } : s)))
                .catch(() => {});
        }, RELOCATE_POLL_MS);
        return () => clearInterval(id);
    }, [relocating, accountId]);

    // Note when a move finishes so we can confirm success (or leave the error showing).
    useEffect(() => {
        if (relocating) setMoved(false);
        else if (wasRelocating.current && !relocationError) setMoved(true);
        wasRelocating.current = relocating;
    }, [relocating, relocationError]);

    const edit =
        <T,>(setter: (v: T) => void) =>
        (v: T) => {
            setter(v);
            setDirty(true);
            setSaved(false);
        };

    // Map the single "where photos go" dropdown back onto the destination + preset fields.
    const chooseDestination = (choice: DestinationChoice) => {
        setDirty(true);
        setSaved(false);
        if (choice === 'immich') {
            setDestination('immich');
        } else {
            setDestination('filesystem');
            setPreset(choice.slice('filesystem:'.length) as FilesystemPreset);
        }
    };

    const save = async () => {
        setSaving(true);
        setError(undefined);
        try {
            apply(
                await api.updateAccountSettings(accountId, {
                    photosDestination: destination,
                    photosPreset: preset,
                    photosLayout: layout,
                    photosNaming: naming,
                    archivePrefix: prefix.trim() || null,
                }),
            );
            setDirty(false);
            setSaved(true);
            onChange?.();
        } catch (err) {
            setError(String(err));
        } finally {
            setSaving(false);
        }
    };

    // Resume a move that failed part-way; the poll picks the run back up from the response.
    const retry = async () => {
        setRetrying(true);
        setError(undefined);
        try {
            const s = await api.retryRelocation(accountId);
            setSettings(prev => (prev ? { ...prev, relocating: s.relocating, relocationError: s.relocationError } : s));
            setMoved(false);
        } catch (err) {
            setError(String(err));
        } finally {
            setRetrying(false);
        }
    };

    const loaded = settings !== undefined;
    const defaults = settings?.defaults;
    // Per-account layout/naming overrides apply under any filesystem preset; Immich owns organization.
    const isFilesystem = destination === 'filesystem';
    const destValue: DestinationChoice = destination === 'immich' ? 'immich' : `filesystem:${preset}`;
    // Warn when this account routes to Immich but no Immich server is configured in Settings.
    const immichMissing = destination === 'immich' && settings !== undefined && !settings.immichConfigured;

    return (
        <div className="card">
            <div className="card-head">
                <h2>Storage for this account</h2>
                {relocating ? <span className="pulse">Moving files…</span> : saved && !dirty && <span className="muted">Saved</span>}
            </div>
            <p className="muted" style={{ marginTop: -4 }}>
                Choose where this account's photos go and how they're organized, or use the defaults. Applies to newly synced photos.
            </p>

            {error && <div className="error">{error}</div>}

            <label htmlFor="acct-destination">Where photos go</label>
            <select id="acct-destination" value={destValue} disabled={!loaded} onChange={e => chooseDestination(e.target.value as DestinationChoice)}>
                {DESTINATION_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
            <p className="muted" style={{ marginTop: -6, fontSize: '0.85em' }}>{choiceHint(destValue)}</p>
            {immichMissing && (
                <div className="error">No Immich server is configured. Add one in Settings before syncing this account, or its backups will be skipped.</div>
            )}

            {!relocating && relocationError && (
                <div className="error">
                    Archive move didn't finish: {relocationError}
                    <button type="button" onClick={retry} disabled={retrying} style={{ marginLeft: 8 }}>
                        {retrying ? 'Retrying…' : 'Retry move'}
                    </button>
                </div>
            )}
            {!relocating && !relocationError && moved && <div className="muted">✓ Existing files were moved to the new folder.</div>}

            {isFilesystem && (
                <>
                    <label htmlFor="acct-prefix">Archive folder</label>
                    <input
                        id="acct-prefix"
                        type="text"
                        value={prefix}
                        disabled={!loaded}
                        placeholder={settings?.defaultPrefix ? `${settings.defaultPrefix} (default)` : 'Default'}
                        onChange={e => edit(setPrefix)(e.target.value)}
                    />
                    <p className="muted" style={{ marginTop: -4, fontSize: '0.85em' }}>
                        Top-level folder this account's photos are archived under. Leave blank to use the default
                        {settings?.defaultPrefix ? ` (${settings.defaultPrefix}, from the Apple ID)` : ' (from the Apple ID)'}.
                        Give each account a <strong>distinct</strong> folder — two accounts sharing one can overwrite each other's files.
                        Changing this moves already-backed-up files to the new folder.
                    </p>
                </>
            )}

            {isFilesystem ? (
                <>
                    <label htmlFor="acct-layout">Photo organization</label>
                    <select id="acct-layout" value={layout ?? defaults?.photosLayout ?? 'flat'} disabled={!loaded} onChange={e => edit(setLayout)(e.target.value as PhotoLayout)}>
                        {LAYOUTS.map(l => (
                            <option key={l.value} value={l.value}>
                                {l.label}
                            </option>
                        ))}
                    </select>

                    <label htmlFor="acct-naming">File naming</label>
                    <select id="acct-naming" value={naming ?? defaults?.photosNaming ?? 'clean'} disabled={!loaded} onChange={e => edit(setNaming)(e.target.value as PhotoNaming)}>
                        {NAMINGS.map(n => (
                            <option key={n.value} value={n.value}>
                                {n.label}
                            </option>
                        ))}
                    </select>
                    <p className="muted" style={{ marginTop: -4, fontSize: '0.85em' }}>
                        Overrides the chosen preset's organization for this account. Leave a control on its default value to follow the preset.
                    </p>
                </>
            ) : (
                <p className="muted">Photos for this account upload to Immich, which owns organization — there is nothing to override here.</p>
            )}

            <button className="primary compact" onClick={save} disabled={saving || !dirty || !loaded} style={{ marginTop: 12 }}>
                {saving ? 'Saving…' : 'Save storage settings'}
            </button>
        </div>
    );
}
