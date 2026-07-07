import { ICloudError } from '../errors.js';
import type { HttpResponse } from '../http/client.js';

/**
 * iCloud Photos client over Apple's private CloudKit web API (`ckdatabasews`).
 *
 * Photos are stored as paired CloudKit records: a `CPLAsset` (metadata, flags,
 * dates, JPEG renditions) referencing a `CPLMaster` (original file + checksums).
 * A single `CPLAssetAndMaster…` query returns both; this service pairs them and
 * exposes a flat {@link PhotoAsset}. Endpoints/record types mirror
 * `foxt/icloud.js` and `picklepete/pyicloud`.
 */

const CONTAINER = 'com.apple.photos.cloud';
const DATABASE_PATH = `/database/1/${CONTAINER}/production/private`;
const DEFAULT_ZONE = 'PrimarySync';
/** Index used to *list* assets (returns paired CPLAsset + CPLMaster records). */
const DEFAULT_INDEX = 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted';
/** Index used to *count* assets (asset-only `obj_type`, no `AndMaster`). */
const DEFAULT_COUNT_INDEX = 'CPLAssetByAssetDateWithoutHiddenOrDeleted';
/**
 * How many times {@link PhotosService.list} re-queries the *same* rank after an
 * empty page that still advertises more via `continuationMarker`, before treating
 * the library as exhausted. Guards against a transient empty window under load
 * silently truncating a sync, while the cap keeps a lingering marker from looping
 * forever past the true end.
 */
const MAX_EMPTY_PAGE_RETRIES = 3;

/** The minimal authenticated-client surface the Photos service needs. */
export interface ICloudRequester {
    serviceUrl(name: string): string | undefined;
    request<T = unknown>(serviceUrl: string, pathname: string, init?: RequestInit & { json?: unknown }): Promise<HttpResponse<T>>;
    download(url: string): Promise<Uint8Array>;
}

/** A downloadable rendition of an asset (original, full-res JPEG, thumbnail, …). */
export interface PhotoResource {
    /** The CloudKit field key, e.g. `resOriginalRes`, `resJPEGFullRes`. */
    key: string;
    downloadURL: string;
    size?: number;
    fileChecksum?: string;
    width?: number;
    height?: number;
    fileType?: string;
}

/** A flattened photo/video asset paired from its `CPLAsset` + `CPLMaster` records. */
export interface PhotoAsset {
    recordName: string;
    recordChangeTag?: string;
    masterRecordName?: string;
    /** Decoded original filename. */
    filename?: string;
    /** Capture date (epoch milliseconds). */
    assetDate?: number;
    /** Date added to the library (epoch milliseconds). */
    addedDate?: number;
    isFavorite: boolean;
    isHidden: boolean;
    isDeleted: boolean;
    /** Renditions keyed by CloudKit field name (e.g. `resOriginalRes`). */
    resources: Record<string, PhotoResource>;
}

/** A user-created album / folder. */
export interface PhotoAlbum {
    recordName: string;
    recordChangeTag?: string;
    name?: string;
}

export type SortDirection = 'ASCENDING' | 'DESCENDING';

/** Smart-album filter values for {@link ListOptions.smartAlbum}. */
export type SmartAlbum =
    'TIMELAPSE' | 'VIDEO' | 'SLOMO' | 'FAVORITE' | 'PANORAMA' | 'SCREENSHOT' | 'BURSTS' | 'LIVE' | 'PORTRAIT' | 'LONG_EXPOSURE' | 'ANIMATED';

export interface ListOptions {
    /** Index record type to page through. Defaults to all non-hidden, non-deleted. */
    recordType?: string;
    direction?: SortDirection;
    /** Assets per page (CloudKit `resultsLimit` is sent as `pageSize * 2`). */
    pageSize?: number;
    /** Starting rank offset. */
    startRank?: number;
    /** Restrict to a smart album (implies a `…InSmartAlbum…` record type). */
    smartAlbum?: SmartAlbum;
    /** Restrict to a user album's contents by its `recordName` (implies a container-relation record type). */
    albumId?: string;
}

interface CloudKitFieldValue {
    value?: unknown;
    type?: string;
}

interface CloudKitRecord {
    recordName: string;
    recordType: string;
    recordChangeTag?: string;
    fields?: Record<string, CloudKitFieldValue>;
}

