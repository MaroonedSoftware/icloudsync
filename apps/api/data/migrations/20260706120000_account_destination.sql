-- migrate:up

-- The backup destination is now chosen per account rather than globally: one
-- account can archive to the filesystem while another uploads to Immich. Two
-- nullable columns carry that choice; null means "inherit the built-in default"
-- (filesystem, with the `immich` preset), matching the layout/naming columns.
alter table icloud_accounts
    add column photos_destination text,  -- 'filesystem' | 'immich'; null → default 'filesystem'
    add column photos_preset      text;  -- 'immich' | 'browsable'; null → default 'immich' (filesystem only)

-- The global backup-destination row is retired: the filesystem preset moved onto
-- each account (photos_preset above), and the Immich connection moved to its own
-- `immich` settings row. Drop any stale value so it can't shadow the new config.
delete from app_settings where key = 'photos_destination';

-- migrate:down

alter table icloud_accounts
    drop column photos_destination,
    drop column photos_preset;
