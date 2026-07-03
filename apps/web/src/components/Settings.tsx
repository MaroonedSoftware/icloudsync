import { useEffect, useState } from 'react';
import {
    api,
    type AppSettings,
    type Destination,
    type FilesystemPreset,
    type NotificationChannel,
    type NotificationSettings,
    type PhotoLayout,
    type PhotoNaming,
} from '../api.js';
import { scheduleLabel } from '../format.js';

export const LAYOUTS: { value: PhotoLayout; label: string }[] = [
    { value: 'flat', label: 'Flat (all in one folder)' },
    { value: 'date', label: 'By date (YYYY/YYYY-MM)' },
    { value: 'album', label: 'By album' },
];

export const NAMINGS: { value: PhotoNaming; label: string }[] = [
    { value: 'clean', label: 'Original name (IMG_0001.HEIC)' },
    { value: 'datetime', label: 'Date-time prefix (20240315-143022_IMG_0001.HEIC)' },
    { value: 'hash', label: 'Name + id (IMG_0001~a1b2c3.HEIC)' },
];

/** Filesystem organization presets, in the order shown. */
export const PRESETS: { value: FilesystemPreset; label: string; hint: string }[] = [
    {
        value: 'immich',
        label: 'Immich-ready',
        hint: 'Flat folder, original filenames, plus an XMP sidecar per photo carrying favorites and album membership. Best when Immich reads this folder as an external library.',
    },
    {
        value: 'browsable',
        label: 'Browsable archive',
        hint: 'A YYYY/YYYY-MM date tree with original filenames — for browsing the raw files yourself.',
    },
    {
        value: 'custom',
        label: 'Custom…',
        hint: 'Choose the folder layout and filename scheme by hand.',
    },
];

/** The human label for a layout/naming value (falls back to the raw value). */
export const layoutLabel = (v: PhotoLayout): string => LAYOUTS.find(l => l.value === v)?.label ?? v;
export const namingLabel = (v: PhotoNaming): string => NAMINGS.find(n => n.value === v)?.label ?? v;
const presetHint = (v: FilesystemPreset): string => PRESETS.find(p => p.value === v)?.hint ?? '';

/** A blank Immich destination, used when switching to the Immich destination. */
const EMPTY_IMMICH: Extract<Destination, { kind: 'immich' }> = { kind: 'immich', baseUrl: '', apiKey: '', recreateAlbums: true, syncFavorites: true };
const DEFAULT_DESTINATION: Destination = { kind: 'filesystem', preset: 'immich' };

const CRON_PRESETS = [
    { value: '0 * * * *', label: 'Hourly' },
    { value: '0 */6 * * *', label: 'Every 6 hours' },
    { value: '0 0 * * *', label: 'Daily' },
];

const CHANNELS: { value: NotificationChannel; label: string }[] = [
    { value: 'none', label: 'Off' },
    { value: 'webhook', label: 'Webhook' },
    { value: 'email', label: 'Email (SMTP)' },
];

const EMPTY_EMAIL = { host: '', port: 587, secure: false, username: '', password: '', from: '', to: '' };

const DEFAULT_NOTIFICATIONS: NotificationSettings = { channel: 'none', throttleHours: 24 };

/**
 * Assemble a valid notifications patch: include `webhookUrl`/`email` only when
 * their required fields are filled, so an in-progress form doesn't fail the
 * server's per-channel validation.
 */
function notificationsPatch(n: NotificationSettings): NotificationSettings {
    const patch: NotificationSettings = { channel: n.channel, throttleHours: n.throttleHours };
    if (n.webhookUrl) patch.webhookUrl = n.webhookUrl;
    if (n.email && n.email.host && n.email.from && n.email.to) patch.email = n.email;
    return patch;
}

