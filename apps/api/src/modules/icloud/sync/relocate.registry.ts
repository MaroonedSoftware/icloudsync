import { SyncRegistry } from './sync.registry.js';

/**
 * In-memory account → last archive-relocation job id, mirroring
 * {@link SyncRegistry} but for {@link RelocateArchiveJob} runs. A distinct type
 * (hence a distinct DI token) so relocation ids are tracked separately from sync
 * ids; the settings view consults it to report whether a prefix change's file
 * move is still in flight.
 */
export class RelocateRegistry extends SyncRegistry {}
