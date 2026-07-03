import { useEffect, useRef, useState } from 'react';
import { api, type AccountSettings, type PhotoLayout, type PhotoNaming } from '../api.js';
import { LAYOUTS, NAMINGS, layoutLabel, namingLabel } from './Settings.js';

// An empty string in the <select> means "inherit the global default".
const INHERIT = '';

// How often to re-check whether a prefix change's file move has finished.
const RELOCATE_POLL_MS = 3000;

/**
 * Per-account override for the on-disk organization (layout + file naming). Each
 * control offers an explicit "Use default" choice that inherits the global
 * setting; picking a value pins it for this account only. Mirrors the global
 * Settings panel's load/dirty/save flow.
 */
export function AccountStorage({ accountId, onChange }: { accountId: string; onChange?: () => void }) {
    const [settings, setSettings] = useState<AccountSettings>();
    const [layout, setLayout] = useState<PhotoLayout | ''>(INHERIT);
    const [naming, setNaming] = useState<PhotoNaming | ''>(INHERIT);
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
        setLayout(s.photosLayout ?? INHERIT);
        setNaming(s.photosNaming ?? INHERIT);
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

    const save = async () => {
        setSaving(true);
        setError(undefined);
        try {
            apply(await api.updateAccountSettings(accountId, { photosLayout: layout || null, photosNaming: naming || null, archivePrefix: prefix.trim() || null }));
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

    return (
        <div className="card">
            <div className="card-head">
                <h2>Storage for this account</h2>
                {relocating ? <span className="pulse">Moving files…</span> : saved && !dirty && <span className="muted">Saved</span>}
            </div>
            <p className="muted" style={{ marginTop: -4 }}>
                Override how this account's photos are organized on disk, or inherit the global defaults. Applies to newly synced photos.
            </p>

            {error && <div className="error">{error}</div>}
            {!relocating && relocationError && (
                <div className="error">
                    Archive move didn't finish: {relocationError}
                    <button type="button" onClick={retry} disabled={retrying} style={{ marginLeft: 8 }}>
                        {retrying ? 'Retrying…' : 'Retry move'}
                    </button>
                </div>
            )}
            {!relocating && !relocationError && moved && <div className="muted">✓ Existing files were moved to the new folder.</div>}

            <label htmlFor="acct-prefix">Archive folder</label>
            <input
                id="acct-prefix"
                type="text"
                value={prefix}
                disabled={!loaded}
                placeholder="Account id (default)"
                onChange={e => edit(setPrefix)(e.target.value)}
            />
            <p className="muted" style={{ marginTop: -4, fontSize: '0.85em' }}>
                Top-level folder this account's photos are archived under. Leave blank to use the account id.
                Give each account a <strong>distinct</strong> folder — two accounts sharing one can overwrite each other's files.
                Changing this moves already-backed-up files to the new folder.
            </p>

            <label htmlFor="acct-layout">Photo organization</label>
            <select id="acct-layout" value={layout} disabled={!loaded} onChange={e => edit(setLayout)(e.target.value as PhotoLayout | '')}>
                <option value={INHERIT}>Use default{defaults ? ` (${layoutLabel(defaults.photosLayout)})` : ''}</option>
                {LAYOUTS.map(l => (
                    <option key={l.value} value={l.value}>
                        {l.label}
                    </option>
                ))}
            </select>

            <label htmlFor="acct-naming">File naming</label>
            <select id="acct-naming" value={naming} disabled={!loaded} onChange={e => edit(setNaming)(e.target.value as PhotoNaming | '')}>
                <option value={INHERIT}>Use default{defaults ? ` (${namingLabel(defaults.photosNaming)})` : ''}</option>
                {NAMINGS.map(n => (
                    <option key={n.value} value={n.value}>
                        {n.label}
                    </option>
                ))}
            </select>

            <button className="primary compact" onClick={save} disabled={saving || !dirty || !loaded} style={{ marginTop: 12 }}>
                {saving ? 'Saving…' : 'Save storage settings'}
            </button>
        </div>
    );
}