const numberField = (fields: Record<string, CloudKitFieldValue> | undefined, key: string): number | undefined => {
    const v = fields?.[key]?.value;
    return typeof v === 'number' ? v : undefined;
};

const stringField = (fields: Record<string, CloudKitFieldValue> | undefined, key: string): string | undefined => {
    const v = fields?.[key]?.value;
    return typeof v === 'string' ? v : undefined;
};

const decodeBase64 = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf-8');

/** Collect every field whose value looks like a downloadable CloudKit resource. */
function extractResources(fields: Record<string, CloudKitFieldValue> | undefined): Record<string, PhotoResource> {
    const resources: Record<string, PhotoResource> = {};
    if (!fields) return resources;
    for (const [key, field] of Object.entries(fields)) {
        const value = field?.value;
        if (!value || typeof value !== 'object') continue;
        const candidate = value as { downloadURL?: unknown; size?: unknown; fileChecksum?: unknown };
        if (typeof candidate.downloadURL !== 'string') continue;
        const base = key.replace(/Res$/, '');
        resources[key] = {
            key,
            downloadURL: candidate.downloadURL,
            size: typeof candidate.size === 'number' ? candidate.size : undefined,
            fileChecksum: typeof candidate.fileChecksum === 'string' ? candidate.fileChecksum : undefined,
            width: numberField(fields, `${base}Width`),
            height: numberField(fields, `${base}Height`),
            fileType: stringField(fields, `${base}FileType`),
        };
    }
    return resources;
}

function buildPhotoAsset(master: CloudKitRecord, asset: CloudKitRecord | undefined): PhotoAsset {
    const assetFields = asset?.fields;
    const filenameEnc = stringField(assetFields, 'filenameEnc') ?? stringField(master.fields, 'filenameEnc');
    return {
        recordName: asset?.recordName ?? master.recordName,
        recordChangeTag: asset?.recordChangeTag ?? master.recordChangeTag,
        masterRecordName: master.recordName,
        filename: decodeBase64(filenameEnc),
        assetDate: numberField(assetFields, 'assetDate'),
        addedDate: numberField(assetFields, 'addedDate'),
        isFavorite: numberField(assetFields, 'isFavorite') === 1,
        isHidden: numberField(assetFields, 'isHidden') === 1,
        isDeleted: numberField(assetFields, 'isDeleted') === 1,
        // Master holds the original rendition; asset holds JPEG/derived renditions.
        resources: { ...extractResources(master.fields), ...extractResources(assetFields) },
    };
}

export class PhotosService {
    constructor(
        private readonly client: ICloudRequester,
        private readonly zoneName: string = DEFAULT_ZONE,
    ) {}

    private baseUrl(): string {
        const url = this.client.serviceUrl('ckdatabasews');
        if (!url) throw new ICloudError('Photos unavailable: not authenticated, or ckdatabasews missing from webservices');
        return url;
    }

    private async query<T>(operation: string, body: unknown): Promise<T> {
        const path = `${DATABASE_PATH}/${operation}?remapEnums=true&getCurrentSyncToken=true`;
        const res = await this.client.request<T>(this.baseUrl(), path, { method: 'POST', json: body });
        if (res.status !== 200 || res.data === undefined) {
            throw new ICloudError(`Photos query "${operation}" failed (${res.status})`, res.status, res.text);
        }
        return res.data;
    }

    /** List the user-created albums / folders. */
    async getAlbums(): Promise<PhotoAlbum[]> {
        const data = await this.query<{ records?: CloudKitRecord[] }>('records/query', {
            query: { recordType: 'CPLAlbumByPositionLive' },
            zoneID: { zoneName: this.zoneName },
        });
        return (data.records ?? []).map(record => ({
            recordName: record.recordName,
            recordChangeTag: record.recordChangeTag,
            name: decodeBase64(stringField(record.fields, 'albumNameEnc')),
        }));
    }

    /** Total asset count for an index (defaults to the main photo stream). */
    async getCount(indexId: string = DEFAULT_COUNT_INDEX): Promise<number> {
        const data = await this.query<{ batch?: Array<{ records?: CloudKitRecord[] }> }>('internal/records/query/batch', {
            batch: [
                {
                    resultsLimit: 1,
                    query: {
                        recordType: 'HyperionIndexCountLookup',
                        filterBy: [{ fieldName: 'indexCountID', comparator: 'IN', fieldValue: { type: 'STRING_LIST', value: [indexId] } }],
                    },
                    zoneWide: true,
                    zoneID: { zoneName: this.zoneName },
                },
            ],
        });
        const count = numberField(data.batch?.[0]?.records?.[0]?.fields, 'itemCount');
        if (count === undefined) throw new ICloudError('Could not read photo count from CloudKit response');
        return count;
    }

