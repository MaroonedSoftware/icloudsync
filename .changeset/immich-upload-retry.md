---
'@maroonedsoftware/icloudsync-api': patch
---

Harden Immich uploads against server overload: the Immich client now retries transient failures (429/502/503/504 and network errors) with backoff, honoring the server's `Retry-After` header, and bounds every request with a timeout so a wedged Immich can't stall the sync. The settings "Test connection" check stays fail-fast (no retries, short timeout).
