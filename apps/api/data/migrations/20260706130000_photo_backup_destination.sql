-- migrate:up

-- Record which destination each asset's bytes were actually backed up to, so the
-- sync job's "already backed up, skip it" guard is destination-aware. Without this,
-- switching an account from the filesystem archive to Immich (or back) leaves every
-- asset's checksum matching its prior backup, so the guard short-circuits and
-- nothing is re-uploaded to the new destination.
alter table icloud_photos add column backup_destination text;  -- 'filesystem' | 'immich'; null → unknown (re-verify)

-- Backfill existing backups: before per-account destinations existed the only
-- backup target was the filesystem archive (Immich upload is new), so every row
-- already backed up went to the filesystem. This keeps unchanged filesystem
-- accounts from needlessly re-downloading their whole library on upgrade, while an
-- account that switches to Immich still re-uploads (its 'filesystem' tag won't match).
update icloud_photos set backup_destination = 'filesystem' where backed_up_at is not null;

-- migrate:down

alter table icloud_photos drop column backup_destination;