    /**
     * Lazily page through the library, yielding one {@link PhotoAsset} per master
     * record. Advances `startRank` by the number of masters per page. Stops when a
     * page comes back empty *and* CloudKit no longer advertises more results via
     * `continuationMarker`; an empty page that still carries a marker is treated as
     * a transient blip and the same rank is retried (bounded by
     * {@link MAX_EMPTY_PAGE_RETRIES}) rather than ending the walk early.
     */
    async *list(options: ListOptions = {}): AsyncGenerator<PhotoAsset> {
        const direction = options.direction ?? 'ASCENDING';
        const pageSize = options.pageSize ?? 100;
        const recordType =
            options.recordType ??
            (options.albumId
                ? 'CPLContainerRelationLiveByAssetDate'
                : options.smartAlbum
                  ? 'CPLAssetAndMasterInSmartAlbumByAssetDate'
                  : DEFAULT_INDEX);
        let offset = options.startRank ?? 0;
        let emptyRetries = 0;

        for (;;) {
            const filterBy: Array<Record<string, unknown>> = [
                { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { type: 'INT64', value: offset } },
                { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: direction } },
            ];
            if (options.smartAlbum) {
                filterBy.push({ fieldName: 'smartAlbum', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: options.smartAlbum } });
            }
            if (options.albumId) {
                filterBy.push({ fieldName: 'parentId', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: options.albumId } });
            }

            // NOTE: no `desiredKeys` — restricting fields makes CloudKit return only
            // CPLAsset records (no CPLMaster), which breaks the master/asset pairing.
            // Request all fields so both record types come back.
            const data = await this.query<{ records?: CloudKitRecord[]; continuationMarker?: unknown }>('records/query', {
                query: { recordType, filterBy },
                resultsLimit: pageSize * 2,
                zoneID: { zoneName: this.zoneName },
            });

            const records = data.records ?? [];
            const masters = records.filter(r => r.recordType === 'CPLMaster');
            if (masters.length === 0) {
                // A genuinely exhausted index returns no records and no
                // `continuationMarker`. Under load CloudKit can instead hand back a
                // transient empty window mid-library while still advertising more via
                // the marker; retry the *same* rank a bounded number of times before
                // concluding the library is done, so a blip doesn't silently truncate
                // the sync. Re-querying the same offset never skips ranks, and the cap
                // stops a marker that lingers past the true end from looping forever.
                if (data.continuationMarker === undefined || emptyRetries >= MAX_EMPTY_PAGE_RETRIES) break;
                emptyRetries += 1;
                continue;
            }
            emptyRetries = 0;

            const assetsByMaster = new Map<string, CloudKitRecord>();
            for (const record of records) {
                if (record.recordType !== 'CPLAsset') continue;
                const ref = (record.fields?.masterRef?.value as { recordName?: string } | undefined)?.recordName;
                if (ref) assetsByMaster.set(ref, record);
            }

            for (const master of masters) {
                yield buildPhotoAsset(master, assetsByMaster.get(master.recordName));
            }

            offset += direction === 'DESCENDING' ? -masters.length : masters.length;
            if (offset < 0) break;
        }
    }

    /** Eagerly collect every asset from {@link list}. */
    async listAll(options: ListOptions = {}): Promise<PhotoAsset[]> {
        const assets: PhotoAsset[] = [];
        for await (const asset of this.list(options)) assets.push(asset);
        return assets;
    }

    /** The download URL for a given rendition (defaults to the original). */
    resolveDownloadUrl(asset: PhotoAsset, resolution = 'resOriginalRes'): string | undefined {
        return asset.resources[resolution]?.downloadURL;
    }

    /** Download a rendition's bytes (defaults to the original). */
    async download(asset: PhotoAsset, resolution = 'resOriginalRes'): Promise<Uint8Array> {
        const url = this.resolveDownloadUrl(asset, resolution);
        if (!url) throw new ICloudError(`Asset ${asset.recordName} has no "${resolution}" rendition`);
        return this.client.download(url);
    }
}
