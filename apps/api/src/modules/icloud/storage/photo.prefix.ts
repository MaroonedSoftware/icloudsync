/** The minimal account shape needed to derive a default archive prefix. */
export interface PrefixableAccount {
    /** Auto-generated UUID primary key — the ultimate fallback prefix. */
    id: string;
    /** Apple ID email (the iCloud login), e.g. `rdean79@yahoo.com`. */
    accountName: string;
}

/**
 * The top-level archive path prefix an account is backed up under when it has
 * not pinned a custom one. Derived from the account's Apple ID email by dropping
 * the domain (`rdean79@yahoo.com` → `rdean79`) and sanitizing to a single safe
 * path segment, so archives are browsable by who owns them rather than an opaque
 * UUID.
 *
 * Falls back to the account id when the email has no usable local part (e.g. it
 * sanitizes away), keeping the prefix always non-empty. Note the local part is
 * not unique across providers — `a@gmail.com` and `a@yahoo.com` both yield `a` —
 * so accounts that would collide should pin a distinct custom prefix.
 */
export function defaultArchivePrefix(account: PrefixableAccount): string {
    const local = account.accountName.split('@', 1)[0] ?? '';
    const safe = local.replace(/[/\\\x00]/g, '_').replace(/^\.+/, '').trim();
    return safe.length > 0 ? safe : account.id;
}
