---
'@maroonedsoftware/icloudsync-api': patch
---

Transient database connectivity blips no longer flood the logs. When Postgres briefly goes away — a restart (e.g. a nightly backup that stops the DB container), a few seconds of unreachability, or connect timeouts — pg-boss and the Kysely pool each emit background errors across several internal timers, which previously logged as dozens of near-identical ERROR stack traces per incident. These self-healing cases (`terminating connection due to administrator command`, `ECONNREFUSED`, `Connection terminated due to connection timeout`, `timeout exceeded when trying to connect`, and related SQLSTATEs) are now classified and logged as a single WARN line each; genuine errors still log at ERROR with full detail. The process already survived these blips — this only quiets the noise.

Both connection pools are also now pinned and identifiable: an explicit `max` documents the app's connection budget, and every connection carries an `application_name` (`icloudsync-kysely` / `icloudsync-pgboss`) so it can be told apart in `pg_stat_activity` when sizing the database.
