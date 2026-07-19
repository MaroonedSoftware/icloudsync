---
'@maroonedsoftware/icloudsync-api': patch
---

Warm the thumbnail cache for the newest assets after every sync, so the recent-backups grid loads from disk even when no new items were added. Previously a thumbnail was only cached lazily on first view, so between syncs an expired signed URL could still surface a broken tile until someone opened it. Each completed sync now refreshes every asset's signed URLs and then proactively fetches and caches the grid thumbnail for the newest assets (skipping ones already cached, stopping early on an iCloud rate limit). Warming is best-effort and a no-op when thumbnails are disabled.
