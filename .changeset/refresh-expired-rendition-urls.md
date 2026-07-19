---
'@maroonedsoftware/icloudsync-api': patch
---

Heal expired CloudKit signed URLs on the fly instead of failing with a 502. A rendition's stored `downloadURL` is signed and expires within hours of a sync, so a thumbnail, preview, or non-archived original that wasn't already cached would fail with `502 icloud_upstream_error` (upstream 410) once its URL lapsed. The download proxy now detects a stale-URL rejection (401/403/410), re-looks-up the record from CloudKit for fresh URLs (new `PhotosService.lookup` / `records/lookup`), persists the refreshed renditions, and retries the download once — then caches the result. A genuine failure (asset deleted upstream, session lapsed) still surfaces as a 502.
