import { useCallback, useEffect, useState } from 'react';
import { api, type AccountStatus } from './api.js';
import { Accounts } from './components/Accounts.js';
import { Dashboard } from './components/Dashboard.js';
import { Login } from './components/Login.js';

type View = 'dashboard' | 'admin';

// Remember the last account the user viewed so a reload or a later visit
// reopens it instead of falling back to the first account.
const LAST_ACCOUNT_KEY = 'icloudsync.lastAccount';
const readLastAccount = () => {
    try {
        return localStorage.getItem(LAST_ACCOUNT_KEY) ?? '';
    } catch {
        return '';
    }
};

/** Root app shell: loads accounts, remembers the last-viewed one, and switches between the dashboard, the admin view, and login/add-account. */
export function App() {
    const [accounts, setAccounts] = useState<AccountStatus[]>();
    const [selected, setSelected] = useState(readLastAccount);
    const [adding, setAdding] = useState(false);
    const [view, setView] = useState<View>('dashboard');

    const refresh = useCallback(async () => {
        const list = await api.accounts();
        setAccounts(list);
        setSelected(prev => {
            if (prev && list.some(a => a.id === prev)) return prev;
            return (list.find(a => a.authenticated) ?? list[0])?.id ?? '';
        });
        return list;
    }, []);

    // Persist the current selection so it survives a full page reload.
    useEffect(() => {
        try {
            if (selected) localStorage.setItem(LAST_ACCOUNT_KEY, selected);
        } catch {
            // Ignore storage failures (private mode, quota); selection just won't persist.
        }
    }, [selected]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // After a successful (re)auth, show that account's dashboard and leave add mode.
    const onAuthenticated = useCallback(
        async (id: string) => {
            await refresh();
            setSelected(id);
            setAdding(false);
            setView('dashboard');
        },
        [refresh],
    );

    const openAccount = useCallback((id: string) => {
        setSelected(id);
        setView('dashboard');
    }, []);

    if (accounts === undefined) {
        return (
            <div className="app">
                <div className="spinner">Loading…</div>
            </div>
        );
    }

    const current = accounts.find(a => a.id === selected);
    const showAdd = adding || accounts.length === 0;

    let body: React.ReactNode;
    if (showAdd) {
        body = <Login account="" onAuthenticated={onAuthenticated} onCancel={adding && accounts.length > 0 ? () => setAdding(false) : undefined} />;
    } else if (view === 'admin') {
        body = <Accounts onOpen={openAccount} onAdd={() => setAdding(true)} onChanged={refresh} />;
    } else if (!current || !current.authenticated) {
        body = <Login account={current?.account ?? ''} lockAccount={!!current} onAuthenticated={onAuthenticated} />;
    } else {
        body = <Dashboard id={current.id} account={current.account} onChanged={refresh} />;
    }

    return (
        <div className="app">
            <header className="bar">
                <div className="brand">
                    <span className="logo">☁︎</span>
                    <h1>iCloud Sync</h1>
                </div>
                <span className="spacer" />
                {!showAdd &&
                    (view === 'admin' ? (
                        <button className="compact" type="button" onClick={() => setView('dashboard')}>
                            ← Back
                        </button>
                    ) : (
                        <>
                            <select className="account-switch" value={selected} onChange={e => setSelected(e.target.value)} aria-label="Account">
                                {accounts.map(a => (
                                    <option key={a.id} value={a.id}>
                                        {a.account}
                                        {a.authenticated ? '' : ' · signed out'}
                                    </option>
                                ))}
                            </select>
                            <button className="compact" type="button" onClick={() => setView('admin')}>
                                Manage accounts
                            </button>
                            {current && (
                                <span className={`badge ${current.authenticated ? 'ok' : ''}`}>
                                    <span className="dot" />
                                    {current.authenticated ? 'Connected' : 'Signed out'}
                                </span>
                            )}
                        </>
                    ))}
            </header>

            {body}
        </div>
    );
}
