import type { PlaylistTrack } from './playlists';
import { normalizePlaylistTrack, sanitizePlaylistByline, sanitizePlaylistName } from './playlists';

export const MAX_SHARED_PLAYLIST_NAME_LENGTH = 60;
export const MAX_SHARED_PLAYLIST_TRACKS = 2000;
export const MAX_SHARED_PLAYLIST_JSON_BYTES = 1024 * 1024;
export const MAX_SHARED_HASH_URL_LENGTH = 7800;
export const SHARED_PLAYLIST_HASH_PREFIX = 'khs1.';
export const SHARED_PLAYLIST_SEALED_PREFIX = 'khe1.';
export const SHARED_PLAY_ID_REGEX = /^[A-Za-z0-9_-]{16,64}$/;
export const SHARED_PLAYLIST_ENCRYPTION_ALG = 'A256GCM' as const;

export type SharedPlaylistSnapshot = {
    name: string;
    byline?: string;
    tracks: PlaylistTrack[];
};

export type SharedPlaylistRecordV1 = {
    version: 1;
    shareId: string;
    createdAt: string;
    playlist: SharedPlaylistSnapshot;
};

export type SharedPlaylistEncryptedPayloadV1 = {
    version: 1;
    alg: typeof SHARED_PLAYLIST_ENCRYPTION_ALG;
    iv: string;
    ciphertext: string;
};

export type SharedPlaylistEncryptedRecordV1 = {
    version: 1;
    shareId: string;
    createdAt: string;
    encrypted: SharedPlaylistEncryptedPayloadV1;
};

export type SharedPlaylistNormalizeResult =
    | {
        ok: true;
        playlist: SharedPlaylistSnapshot;
        bytes: number;
    }
    | {
        ok: false;
        error: string;
        status: 400 | 413;
    };

const getUtf8ByteLength = (value: string) => {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(value).length;
    }
    if (typeof Buffer !== 'undefined') {
        return Buffer.byteLength(value, 'utf8');
    }
    return unescape(encodeURIComponent(value)).length;
};

const BASE64URL_FIELD_REGEX = /^[A-Za-z0-9_-]+$/;

const normalizeBase64UrlField = (value: unknown, minLength: number, maxLength: number) => {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    if (!BASE64URL_FIELD_REGEX.test(normalized)) return '';
    if (normalized.length < minLength || normalized.length > maxLength) return '';
    return normalized;
};

const bytesToBase64 = (bytes: Uint8Array) => {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    for (let idx = 0; idx < bytes.length; idx += 1) {
        binary += String.fromCharCode(bytes[idx]);
    }
    return btoa(binary);
};

const base64ToBytes = (base64: string) => {
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let idx = 0; idx < binary.length; idx += 1) {
        bytes[idx] = binary.charCodeAt(idx);
    }
    return bytes;
};

const toBase64Url = (bytes: Uint8Array) => {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const fromBase64Url = (value: string) => {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    const padded = pad ? `${normalized}${'='.repeat(4 - pad)}` : normalized;
    return base64ToBytes(padded);
};

const utf8ToBase64Url = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    return toBase64Url(bytes);
};

const base64UrlToUtf8 = (value: string) => {
    const bytes = fromBase64Url(value);
    return new TextDecoder().decode(bytes);
};

const normalizeSnapshotLike = (raw: any): SharedPlaylistSnapshot => {
    const source = raw && typeof raw === 'object' && raw.playlist && typeof raw.playlist === 'object'
        ? raw.playlist
        : raw;

    const safeName = sanitizePlaylistName(source?.name, 'Untitled Playlist').slice(0, MAX_SHARED_PLAYLIST_NAME_LENGTH);
    const safeByline = sanitizePlaylistByline(source?.byline || source?.by);
    const tracksInput: unknown[] = Array.isArray(source?.tracks) ? source.tracks : [];
    const seen = new Set<string>();
    const tracks: PlaylistTrack[] = [];

    for (let idx = 0; idx < tracksInput.length; idx += 1) {
        const normalized = normalizePlaylistTrack(tracksInput[idx], Date.now() + idx);
        if (!normalized) continue;
        if (seen.has(normalized.trackKey)) continue;
        seen.add(normalized.trackKey);
        tracks.push(normalized);
    }

    return {
        name: safeName || 'Untitled Playlist',
        ...(safeByline ? { byline: safeByline } : {}),
        tracks,
    };
};

