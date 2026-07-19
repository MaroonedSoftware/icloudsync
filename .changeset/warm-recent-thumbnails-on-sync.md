---
'@maroonedsoftware/icloudsync-api': patch
---

Warm the thumbnail cache for the newest assets after every sync, so the recent-backups grid loads from disk even when no new items were added. Previously a thumbnail was only cached lazily on first view, so between syncs an expired signed URL could still surface a broken tile until someone opened it. Each completed sync now refreshes every asset's signed URLs and then proactively fetches and caches the grid thumbnail for the newest assets (skipping ones already cached, stopping early on an iCloud rate limit). Warming is best-effort and a no-op when thumbnails are disabled.

Warming also heals a signed URL that expired mid-sweep: a large library's sweep can outlive the URLs it fetched early, so if a thumbnail download is rejected as stale (401/403/410) the asset is re-looked-up for fresh URLs, the refreshed renditions are persisted, and the download is retried once — the same self-healing the download proxy already does on demand.
