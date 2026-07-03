/**
 * XMP sidecar generation for the `immich` filesystem preset. When photos are
 * served by an Immich *external library* (Immich scans a read-only mount in
 * place), Immich derives the timeline, GPS, rating and tags from each file's
 * metadata — it does *not* infer anything from the folder tree. So an archive
 * laid out flat with original filenames loses two things iCloud knows but the
 * file's own EXIF may not: which album(s) the photo is in, and that it's a
 * favorite. A sidecar carries them across.
 *
 * We write a standards-compliant XMP packet next to each asset as `<file>.xmp`
 * (the filename Immich looks for). It carries:
 * - `xmp:Rating` = 5 for favorites (Immich maps a 5-star rating to a favorite),
 * - `dc:subject` / `lr:hierarchicalSubject` = album name(s) as keywords/tags
 *   (Immich surfaces these as tags, giving album fidelity a flat folder can't),
 * - `exif:DateTimeOriginal` / `photoshop:DateCreated` = the capture date, as a
 *   fallback for assets whose embedded EXIF date is missing.
 *
 * Generation is pure (no I/O) so it is trivially unit-testable; the sink writes
 * the returned string to `<key>.xmp`.
 */

/** Byte-order mark that opens an XMP packet (per the XMP spec's `<?xpacket?>` header). */
const XMP_BOM = '\uFEFF';

/** The subset of an asset a sidecar describes. */
export interface SidecarAsset {
    /** Original filename (for the packet's `About`/document id hint only). */
    filename?: string;
    /** Capture date in epoch milliseconds, when known. */
    assetDate?: number;
    /** Whether the asset is a favorite in iCloud. */
    isFavorite: boolean;
    /** Album name(s) the asset belongs to (written as keywords/tags). */
    albums: string[];
}

/** Escape a value for inclusion as XML text/attribute content. */
function xmlEscape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Format a capture date as an XMP/ISO-8601 timestamp (UTC), or `undefined` when unknown/invalid. */
function xmpDate(assetDate: number | undefined): string | undefined {
    if (assetDate == null) return undefined;
    const date = new Date(assetDate);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Render a `dc:subject` / `hierarchicalSubject` rdf:Bag of the given keywords. */
function keywordBag(tag: string, keywords: string[]): string {
    const items = keywords.map(k => `                <rdf:li>${xmlEscape(k)}</rdf:li>`).join('\n');
    return `            <${tag}>\n                <rdf:Bag>\n${items}\n                </rdf:Bag>\n            </${tag}>`;
}

/**
 * Build the XMP sidecar document for an asset, or `undefined` when there is
 * nothing to carry — an ordinary photo (not a favorite, in no album) gets no
 * sidecar, so a flat archive stays clean rather than littered with packets that
 * only duplicate what Immich already reads from EXIF. The capture date is written
 * only as enrichment *inside* a sidecar we're already emitting (a fallback for
 * assets with missing EXIF); it never triggers one on its own. Album names are
 * de-duplicated and blank entries dropped.
 */
export function buildSidecar(asset: SidecarAsset): string | undefined {
    const albums = [...new Set(asset.albums.map(a => a.trim()).filter(Boolean))];
    const rating = asset.isFavorite ? 5 : undefined;

    // Only a favorite or album membership is worth a sidecar; the date rides along when present.
    if (albums.length === 0 && rating === undefined) return undefined;
    const date = xmpDate(asset.assetDate);

    const props: string[] = [];
    if (rating !== undefined) props.push(`            <xmp:Rating>${rating}</xmp:Rating>`);
    if (date !== undefined) {
        props.push(`            <exif:DateTimeOriginal>${date}</exif:DateTimeOriginal>`);
        props.push(`            <photoshop:DateCreated>${date}</photoshop:DateCreated>`);
    }
    if (albums.length > 0) {
        props.push(keywordBag('dc:subject', albums));
        props.push(keywordBag('lr:hierarchicalSubject', albums));
    }

    return `<?xpacket begin="${XMP_BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about=""
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:exif="http://ns.adobe.com/exif/1.0/"
            xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
            xmlns:lr="http://ns.adobe.com/lightroom/1.0/">
${props.join('\n')}
        </rdf:Description>
    </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/** The sidecar storage key for an archived asset: the asset key plus `.xmp`. */
export function sidecarKey(assetKey: string): string {
    return `${assetKey}.xmp`;
}
