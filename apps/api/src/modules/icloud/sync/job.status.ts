import type { JobBroker } from '@maroonedsoftware/jobbroker';

/** pg-boss states that mean a job is still queued or executing. */
export const IN_FLIGHT_STATES = new Set(['created', 'active', 'retry']);

/**
 * The `jobId` if that job is still queued or running on `queue`, else
 * `undefined`. Consulting the broker (rather than trusting a registry alone)
 * means a stale tracked id for a job that has since finished correctly reads as
 * "not running".
 */
export async function inFlightJobId(broker: JobBroker, queue: string, jobId: string | undefined): Promise<string | undefined> {
    if (!jobId) return undefined;
    const info = await broker.getJob(queue, jobId);
    return info && IN_FLIGHT_STATES.has(info.state) ? jobId : undefined;
}
