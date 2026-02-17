import type { PlaylistTrack } from './playlists';
import { normalizePlaylistTrack, sanitizePlaylistByline, sanitizePlaylistName } from './playlists';

export const MAX_SHARED_PLAYLIST_NAME_LENGTH = 60;
export const MAX_SHARED_PLAYLIST_TRACKS = 2000;
export const MAX_SHARED_PLAYLIST_JSON_BYTES = 1024 * 1024;
export const MAX_SHARED_HASH_URL_LENGTH = 7800;
export const SHARED_PLAYLIST_HASH_PREFIX = 'khs1.';
export const SHARED_PLAY_ID_REGEX = /^[A-Za-z0-9_-]{16,64}$/;

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

    const normalized = normalizeSharedPlaylistPayload((raw as any).playlist);
    if (!normalized.ok) return null;

    return {
        version: 1,
        shareId,
        createdAt: createdAtDate.toISOString(),
        playlist: normalized.playlist,
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
