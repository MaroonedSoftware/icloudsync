---
'@maroonedsoftware/icloudsync-api': patch
---

A photo sync now survives an API restart cleanly. On boot the server re-attaches to any sync that was still queued or running (pg-boss keeps the job, but the in-memory registry the API reads was previously wiped), so the dashboard again reports it as running and cancel can still reach it. The sync queue also gained a durability policy — a worker heartbeat so a killed process's job is reclaimed within about a minute instead of the previous 15, a longer absolute run cap so a large or rate-limited sync isn't aborted mid-pass, and a higher retry budget so repeated restarts don't strand the job.
