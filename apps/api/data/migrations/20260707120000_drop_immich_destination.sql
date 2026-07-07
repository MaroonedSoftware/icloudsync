-- migrate:up

-- The Immich "upload via API" destination has been removed: the filesystem
-- archive is now the only backup destination, so the per-account destination
-- choice and the destination-aware backup tag collapse. Drop both columns and the
-- global Immich-connection settings row. Accounts previously routed to Immich fall
-- back to the filesystem archive on their next sync (their photos re-archive since
-- the old backup tag is gone). The filesystem `immich` *preset* (photos_preset)
-- is a separate feature and stays.
alter table icloud_accounts drop column photos_destination;
alter table icloud_photos drop column backup_destination;
delete from app_settings where key = 'immich';

-- migrate:down

alter table icloud_accounts add column photos_destination text;  -- 'filesystem' | 'immich'; null → default 'filesystem'
alter table icloud_photos add column backup_destination text;    -- 'filesystem' | 'immich'; null → unknown (re-verify)
-- Re-tag existing backups as filesystem (the only destination that ever wrote them).
update icloud_photos set backup_destination = 'filesystem' where backed_up_at is not null;
