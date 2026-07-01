import { useEffect, useState } from 'react';
import { ApiError, api, type TwoFactorOptions } from '../api.js';

type Step = 'password' | 'mfa';
type Method = 'device' | 'phone';

/** Sign-in flow for an iCloud account: password entry followed by two-factor (trusted-device or SMS) verification. */
export function Login({
    account,
    lockAccount = false,
    onAuthenticated,
    onCancel,
}: {
    account: string;
    /** Re-authenticating an existing account: the Apple ID is fixed and not editable. */
    lockAccount?: boolean;
    onAuthenticated: (account: string) => void;
    /** When set, show a cancel action (used for "Add account" over an existing one). */
    onCancel?: () => void;
}) {
    const [step, setStep] = useState<Step>('password');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const [accountName, setAccountName] = useState(account);
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [method, setMethod] = useState<Method>('device');
    const [code, setCode] = useState('');

    const [options, setOptions] = useState<TwoFactorOptions>();
    const [phoneId, setPhoneId] = useState<number>();
    const [phoneSent, setPhoneSent] = useState(false);
    const [deviceSent, setDeviceSent] = useState(false);

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(undefined);
        try {
            await fn();
        } catch (err) {
            setError(err instanceof ApiError ? friendly(err) : String(err));
        } finally {
            setBusy(false);
        }
    };

    const submitPassword = (e: React.FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const name = accountName.trim();
            const result = await api.login(name, password);
            setPassword('');
            if (result.state === 'authenticated') onAuthenticated(name);
            else setStep('mfa');
        });
    };

    // Load delivery options when entering the MFA step, and ask Apple to push a
    // code to the trusted devices (the default method). Apple does not reliably
    // auto-push on the sign-in 409, so without this no code arrives on any device.
    useEffect(() => {
        if (step !== 'mfa') return;
        void run(async () => {
            const name = accountName.trim();
            const opts = await api.twoFactorOptions(name);
            setOptions(opts);
            setPhoneId(opts.phoneNumbers[0]?.id);
            await api.requestDeviceCode(name);
            setDeviceSent(true);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    const sendDevice = () =>
        void run(async () => {
            await api.requestDeviceCode(accountName.trim());
            setDeviceSent(true);
        });

    const sendPhone = () =>
        void run(async () => {
            if (phoneId == null) return;
            await api.requestPhoneCode(accountName.trim(), phoneId);
            setPhoneSent(true);
        });

    const submitCode = (e: React.FormEvent) => {
        e.preventDefault();
        void run(async () => {
            const name = accountName.trim();
            const result = method === 'device' ? await api.submitDeviceCode(name, code) : await api.verifyPhoneCode(name, phoneId!, code);
            if (result.state === 'authenticated') onAuthenticated(name);
            else setError('Still not authenticated — check the code and try again.');
        });
    };

    return (
        <div className="card narrow">
            <h2>{step === 'password' ? (lockAccount ? 'Sign in again' : 'Add an iCloud account') : 'Two-factor authentication'}</h2>
            <p className="sub">
                {step === 'password'
                    ? lockAccount
                        ? `This account's session expired — re-enter the password for ${accountName}.`
                        : 'Enter the Apple ID and password to back up.'
                    : accountName}
            </p>

            {error && <div className="error">{error}</div>}

            {step === 'password' && (
                <form onSubmit={submitPassword}>
                    <label htmlFor="appleid">Apple ID</label>
                    <input id="appleid" type="text" inputMode="email" value={accountName} autoFocus={!accountName && !lockAccount}
                        autoComplete="username" placeholder="you@icloud.com" readOnly={lockAccount}
                        onChange={e => setAccountName(e.target.value)} />
                    <label htmlFor="pw">Password</label>
                    <div className="password-field">
                        <input id="pw" type={showPassword ? 'text' : 'password'} value={password} autoFocus={!!accountName || lockAccount}
                            autoComplete="current-password" onChange={e => setPassword(e.target.value)} />
                        <button type="button" className="toggle-visibility" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                            aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
                            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                    </div>
                    <button className="primary" type="submit" disabled={busy || accountName.trim().length < 3 || password.length === 0}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                    {onCancel && (
                        <div className="row" style={{ marginTop: 12 }}>
                            <button type="button" onClick={onCancel}>
                                ← Cancel
                            </button>
                        </div>
                    )}
                </form>
            )}

            {step === 'mfa' && (
                <>
                    <div className="tabs">
                        <button className={method === 'device' ? 'active' : ''} onClick={() => setMethod('device')} type="button">
                            Trusted device
                        </button>
                        <button className={method === 'phone' ? 'active' : ''} onClick={() => setMethod('phone')} type="button"
                            disabled={!options?.phoneNumbers.length}>
                            SMS
                        </button>
                    </div>

                    {method === 'phone' && (
                        <>
                            <label htmlFor="phone">Phone number</label>
                            <select id="phone" value={phoneId ?? ''} onChange={e => setPhoneId(Number(e.target.value))}>
                                {options?.phoneNumbers.map(p => (
                                    <option key={p.id} value={p.id}>{p.number}</option>
                                ))}
                            </select>
                            <button type="button" onClick={sendPhone} disabled={busy || phoneId == null} style={{ marginBottom: 14 }}>
                                {phoneSent ? 'Resend SMS code' : 'Send SMS code'}
                            </button>
                        </>
                    )}

                    {method === 'device' && (
                        <>
                            <p className="sub">A 6-digit code was sent to your trusted Apple devices (iPhone, iPad, or Mac). Enter it below.</p>
                            <button type="button" onClick={sendDevice} disabled={busy} style={{ marginBottom: 14 }}>
                                {deviceSent ? 'Resend code to devices' : 'Send code to devices'}
                            </button>
                        </>
                    )}

                    <form onSubmit={submitCode}>
                        <label htmlFor="code">{method === 'device' ? 'Code from a trusted device' : 'Code from the SMS'}</label>
                        <input id="code" type="text" inputMode="numeric" value={code} autoFocus
                            onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
                        <button className="primary" type="submit" disabled={busy || code.length < 4 || (method === 'phone' && phoneId == null)}>
                            {busy ? 'Verifying…' : 'Verify'}
                        </button>
                    </form>
                    <div className="row" style={{ marginTop: 12 }}>
                        <button type="button" onClick={() => { setStep('password'); setCode(''); setPhoneSent(false); setDeviceSent(false); }}>
                            ← Start over
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

const iconProps = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
};

function EyeIcon() {
    return (
        <svg {...iconProps}>
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}

function EyeOffIcon() {
    return (
        <svg {...iconProps}>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
            <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
    );
}

function friendly(err: ApiError): string {
    switch (err.reason) {
        case 'authentication_failed':
            return 'Incorrect Apple ID password.';
        case 'invalid_security_code':
            return 'That code was rejected. Try again.';
        case 'mfa_required':
            return 'Two-factor authentication is required.';
        case 'pcs_consent_required':
            return 'iCloud needs additional consent (PCS) for this account.';
        default:
            return err.message;
    }
}
