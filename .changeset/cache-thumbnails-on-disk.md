---
'@maroonedsoftware/icloudsync-api': patch
---

Fix the "Recent backups" grid rendering broken images. Thumbnails were served by re-fetching each rendition's CloudKit `downloadURL`, a signed URL that expires within hours of a sync, so every tile broke once its signature lapsed. Derived renditions (thumbnails/previews) are now served inline and cached on disk via a new read-through `ThumbnailCache`, so a rendition stays servable after its signed URL expires; the first successful fetch populates the cache, keyed by record + resolution + content checksum. Originals are unchanged (still an attachment served from the durable archive when available).

The cache is bounded: its on-disk footprint is capped and the oldest entries are evicted once a write pushes it over, giving a rolling window of the most-recently-cached thumbnails so storage doesn't grow without limit. Eviction measurement is throttled off the request hot path, and the cache lives in its own directory under the photos root so trimming never touches the durable archive.

The cap is configurable via a new `THUMBNAIL_CACHE_MAX_MB` environment variable (default 10 MiB), surfaced in `docker-compose.yml` and the Unraid template. Setting it to `0` disables thumbnails entirely: the download proxy stops serving derived renditions (returns 404 `thumbnails_disabled` without any iCloud fetch), the `/stats` response reports `thumbnails: false`, and the web UI hides the recent-backups grid.

Clicking a recent-backups thumbnail now opens the largest viewable JPEG rendition inline (served from the on-disk cache) instead of downloading the original — so a click shows the photo in a new tab without a HEIC download or an iCloud round-trip.
