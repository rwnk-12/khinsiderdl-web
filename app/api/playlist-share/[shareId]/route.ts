import { json } from '../../_shared/khinsider';
import { readPlaylistShareRecord } from '../../../../lib/server/playlist-share-store';

export const runtime = 'nodejs';

const SHARED_ROBOTS_HEADER = 'noindex, nofollow';
const SHARED_CACHE_CONTROL = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800, immutable';
const ERROR_HEADERS: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': SHARED_ROBOTS_HEADER,
};

const jsonNoStore = (body: any, status = 200) => {
    return json(body, {
        status,
        headers: ERROR_HEADERS,
    });
};

const toSharedHeaders = (etag?: string): Record<string, string> => {
    return {
        'Cache-Control': SHARED_CACHE_CONTROL,
        'X-Robots-Tag': SHARED_ROBOTS_HEADER,
        ...(etag ? { ETag: etag } : {}),
    };
};

const toWeakEtag = (shareId: string, createdAt: string) => {
    const token = Buffer.from(`${shareId}:${createdAt}`, 'utf8').toString('base64url');
    return `W/"${token}"`;
};

const hasMatchingEtag = (ifNoneMatchHeader: string, etag: string) => {
    const raw = String(ifNoneMatchHeader || '').trim();
    if (!raw) return false;
    if (raw === '*') return true;
    return raw.split(',').some((part) => part.trim() === etag);
};

export async function GET(
    request: Request,
    context: { params: Promise<{ shareId: string }> | { shareId: string } }
) {
    const params = await Promise.resolve(context.params);
    const shareId = String(params?.shareId || '').trim();
    if (!shareId) {
        return jsonNoStore({ error: 'Missing share id.' }, 400);
    }

    try {
        const record = await readPlaylistShareRecord(shareId);
        if (!record) {
            return jsonNoStore({ error: 'Shared playlist not found.' }, 404);
        }

        const etag = toWeakEtag(record.shareId, record.createdAt);
        if (hasMatchingEtag(request.headers.get('if-none-match') || '', etag)) {
            return new Response(null, {
                status: 304,
                headers: toSharedHeaders(etag),
            });
        }

        return json(record, {
            status: 200,
            headers: toSharedHeaders(etag),
        });
    } catch (error) {
        console.error('GET /api/playlist-share/[shareId] failed', error);
        return jsonNoStore({ error: 'Failed to load shared playlist.' }, 500);
    }
}