export const normalizeSharedPlaylistPayload = (raw: any): SharedPlaylistNormalizeResult => {
    const source = raw && typeof raw === 'object' && raw.playlist && typeof raw.playlist === 'object'
        ? raw.playlist
        : raw;

    const rawTracks = Array.isArray(source?.tracks) ? source.tracks : [];
    if (rawTracks.length > MAX_SHARED_PLAYLIST_TRACKS) {
        return {
            ok: false,
            error: `Playlist has too many tracks (max ${MAX_SHARED_PLAYLIST_TRACKS}).`,
            status: 413,
        };
    }

    const playlist = normalizeSnapshotLike(source);
    if (playlist.tracks.length > MAX_SHARED_PLAYLIST_TRACKS) {
        return {
            ok: false,
            error: `Playlist has too many valid tracks (max ${MAX_SHARED_PLAYLIST_TRACKS}).`,
            status: 413,
        };
    }

    const payload = JSON.stringify({ version: 1, playlist });
    const bytes = getUtf8ByteLength(payload);
    if (bytes > MAX_SHARED_PLAYLIST_JSON_BYTES) {
        return {
            ok: false,
            error: 'Playlist payload is too large to share.',
            status: 413,
        };
    }

    return {
        ok: true,
        playlist,
        bytes,
    };
};

export const generateShareId = () => {
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error('Secure random generator unavailable.');
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return toBase64Url(bytes);
};

export const buildSharedPlaylistRecord = (
    shareId: string,
    playlist: SharedPlaylistSnapshot,
    createdAt = new Date().toISOString()
): SharedPlaylistRecordV1 => {
    const normalizedShareId = String(shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(normalizedShareId)) {
        throw new Error('Invalid share id.');
    }
    const normalized = normalizeSharedPlaylistPayload(playlist);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }
    return {
        version: 1,
        shareId: normalizedShareId,
        createdAt,
        playlist: normalized.playlist,
    };
};

export const normalizeSharedPlaylistRecord = (raw: any): SharedPlaylistRecordV1 | null => {
    if (!raw || typeof raw !== 'object') return null;
    const version = Number((raw as any).version);
    if (version !== 1) return null;

    const shareId = String((raw as any).shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(shareId)) return null;

    const createdAtRaw = String((raw as any).createdAt || '').trim();
    const createdAtDate = new Date(createdAtRaw);
    if (!createdAtRaw || Number.isNaN(createdAtDate.getTime())) return null;

    // Plain records must carry an explicit playlist payload.
    if (!Object.prototype.hasOwnProperty.call(raw, 'playlist')) return null;
    if (!(raw as any).playlist || typeof (raw as any).playlist !== 'object') return null;

    const normalized = normalizeSharedPlaylistPayload((raw as any).playlist);
    if (!normalized.ok) return null;

    return {
        version: 1,
        shareId,
        createdAt: createdAtDate.toISOString(),
        playlist: normalized.playlist,
    };
};

export const normalizeSharedPlaylistEncryptedPayload = (raw: any): SharedPlaylistEncryptedPayloadV1 | null => {
    if (!raw || typeof raw !== 'object') return null;
    const version = Number((raw as any).version);
    if (version !== 1) return null;

    const alg = String((raw as any).alg || '').trim();
    if (alg !== SHARED_PLAYLIST_ENCRYPTION_ALG) return null;

    const iv = normalizeBase64UrlField((raw as any).iv, 12, 40);
    if (!iv) return null;

    const ciphertext = normalizeBase64UrlField((raw as any).ciphertext, 24, 2_000_000);
    if (!ciphertext) return null;

    return {
        version: 1,
        alg: SHARED_PLAYLIST_ENCRYPTION_ALG,
        iv,
        ciphertext,
    };
};

