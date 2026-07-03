import { useCallback, useEffect, useState } from 'react';
import { api, type AccountOverview, type Overview } from '../api.js';
import { bytes, count, relativeTime, scheduleLabel } from '../format.js';

/**
 * Admin overview across every registered account: status, backup stats, and
 * management actions (sync, sign out, remove). Reads the aggregate
 * `GET /icloud/overview` so it doesn't fan out one request per account.
 */
export function Accounts({
    onOpen,
    onAdd,
    onChanged,
}: {
    /** View a single account's dashboard. */
    onOpen: (account: string) => void;
    /** Start the add-account flow. */
    onAdd: () => void;
    /** Notify the parent that the account set/status changed (so it can refresh). */
    onChanged: () => void;
}) {
    const [overview, setOverview] = useState<Overview>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState<string>();

    const load = useCallback(async () => {
        try {
            setOverview(await api.overview());
            setError(undefined);
        } catch (err) {
            setError(String(err));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // Run an action tagged by `key` (so only the acting row shows busy), then reload.
    const act = async (key: string, fn: () => Promise<unknown>) => {
        setBusy(key);
        setError(undefined);
        try {
            await fn();
            await load();
            onChanged();
        } catch (err) {
            setError(String(err));
        } finally {
            setBusy(undefined);
        }
    };

    const accounts = overview?.accounts ?? [];

    const syncAll = () => act('all', () => api.syncAll());
    const syncOne = (id: string) => act(`sync:${id}`, () => api.triggerSync(id));
    const signOut = (id: string) => act(`out:${id}`, () => api.logout(id));
    const remove = (id: string) => {
        const email = accounts.find(a => a.id === id)?.account ?? 'this account';
        if (!window.confirm(`Remove ${email}? This forgets its session and stops backing it up. Photos already archived are kept.`)) return;
        void act(`rm:${id}`, () => api.removeAccount(id));
    };

    return (
        <>
            <div className="card panel">
                <div className="panel-main">
                    <h2>Accounts</h2>
                    <p className="sub">
                        {overview ? `${count(accounts.length)} account${accounts.length === 1 ? '' : 's'} · ${scheduleLabel(overview.schedule)}` : 'Loading…'}
                    </p>
                </div>
                <button type="button" onClick={onAdd}>
                    ＋ Add account
                </button>
                <button className="primary compact" onClick={syncAll} disabled={busy != null || accounts.length === 0}>
                    {busy === 'all' ? 'Starting…' : '↻ Sync all'}
                </button>
            </div>

            {error && <div className="error">{error}</div>}

            {overview === undefined ? (
                <div className="spinner">Loading…</div>
            ) : accounts.length === 0 ? (
                <div className="empty">No accounts yet. Add one to start backing it up.</div>
            ) : (
                accounts.map(a => <Row key={a.id} account={a} busy={busy} onOpen={onOpen} onSync={syncOne} onSignOut={signOut} onRemove={remove} />)
            )}
        </>
    );
}

function Row({
    account,
    busy,
    onOpen,
    onSync,
    onSignOut,
    onRemove,
}: {
    account: AccountOverview;
    busy: string | undefined;
    onOpen: (a: string) => void;
    onSync: (a: string) => void;
    onSignOut: (a: string) => void;
    onRemove: (a: string) => void;
}) {
    const id = account.id;
    const email = account.account;
    const anyBusy = busy != null;
    return (
        <div className="card account-row">
            <div className="account-row-head">
                <button className="link" type="button" onClick={() => onOpen(id)} title="View this account">
                    {email}
                </button>
                <span className={`badge ${account.authenticated ? 'ok' : ''}`}>
                    <span className="dot" />
                    {account.authenticated ? 'Connected' : 'Signed out'}
                </span>
            </div>

            <div className="account-row-stats muted">
                <span>{count(account.backedUp)} of {count(account.total)} backed up</span>
                <span>·</span>
                <span>{bytes(account.backedUpBytes)}</span>
                <span>·</span>
                <span>Last backup {relativeTime(account.lastSyncedAt)}</span>
            </div>

            <div className="account-row-actions">
                <button type="button" onClick={() => onOpen(id)} disabled={anyBusy}>
                    Open
                </button>
                <button type="button" onClick={() => onSync(id)} disabled={anyBusy}>
                    {busy === `sync:${id}` ? 'Starting…' : 'Sync now'}
                </button>
                {account.authenticated && (
                    <button type="button" onClick={() => onSignOut(id)} disabled={anyBusy}>
                        {busy === `out:${id}` ? 'Signing out…' : 'Sign out'}
                    </button>
                )}
                <span className="spacer" />
                <button className="danger" type="button" onClick={() => onRemove(id)} disabled={anyBusy}>
                    {busy === `rm:${id}` ? 'Removing…' : 'Remove'}
                </button>
            </div>
        </div>
    );
}
