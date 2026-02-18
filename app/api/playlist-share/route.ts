import { json } from '../_shared/khinsider';
import {
    generateShareId,
    normalizeSharedPlaylistEncryptedPayload,
    SHARED_PLAY_ID_REGEX,
} from '../../../lib/playlist-share';
import {
    readPlaylistShareLinkRecord,
    writeEncryptedPlaylistShareRecord,
} from '../../../lib/server/playlist-share-store';

export const runtime = 'nodejs';

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 20;
const WRITE_WINDOW_MS = 60 * 1000;
const WRITE_MAX_REQUESTS = 120;
const rateBuckets = new Map<string, number[]>();
const writeTimestamps: number[] = [];

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

const getClientIp = (request: Request) => {
    const xForwardedFor = String(request.headers.get('x-forwarded-for') || '').trim();
    if (xForwardedFor) {
        return xForwardedFor.split(',')[0].trim() || 'unknown';
    }
    const realIp = String(request.headers.get('x-real-ip') || '').trim();
    if (realIp) return realIp;
    return 'unknown';
};

const checkRateLimit = (ip: string) => {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    const history = (rateBuckets.get(ip) || []).filter((timestamp) => timestamp > windowStart);
    if (history.length >= RATE_MAX_REQUESTS) {
        rateBuckets.set(ip, history);
        return false;
    }
    history.push(now);
    rateBuckets.set(ip, history);

    if (rateBuckets.size > 5000) {
        for (const [key, timestamps] of rateBuckets.entries()) {
            const trimmed = timestamps.filter((timestamp) => timestamp > windowStart);
            if (trimmed.length === 0) rateBuckets.delete(key);
            else rateBuckets.set(key, trimmed);
        }
    }
    return true;
};

const checkGlobalWriteRateLimit = () => {
    const now = Date.now();
    const windowStart = now - WRITE_WINDOW_MS;
    while (writeTimestamps.length > 0 && writeTimestamps[0] <= windowStart) {
        writeTimestamps.shift();
    }
    if (writeTimestamps.length >= WRITE_MAX_REQUESTS) {
        return false;
    }
    writeTimestamps.push(now);
    return true;
};

const getPublicOrigin = (request: Request) => {
    const forwardedHost = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').trim();
    const forwardedProto = (request.headers.get('x-forwarded-proto') || '').trim().split(',')[0].trim() || 'https';
    if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
    return new URL(request.url).origin;
};

const buildShareUrl = (request: Request, shareId: string) => {
    return `${getPublicOrigin(request)}/playlists/shared/${encodeURIComponent(shareId)}`;
};

const isShareCollisionError = (error: unknown) => {
    const code = String((error as any)?.code || '').trim();
    if (code === 'EEXIST') return true;
    return String((error as any)?.message || '').toLowerCase().includes('already exists');
};

const HASH_64_REGEX = /^[a-f0-9]{64}$/;

const normalizeContentHash = (rawValue: unknown) => {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (!HASH_64_REGEX.test(normalized)) return '';
    return normalized;
};

export async function POST(request: Request) {
    const ip = getClientIp(request);
    if (!checkRateLimit(ip)) {
        return jsonNoStore({ error: 'Too many share requests. Please try again later.' }, 429);
    }

    let payload: any = null;
    try {
        payload = await request.json();
    } catch {
        return jsonNoStore({ error: 'Invalid JSON body.' }, 400);
    }

    try {
        const reuseShareIdRaw = String(payload?.reuseShareId || '').trim();
        const reuseShareId = SHARED_PLAY_ID_REGEX.test(reuseShareIdRaw) ? reuseShareIdRaw : '';

        const providedContentHash = normalizeContentHash(payload?.contentHash);
        if (reuseShareId && providedContentHash) {
            const existingLink = await readPlaylistShareLinkRecord(reuseShareId);
            if (existingLink && !existingLink.revoked && existingLink.encrypted && existingLink.contentHash === providedContentHash) {
                const url = buildShareUrl(request, reuseShareId);
                return jsonNoStore({ mode: 'server', shareId: reuseShareId, url, reused: true, contentHash: providedContentHash }, 200);
            }
        }

        const encryptedPayload = normalizeSharedPlaylistEncryptedPayload(payload?.encrypted);
        if (!encryptedPayload) {
            return jsonNoStore({ error: 'Encrypted share payload is required.' }, 400);
        }

        const contentHash = providedContentHash;
        if (!contentHash) {
            return jsonNoStore({ error: 'A valid contentHash is required.' }, 400);
        }

        if (!checkGlobalWriteRateLimit()) {
            return jsonNoStore({ error: 'Share writes are rate-limited. Please retry shortly.' }, 429);
        }

        const enableRevocation = true;
        let shareId = '';
        let recordCreated = false;
        let editToken = '';
        let createdContentHash = contentHash;

        for (let attempt = 0; attempt < 5; attempt += 1) {
            shareId = generateShareId();
            try {
                const writeResult = await writeEncryptedPlaylistShareRecord({
                    shareId,
                    contentHash,
                    encrypted: encryptedPayload,
                }, { enableRevocation });
                editToken = String(writeResult.editToken || '').trim();
                createdContentHash = writeResult.contentHash || createdContentHash;
                recordCreated = true;
                break;
            } catch (error: any) {
                if (isShareCollisionError(error)) {
                    continue;
                }
                throw error;
            }
        }

        if (!recordCreated || !shareId) {
            return jsonNoStore({ error: 'Failed to reserve a share id.' }, 500);
        }

        const url = buildShareUrl(request, shareId);
        return jsonNoStore({
            mode: 'server',
            shareId,
            url,
            reused: false,
            contentHash: createdContentHash,
            ...(editToken ? { editToken } : {}),
        }, 201);
    } catch (error) {
        console.error('POST /api/playlist-share failed', error);
        return jsonNoStore({ error: 'Failed to create share link.' }, 500);
    }
}
