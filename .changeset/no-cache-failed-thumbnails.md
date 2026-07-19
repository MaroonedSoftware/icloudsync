---
'@maroonedsoftware/icloudsync-api': patch
---

Stop caching failed rendition downloads. The download proxy set `Cache-Control: private, max-age=86400` before it knew the request would succeed, and the error middleware doesn't strip headers set before a throw — so a transient failure (an expired-URL 502, a missing-rendition 404) went out with a day-long cache lifetime and the browser replayed it as a broken tile long after the bytes were actually available. Failures now respond `Cache-Control: no-store`; only a successfully served rendition is marked cacheable.
