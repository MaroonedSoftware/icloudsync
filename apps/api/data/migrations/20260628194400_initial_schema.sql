-- migrate:up

-- Registry of the iCloud accounts this instance backs up. Each account's photos
-- (icloud_photos) and encrypted session (storage_objects) are keyed by account,
-- so this table just tracks which accounts are known: the sync job loops it to
-- back up every account, and the UI lists/switches between them.
create table icloud_accounts (
    account_name text        not null primary key,
    added_at     timestamptz not null default now()
);

create table icloud_photos (
    account_name        text        not null,
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
    primary key (account_name, record_name)
);

create index icloud_photos_account_asset_date_idx
    on icloud_photos (account_name, asset_date desc);

-- Speeds up "is this backed up?" lookups and backed-up counts/sums.
create index icloud_photos_account_backed_up_idx
    on icloud_photos (account_name, backed_up_at);

create table app_settings (
    key        text        not null primary key,
    value      jsonb       not null,
    updated_at timestamptz not null default now()
);

-- Generic key/bytes object store, used by PostgresStorageProvider to keep the
-- encrypted iCloud session (and its salt) in the database instead of on disk.
create table storage_objects (
    key          text        not null primary key,
    content      bytea       not null,
    content_type text,
    updated_at   timestamptz not null default now()
);

-- migrate:down
drop table storage_objects;

drop table app_settings;

drop index icloud_photos_account_backed_up_idx;
drop index icloud_photos_account_asset_date_idx;

drop table icloud_photos;

drop table icloud_accounts;