export const encodeSharedPlaylistEncryptedEnvelope = (payload: SharedPlaylistEncryptedPayloadV1): string => {
    const normalized = normalizeSharedPlaylistEncryptedPayload(payload);
    if (!normalized) {
        throw new Error('Invalid encrypted shared playlist payload.');
    }

    const packed = JSON.stringify({
        v: 1,
        i: normalized.iv,
        c: normalized.ciphertext,
    });
    return `${SHARED_PLAYLIST_SEALED_PREFIX}${utf8ToBase64Url(packed)}`;
};

export const decodeSharedPlaylistEncryptedEnvelope = (raw: unknown): SharedPlaylistEncryptedPayloadV1 | null => {
    const sealed = String(raw || '').trim();
    if (!sealed.startsWith(SHARED_PLAYLIST_SEALED_PREFIX)) return null;
    const encoded = sealed.slice(SHARED_PLAYLIST_SEALED_PREFIX.length).trim();
    if (!encoded) return null;

    try {
        const parsed = JSON.parse(base64UrlToUtf8(encoded));
        const version = Number(parsed?.v);
        if (version !== 1) return null;
        return normalizeSharedPlaylistEncryptedPayload({
            version: 1,
            alg: SHARED_PLAYLIST_ENCRYPTION_ALG,
            iv: (parsed as any).i,
            ciphertext: (parsed as any).c,
        });
    } catch {
        return null;
    }
};

export const normalizeSharedPlaylistEncryptedRecord = (raw: any): SharedPlaylistEncryptedRecordV1 | null => {
    if (!raw || typeof raw !== 'object') return null;
    const version = Number((raw as any).version);
    if (version !== 1) return null;

    const shareId = String((raw as any).shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(shareId)) return null;

    const createdAtRaw = String((raw as any).createdAt || '').trim();
    const createdAtDate = new Date(createdAtRaw);
    if (!createdAtRaw || Number.isNaN(createdAtDate.getTime())) return null;

    const encrypted = normalizeSharedPlaylistEncryptedPayload((raw as any).encrypted)
        || decodeSharedPlaylistEncryptedEnvelope(
            (raw as any).sealed || (raw as any).payload || (raw as any).data
        );
    if (!encrypted) return null;

    return {
        version: 1,
        shareId,
        createdAt: createdAtDate.toISOString(),
        encrypted,
    };
};

export const encodeSharedPlaylistHash = (playlist: SharedPlaylistSnapshot) => {
    const normalized = normalizeSharedPlaylistPayload(playlist);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }
    const payload = JSON.stringify({
        version: 1,
        playlist: normalized.playlist,
    });
    return `${SHARED_PLAYLIST_HASH_PREFIX}${utf8ToBase64Url(payload)}`;
};

export const decodeSharedPlaylistHash = (rawHash: string): SharedPlaylistSnapshot | null => {
    const normalizedHash = String(rawHash || '').trim().replace(/^#/, '');
    if (!normalizedHash.startsWith(SHARED_PLAYLIST_HASH_PREFIX)) return null;
    const encodedPayload = normalizedHash.slice(SHARED_PLAYLIST_HASH_PREFIX.length).trim();
    if (!encodedPayload) return null;

    try {
        const jsonText = base64UrlToUtf8(encodedPayload);
        const parsed = JSON.parse(jsonText);
        const normalized = normalizeSharedPlaylistPayload(parsed?.playlist || parsed);
        if (!normalized.ok) return null;
        return normalized.playlist;
    } catch {
        return null;
    }
};