/** Edit the database-backed settings (photo layout, file naming, sync schedule, admin notifications). */
export function Settings({ onChange }: { onChange?: () => void }) {
    const [destination, setDestination] = useState<Destination>(DEFAULT_DESTINATION);
    const [layout, setLayout] = useState<PhotoLayout>('flat');
    const [naming, setNaming] = useState<PhotoNaming>('clean');
    const [cron, setCron] = useState('0 */6 * * *');
    const [notifications, setNotifications] = useState<NotificationSettings>(DEFAULT_NOTIFICATIONS);
    const [loaded, setLoaded] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const [saved, setSaved] = useState(false);
    const [testState, setTestState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [testError, setTestError] = useState<string>();

    const apply = (s: AppSettings) => {
        setDestination(s.destination ?? DEFAULT_DESTINATION);
        setLayout(s.photosLayout);
        setNaming(s.photosNaming);
        setCron(s.syncCron);
        setNotifications(s.notifications ?? DEFAULT_NOTIFICATIONS);
    };

    useEffect(() => {
        void api
            .settings()
            .then(s => {
                apply(s);
                setLoaded(true);
            })
            .catch(err => setError(String(err)));
    }, []);

    const edit =
        <T,>(setter: (v: T) => void) =>
        (v: T) => {
            setter(v);
            setDirty(true);
            setSaved(false);
        };

    // Switch destination kind, preserving any in-progress Immich fields when toggling back.
    const setKind = (kind: Destination['kind']) =>
        edit(setDestination)(kind === 'immich' ? (destination.kind === 'immich' ? destination : EMPTY_IMMICH) : DEFAULT_DESTINATION);
    const setPreset = (preset: FilesystemPreset) => edit(setDestination)({ kind: 'filesystem', preset });
    const editImmich = (patch: Partial<Extract<Destination, { kind: 'immich' }>>) => {
        if (destination.kind === 'immich') edit(setDestination)({ ...destination, ...patch });
    };

    const editNotifications = (patch: Partial<NotificationSettings>) => edit(setNotifications)({ ...notifications, ...patch });
    const editEmail = (patch: Partial<NonNullable<NotificationSettings['email']>>) =>
        editNotifications({ email: { ...EMPTY_EMAIL, ...notifications.email, ...patch } });

    const save = async () => {
        setSaving(true);
        setError(undefined);
        try {
            apply(
                await api.updateSettings({
                    destination,
                    // Persist the raw layout/naming too so the filesystem `custom` preset keeps them.
                    photosLayout: layout,
                    photosNaming: naming,
                    syncCron: cron,
                    notifications: notificationsPatch(notifications),
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

    const sendTest = async () => {
        setTestState('sending');
        setTestError(undefined);
        try {
            await api.testNotification();
            setTestState('sent');
        } catch (err) {
            setTestState('idle');
            setTestError(err instanceof Error ? err.message : String(err));
        }
    };

    const email = notifications.email ?? EMPTY_EMAIL;

    return (
        <div className="card">
            <div className="card-head">
                <h2>Settings</h2>
                {saved && !dirty && <span className="muted">Saved</span>}
            </div>

            {error && <div className="error">{error}</div>}

            <label htmlFor="destination">Where photos go</label>
            <select id="destination" value={destination.kind} disabled={!loaded} onChange={e => setKind(e.target.value as Destination['kind'])}>
                <option value="filesystem">Filesystem archive</option>
                <option value="immich">Immich (upload via API)</option>
            </select>

            {destination.kind === 'filesystem' && (
                <>
                    <label htmlFor="preset">Organization</label>
                    <select id="preset" value={destination.preset} disabled={!loaded} onChange={e => setPreset(e.target.value as FilesystemPreset)}>
                        {PRESETS.map(p => (
                            <option key={p.value} value={p.value}>
                                {p.label}
                            </option>
                        ))}
                    </select>
                    <p className="muted" style={{ marginTop: -6 }}>
                        {presetHint(destination.preset)}
                    </p>

                    {destination.preset === 'custom' && (
                        <>
                            <label htmlFor="layout">Folder layout</label>
                            <select id="layout" value={layout} disabled={!loaded} onChange={e => edit(setLayout)(e.target.value as PhotoLayout)}>
                                {LAYOUTS.map(l => (
                                    <option key={l.value} value={l.value}>
                                        {l.label}
                                    </option>
                                ))}
                            </select>

                            <label htmlFor="naming">File naming</label>
                            <select id="naming" value={naming} disabled={!loaded} onChange={e => edit(setNaming)(e.target.value as PhotoNaming)}>
                                {NAMINGS.map(n => (
                                    <option key={n.value} value={n.value}>
                                        {n.label}
                                    </option>
                                ))}
                            </select>
                            <p className="muted" style={{ marginTop: -6 }}>
                                An account can override the layout/naming on its own page. Applies to newly synced photos.
                            </p>
                        </>
                    )}
                </>
            )}

            {destination.kind === 'immich' && (
                <>
                    <label htmlFor="immich-url">Immich server URL</label>
                    <input
                        id="immich-url"
                        type="url"
                        value={destination.baseUrl}
                        disabled={!loaded}
                        spellCheck={false}
                        placeholder="https://immich.example.com"
                        onChange={e => editImmich({ baseUrl: e.target.value })}
                    />

                    <label htmlFor="immich-key">API key</label>
                    <input
                        id="immich-key"
                        type="password"
                        value={destination.apiKey}
                        disabled={!loaded}
                        autoComplete="new-password"
                        placeholder="Immich → Account Settings → API Keys"
                        onChange={e => editImmich({ apiKey: e.target.value })}
                    />

                    <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <input type="checkbox" checked={destination.recreateAlbums} disabled={!loaded} onChange={e => editImmich({ recreateAlbums: e.target.checked })} />
                        <span>Recreate iCloud albums as Immich albums</span>
                    </label>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <input type="checkbox" checked={destination.syncFavorites} disabled={!loaded} onChange={e => editImmich({ syncFavorites: e.target.checked })} />
                        <span>Mark iCloud favorites as favorites in Immich</span>
                    </label>
                    <p className="muted" style={{ marginTop: 6 }}>
                        Immich owns storage: it dedupes by checksum and builds the timeline from each photo's metadata, so there's no folder layout to choose.
                    </p>
                </>
            )}

            <label htmlFor="cron">Sync schedule (cron)</label>
            <input id="cron" type="text" value={cron} disabled={!loaded} spellCheck={false} onChange={e => edit(setCron)(e.target.value)} />
            <div className="row" style={{ marginTop: -6, marginBottom: 14 }}>
                <span className="muted">{scheduleLabel(cron)}</span>
                <span className="spacer" />
                {CRON_PRESETS.map(p => (
                    <button key={p.value} type="button" onClick={() => edit(setCron)(p.value)}>
                        {p.label}
                    </button>
                ))}
            </div>

            <h3>Admin notifications</h3>
            <p className="muted" style={{ marginTop: -4 }}>
                Alert an admin when an account's session expires and needs re-authentication.
            </p>

            <label htmlFor="notify-channel">Delivery channel</label>
            <select
                id="notify-channel"
                value={notifications.channel}
                disabled={!loaded}
                onChange={e => editNotifications({ channel: e.target.value as NotificationChannel })}
            >
                {CHANNELS.map(c => (
                    <option key={c.value} value={c.value}>
                        {c.label}
                    </option>
                ))}
            </select>

            {notifications.channel === 'webhook' && (
                <>
                    <label htmlFor="notify-webhook">Webhook URL</label>
                    <input
                        id="notify-webhook"
                        type="url"
                        value={notifications.webhookUrl ?? ''}
                        disabled={!loaded}
                        spellCheck={false}
                        placeholder="https://…"
                        onChange={e => editNotifications({ webhookUrl: e.target.value })}
                    />
                    <p className="muted" style={{ marginTop: -6 }}>
                        POSTs a JSON body ({'{ kind, title, message, account, content, text }'}) — works with Discord, Slack, ntfy, Gotify, and custom
                        endpoints.
                    </p>
                </>
            )}

            {notifications.channel === 'email' && (
                <>
                    <div className="row" style={{ gap: 8 }}>
                        <div style={{ flex: 2 }}>
                            <label htmlFor="smtp-host">SMTP host</label>
                            <input
                                id="smtp-host"
                                type="text"
                                value={email.host}
                                disabled={!loaded}
                                spellCheck={false}
                                onChange={e => editEmail({ host: e.target.value })}
                            />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="smtp-port">Port</label>
                            <input
                                id="smtp-port"
                                type="number"
                                value={email.port}
                                disabled={!loaded}
                                onChange={e => editEmail({ port: Number(e.target.value) })}
                            />
                        </div>
                    </div>
                    <label className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <input type="checkbox" checked={email.secure} disabled={!loaded} onChange={e => editEmail({ secure: e.target.checked })} />
                        <span>Use implicit TLS (port 465)</span>
                    </label>
                    <div className="row" style={{ gap: 8 }}>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="smtp-user">Username</label>
                            <input
                                id="smtp-user"
                                type="text"
                                value={email.username ?? ''}
                                disabled={!loaded}
                                spellCheck={false}
                                autoComplete="off"
                                onChange={e => editEmail({ username: e.target.value })}
                            />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="smtp-pass">Password</label>
                            <input
                                id="smtp-pass"
                                type="password"
                                value={email.password ?? ''}
                                disabled={!loaded}
                                autoComplete="new-password"
                                onChange={e => editEmail({ password: e.target.value })}
                            />
                        </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="smtp-from">From</label>
                            <input
                                id="smtp-from"
                                type="text"
                                value={email.from}
                                disabled={!loaded}
                                spellCheck={false}
                                placeholder="icloudsync@example.com"
                                onChange={e => editEmail({ from: e.target.value })}
                            />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label htmlFor="smtp-to">To (admin)</label>
                            <input
                                id="smtp-to"
                                type="text"
                                value={email.to}
                                disabled={!loaded}
                                spellCheck={false}
                                placeholder="admin@example.com"
                                onChange={e => editEmail({ to: e.target.value })}
                            />
                        </div>
                    </div>
                </>
            )}

            {notifications.channel !== 'none' && (
                <>
                    <label htmlFor="notify-throttle">Re-notify at most every (hours)</label>
                    <input
                        id="notify-throttle"
                        type="number"
                        min={0}
                        value={notifications.throttleHours}
                        disabled={!loaded}
                        onChange={e => editNotifications({ throttleHours: Number(e.target.value) })}
                    />
                    <div className="row" style={{ marginTop: 8, marginBottom: 4, alignItems: 'center' }}>
                        <button type="button" onClick={sendTest} disabled={!loaded || testState === 'sending'}>
                            {testState === 'sending' ? 'Sending…' : 'Send test'}
                        </button>
                        {testState === 'sent' && <span className="muted">Sent</span>}
                        <span className="spacer" />
                    </div>
                    {testError && <div className="error">{testError}</div>}
                    {dirty && (
                        <p className="muted" style={{ marginTop: 0 }}>
                            Save your changes before sending a test.
                        </p>
                    )}
                </>
            )}

            <button className="primary compact" onClick={save} disabled={saving || !dirty || !loaded} style={{ marginTop: 12 }}>
                {saving ? 'Saving…' : 'Save settings'}
            </button>
        </div>
    );
}
