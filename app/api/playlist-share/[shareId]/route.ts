import { json } from '../../_shared/khinsider';
import { readPlaylistShareRecord } from '../../../../lib/server/playlist-share-store';
import { encodeSharedPlaylistEncryptedEnvelope } from '../../../../lib/playlist-share';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHARED_ROBOTS_HEADER = 'noindex, nofollow';
const SHARED_CACHE_CONTROL = 'no-store';
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

const toSharedHeaders = (): Record<string, string> => {
    return {
        'Cache-Control': SHARED_CACHE_CONTROL,
        'X-Robots-Tag': SHARED_ROBOTS_HEADER,
    };
};

export async function GET(
    _request: Request,
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

        return json({
            version: 1,
            shareId: record.shareId,
            createdAt: record.createdAt,
            sealed: encodeSharedPlaylistEncryptedEnvelope(record.encrypted),
        }, {
            status: 200,
            headers: toSharedHeaders(),
        });
    } catch (error) {
        console.error('GET /api/playlist-share/[shareId] failed', error);
        return jsonNoStore({ error: 'Failed to load shared playlist.' }, 500);
    }
}
