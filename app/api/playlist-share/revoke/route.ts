import { json } from '../../_shared/khinsider';
import { revokePlaylistShare } from '../../../../lib/server/playlist-share-store';

export const runtime = 'nodejs';

const RESPONSE_HEADERS: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
};

const jsonNoStore = (body: any, status = 200) => {
    return json(body, {
        status,
        headers: RESPONSE_HEADERS,
    });
};

export async function POST(request: Request) {
    let payload: any = null;
    try {
        payload = await request.json();
    } catch {
        return jsonNoStore({ error: 'Invalid JSON body.' }, 400);
    }

    const shareId = String(payload?.shareId || '').trim();
    const editToken = String(payload?.editToken || '').trim();
    if (!shareId || !editToken) {
        return jsonNoStore({ error: 'shareId and editToken are required.' }, 400);
    }

    try {
        const result = await revokePlaylistShare(shareId, editToken);
        if (result === 'ok') {
            return jsonNoStore({ ok: true }, 200);
        }
        if (result === 'already_revoked') {
            return jsonNoStore({ ok: true, alreadyRevoked: true }, 200);
        }
        if (result === 'not_found') {
            return jsonNoStore({ error: 'Shared playlist not found.' }, 404);
        }
        if (result === 'forbidden') {
            return jsonNoStore({ error: 'Invalid edit token for this share.' }, 403);
        }
        if (result === 'unsupported') {
            return jsonNoStore({ error: 'This shared link cannot be revoked.' }, 400);
        }
        return jsonNoStore({ error: 'Failed to revoke share link.' }, 500);
    } catch (error) {
        console.error('POST /api/playlist-share/revoke failed', error);
        return jsonNoStore({ error: 'Failed to revoke share link.' }, 500);
    }
}
