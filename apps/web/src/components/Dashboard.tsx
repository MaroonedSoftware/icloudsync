import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadUrl, thumbnailResolution, type Photo, type Stats } from '../api.js';
import { bytes, count, relativeTime, scheduleLabel } from '../format.js';
import { AccountStorage } from './AccountStorage.js';
import { Settings } from './Settings.js';

const RECENT_COUNT = 12;
const POLL_MS = 4000;
const MAX_POLL_MS = 150_000;

/** Single account's view: backup stats, recent photos, live sync progress, settings, and account actions. */
export function Dashboard({ id, account, onChanged }: { id: string; account: string; onChanged: () => void }) {
    const [stats, setStats] = useState<Stats>();
    const [recent, setRecent] = useState<Photo[]>();
    const [error, setError] = useState<string>();
    const [syncing, setSyncing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const pollUntil = useRef(0);

    const refresh = useCallback(async (): Promise<Stats | undefined> => {
        try {
            const [s, page] = await Promise.all([api.stats(id), api.listPhotos(id, { limit: RECENT_COUNT, order: 'desc' })]);
            setStats(s);
            setRecent(page.photos);
            setError(undefined);
            // Reflect a sync started elsewhere (a schedule, another tab, or before a reload).
            if (s.running) setSyncing(true);
            return s;
        } catch (err) {
            setError(String(err));
            return undefined;
        }
    }, [id]);

    // Reset per-account view state when switching accounts so stale photos don't flash.
    useEffect(() => {
        setStats(undefined);
        setRecent(undefined);
        setSyncing(false);
        setCancelling(false);
    }, [id]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // While a sync is active, poll until the server reports it finished and the
    // backed-up count has settled (or we hit the cap). Checking `running` keeps us
    // from declaring a still-running sync done, and ends promptly after a cancel.
    useEffect(() => {
        if (!syncing) return;
        let last = stats?.total ?? -1;
        let stable = 0;
        const id = setInterval(() => {
            void (async () => {
                const s = await refresh();
                if (s) {
                    if (s.total === last) {
                        stable += 1;
                    } else {
                        stable = 0;
                        last = s.total;
                    }
                    if ((!s.running && stable >= 2) || Date.now() > pollUntil.current) setSyncing(false);
                } else if (Date.now() > pollUntil.current) {
                    setSyncing(false);
                }
            })();
        }, POLL_MS);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncing, refresh]);

    const syncNow = async (force = false) => {
        if (force && !window.confirm('Re-download and re-store every photo, ignoring what is already backed up? Useful after changing where this account backs up. This can take a while for a large library.')) return;
        setBusy(true);
        setError(undefined);
        try {
            await api.triggerSync(id, { force });
            pollUntil.current = Date.now() + MAX_POLL_MS;
            setSyncing(true);
            await refresh();
        } catch (err) {
            setError(`Could not start sync: ${String(err)}`);
        } finally {
            setBusy(false);
        }
    };

    const cancelSync = async () => {
        setCancelling(true);
        setError(undefined);
        try {
            await api.cancelSync(id);
            await refresh(); // reflect the wind-down; polling clears `syncing` once it stops
        } catch (err) {
            setError(`Could not cancel sync: ${String(err)}`);
        } finally {
            setCancelling(false);
        }
    };

    const logout = async () => {
        setBusy(true);
        try {
            await api.logout(id);
            onChanged();
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!window.confirm(`Remove ${account}? This forgets its session and stops backing it up. Photos already archived are kept.`)) return;
        setBusy(true);
        try {
            await api.removeAccount(id);
            onChanged();
        } finally {
            setBusy(false);
        }
    };

    // Prefer the library size pulled at the sync's start as the denominator so it
    // stays fixed while a first sync pages metadata in; fall back to rows synced.
    const backupDenominator = stats ? (stats.libraryTotal ?? stats.total) : 0;
    const backedUpLabel = stats ? `${count(stats.backedUp)} of ${count(backupDenominator)}` : '—';

    return (
        <>
            {error && <div className="error">{error}</div>}

            <div className="stats">
                <Stat label="Photos backed up" value={backedUpLabel} />
                <Stat label="Storage used" value={stats ? bytes(stats.backedUpBytes) : '—'} />
                <Stat label="Favorites" value={stats ? count(stats.favorites) : '—'} />
                <Stat label="Last backup" value={stats ? relativeTime(stats.lastSyncedAt) : '—'} />
            </div>

            <div className="card panel">
                <div className="panel-main">
                    <h2>Automatic backup</h2>
                    <p className="sub">
                        {stats ? scheduleLabel(stats.schedule) : 'Loading…'}
                        {syncing && <span className="pulse"> · {cancelling ? 'cancelling…' : 'syncing now…'}</span>}
                    </p>
                </div>
                {syncing ? (
                    <button className="compact" onClick={cancelSync} disabled={cancelling}>
                        {cancelling ? 'Cancelling…' : '✕ Cancel'}
                    </button>
                ) : (
                    <div className="panel-actions">
                        <button className="primary compact" onClick={() => syncNow()} disabled={busy}>
                            {busy ? 'Starting…' : '↻ Sync now'}
                        </button>
                        <button className="compact" onClick={() => syncNow(true)} disabled={busy} title="Re-download and re-store every photo, ignoring what's already backed up.">
                            Full re-sync
                        </button>
                    </div>
                )}
            </div>

            <div className="card">
                <div className="card-head">
                    <h2>Recent backups</h2>
                    {stats && <span className="muted">{count(stats.total)} total</span>}
                </div>
                {recent === undefined ? (
                    <div className="spinner">Loading…</div>
                ) : recent.length === 0 ? (
                    <div className="empty">Nothing backed up yet. Run a sync to get started.</div>
                ) : (
                    <div className="strip">
                        {recent.map(p => (
                            <Thumb key={p.recordName} accountId={id} photo={p} />
                        ))}
                    </div>
                )}
            </div>

            <AccountStorage accountId={id} onChange={refresh} />

            <Settings onChange={refresh} />

            <div className="footer-row">
                <button onClick={logout} disabled={busy}>
                    Sign out
                </button>
                <button className="danger" onClick={remove} disabled={busy}>
                    Remove account
                </button>
            </div>
        </>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="card stat">
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
        </div>
    );
}

function Thumb({ accountId, photo }: { accountId: string; photo: Photo }) {
    const thumb = thumbnailResolution(photo);
    const full = 'resOriginalRes' in photo.resources ? 'resOriginalRes' : thumb;
    if (!thumb) return null;
    return (
        <a className="thumb" href={full ? downloadUrl(accountId, photo.recordName, full) : undefined} target="_blank" rel="noreferrer"
            title={photo.filename ?? photo.recordName}>
            <img loading="lazy" src={downloadUrl(accountId, photo.recordName, thumb)} alt={photo.filename ?? photo.recordName} />
            {photo.isFavorite && <span className="fav">★</span>}
        </a>
    );
}
