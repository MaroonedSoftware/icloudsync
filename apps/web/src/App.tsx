import { useCallback, useEffect, useState } from 'react';
import { api, type AccountStatus } from './api.js';
import { Accounts } from './components/Accounts.js';
import { Dashboard } from './components/Dashboard.js';
import { Login } from './components/Login.js';

type View = 'dashboard' | 'admin';

export function App() {
    const [accounts, setAccounts] = useState<AccountStatus[]>();
    const [selected, setSelected] = useState('');
    const [adding, setAdding] = useState(false);
    const [view, setView] = useState<View>('dashboard');

    const refresh = useCallback(async () => {
        const list = await api.accounts();
        setAccounts(list);
        setSelected(prev => {
            if (prev && list.some(a => a.account === prev)) return prev;
            return (list.find(a => a.authenticated) ?? list[0])?.account ?? '';
        });
        return list;
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // After a successful (re)auth, show that account's dashboard and leave add mode.
    const onAuthenticated = useCallback(
        async (account: string) => {
            await refresh();
            setSelected(account);
            setAdding(false);
            setView('dashboard');
        },
        [refresh],
    );

    const openAccount = useCallback((account: string) => {
        setSelected(account);
        setView('dashboard');
    }, []);

    if (accounts === undefined) {
        return (
            <div className="app">
                <div className="spinner">Loading…</div>
            </div>
        );
    }

    const current = accounts.find(a => a.account === selected);
    const showAdd = adding || accounts.length === 0;

    let body: React.ReactNode;
    if (showAdd) {
        body = <Login account="" onAuthenticated={onAuthenticated} onCancel={adding && accounts.length > 0 ? () => setAdding(false) : undefined} />;
    } else if (view === 'admin') {
        body = <Accounts onOpen={openAccount} onAdd={() => setAdding(true)} onChanged={refresh} />;
    } else if (!current || !current.authenticated) {
        body = <Login account={current?.account ?? ''} lockAccount={!!current} onAuthenticated={onAuthenticated} />;
    } else {
        body = <Dashboard account={selected} onChanged={refresh} />;
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
                                    <option key={a.account} value={a.account}>
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
