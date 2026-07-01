/** Default sync schedule: every 6 hours. Kept in a dependency-free leaf module
 * so both the sync wiring and the settings service can use it without a cycle. */
export const DEFAULT_SYNC_CRON = '0 */6 * * *';
