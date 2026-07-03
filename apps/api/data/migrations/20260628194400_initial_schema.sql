-- migrate:up

-- Registry of the iCloud accounts this instance backs up. Each account has an
-- auto-generated UUID primary key (its stable internal identity, used in URLs,
-- foreign keys, and storage prefixes); the Apple ID email is a unique attribute,
-- not the identity. The encrypted session blob lives on the row itself (promoted
-- out of a generic blob store), so an account's identity, credentials, and
-- storage config all sit in one place.
create table icloud_accounts (
    id                 uuid        not null default gen_random_uuid() primary key,
    account_name       text        not null unique,          -- Apple ID email (the iCloud login)
    added_at           timestamptz not null default now(),
    session            bytea,                                 -- encrypted AuthSession blob; null until first login
    session_updated_at timestamptz,                           -- when `session` was last written
    archive_prefix     text,                                  -- custom photo-archive path prefix; null → use id
    photos_layout      text,                                  -- custom photo-archive layout; null → use id
    photos_naming      text,                                  -- custom photo-archive naming; null → use id
    relocation_error   text,                                  -- last archive-relocation failure summary; null → last move ok or none
    relocation_from    text                                   -- prefix a failed move should resume from; null → nothing to resume
);

create table icloud_photos (
    account_id          uuid        not null references icloud_accounts (id) on delete cascade,
    record_name         text        not null,
    master_record_name  text,
    filename            text,
    asset_date          bigint,
    added_date          bigint,
    is_favorite         boolean     not null default false,
    is_hidden           boolean     not null default false,
    is_deleted          boolean     not null default false,
    resources           jsonb       not null default '{}'::jsonb,
    synced_at           timestamptz not null default now(),
    backup_key          text,
    backup_size         bigint,
    backup_checksum     text,
    backed_up_at        timestamptz,
    primary key (account_id, record_name)
);

create index icloud_photos_account_asset_date_idx
    on icloud_photos (account_id, asset_date desc);

-- Speeds up "is this backed up?" lookups and backed-up counts/sums.
create index icloud_photos_account_backed_up_idx
    on icloud_photos (account_id, backed_up_at);

-- Global runtime settings plus the Argon2id salt for the session-encryption key
-- (key `icloud_encryption_salt`, hex-encoded, not secret — kept here so the
-- key can be reproduced across restarts without a session filesystem).
create table app_settings (
    key        text        not null primary key,
    value      jsonb       not null,
    updated_at timestamptz not null default now()
);

-- migrate:down

drop table app_settings;

drop index icloud_photos_account_backed_up_idx;
drop index icloud_photos_account_asset_date_idx;

drop table icloud_photos;

drop table icloud_accounts;
