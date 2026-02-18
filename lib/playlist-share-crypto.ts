import type { PlaylistTrack } from './playlists';
import {
    SHARED_PLAYLIST_ENCRYPTION_ALG,
    normalizeSharedPlaylistEncryptedPayload,
    normalizeSharedPlaylistPayload,
    type SharedPlaylistEncryptedPayloadV1,
    type SharedPlaylistSnapshot,
} from './playlist-share';

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

const bytesToHex = (bytes: Uint8Array) => {
    return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
};

const getCrypto = () => {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle) {
        throw new Error('Secure crypto is not available in this environment.');
    }
    return cryptoApi;
};

const toCanonicalTrack = (track: PlaylistTrack) => {
    const canonical: Record<string, string | number> = {
        trackKey: String(track.trackKey || '').trim(),
        url: String(track.url || '').trim(),
        title: String(track.title || '').trim(),
        albumName: String(track.albumName || '').trim(),
        addedAt: Number(track.addedAt || 0),
    };

    if (typeof track.number === 'number' && Number.isFinite(track.number)) {
        canonical.number = track.number;
    } else if (typeof track.number === 'string' && track.number.trim()) {
        canonical.number = track.number.trim();
    }

    const optionalTextFields: Array<keyof PlaylistTrack> = [
        'duration',
        'bitrate',
        'fileSize',
        'albumUrl',
        'albumId',
        'albumArt',
        'thumbnail',
    ];

    optionalTextFields.forEach((field) => {
        const value = track[field];
        if (typeof value === 'string' && value.trim()) {
            canonical[field] = value.trim();
        }
    });

    return canonical;
};

const toCanonicalPlaylistJson = (playlist: SharedPlaylistSnapshot) => {
    const normalized = normalizeSharedPlaylistPayload(playlist);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }

    const canonicalPayload: {
        name: string;
        byline?: string;
        tracks: ReturnType<typeof toCanonicalTrack>[];
    } = {
        name: normalized.playlist.name,
        tracks: normalized.playlist.tracks.map(toCanonicalTrack),
    };
    if (normalized.playlist.byline) {
        canonicalPayload.byline = normalized.playlist.byline;
    }
    return JSON.stringify(canonicalPayload);
};

export const computeSharedPlaylistContentHash = async (playlist: SharedPlaylistSnapshot) => {
    const cryptoApi = getCrypto();
    const canonicalJson = toCanonicalPlaylistJson(playlist);
    const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
    return bytesToHex(new Uint8Array(digest));
};

export const encryptSharedPlaylistSnapshot = async (
    playlist: SharedPlaylistSnapshot
): Promise<{ encrypted: SharedPlaylistEncryptedPayloadV1; shareKey: string }> => {
    const cryptoApi = getCrypto();
    const normalized = normalizeSharedPlaylistPayload(playlist);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }

    const keyBytes = cryptoApi.getRandomValues(new Uint8Array(32));
    const ivBytes = cryptoApi.getRandomValues(new Uint8Array(12));
    const key = await cryptoApi.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);

    const plaintextJson = JSON.stringify({
        version: 1,
        playlist: normalized.playlist,
    });
    const ciphertextBuffer = await cryptoApi.subtle.encrypt(
        { name: 'AES-GCM', iv: ivBytes },
        key,
        new TextEncoder().encode(plaintextJson)
    );

    return {
        encrypted: {
            version: 1,
            alg: SHARED_PLAYLIST_ENCRYPTION_ALG,
            iv: toBase64Url(ivBytes),
            ciphertext: toBase64Url(new Uint8Array(ciphertextBuffer)),
        },
        shareKey: toBase64Url(keyBytes),
    };
};

export const decryptSharedPlaylistSnapshot = async (
    encryptedPayload: SharedPlaylistEncryptedPayloadV1,
    shareKey: string
): Promise<SharedPlaylistSnapshot> => {
    const cryptoApi = getCrypto();
    const normalizedPayload = normalizeSharedPlaylistEncryptedPayload(encryptedPayload);
    if (!normalizedPayload) {
        throw new Error('Shared playlist payload is invalid.');
    }

    const keyBytes = fromBase64Url(String(shareKey || '').trim());
    if (keyBytes.length !== 32) {
        throw new Error('Shared playlist key is invalid.');
    }
    const ivBytes = fromBase64Url(normalizedPayload.iv);
    if (ivBytes.length < 12 || ivBytes.length > 16) {
        throw new Error('Shared playlist payload is invalid.');
    }

    const ciphertextBytes = fromBase64Url(normalizedPayload.ciphertext);
    if (ciphertextBytes.length < 16) {
        throw new Error('Shared playlist payload is invalid.');
    }

    const key = await cryptoApi.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);

    let plaintextBytes: ArrayBuffer;
    try {
        plaintextBytes = await cryptoApi.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBytes },
            key,
            ciphertextBytes
        );
    } catch {
        throw new Error('Shared playlist key is invalid for this link.');
    }

    let parsed: any = null;
    try {
        parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    } catch {
        throw new Error('Shared playlist payload could not be decoded.');
    }

    const normalized = normalizeSharedPlaylistPayload(parsed?.playlist || parsed);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }
    return normalized.playlist;
};

export const buildSharedPlaylistHashKey = (shareKey: string) => {
    return `k=${encodeURIComponent(String(shareKey || '').trim())}`;
};

export const getSharedPlaylistKeyFromHash = (rawHash: string) => {
    const normalizedHash = String(rawHash || '').trim().replace(/^#/, '');
    if (!normalizedHash) return '';
    if (!normalizedHash.startsWith('k=')) return '';
    const params = new URLSearchParams(normalizedHash);
    return String(params.get('k') || '').trim();
};

export const appendSharedPlaylistKeyToUrl = (rawUrl: string, shareKey: string) => {
    const url = String(rawUrl || '').trim();
    const key = String(shareKey || '').trim();
    if (!url || !key) return url;
    const hash = buildSharedPlaylistHashKey(key);
    const hashPrefixIndex = url.indexOf('#');
    if (hashPrefixIndex >= 0) {
        return `${url.slice(0, hashPrefixIndex)}#${hash}`;
    }
    return `${url}#${hash}`;
};
