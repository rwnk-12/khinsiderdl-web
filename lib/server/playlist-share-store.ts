import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { PlaylistTrack } from '../playlists';
import {
    SHARED_PLAY_ID_REGEX,
    type SharedPlaylistRecordV1,
    type SharedPlaylistSnapshot,
    buildSharedPlaylistRecord,
    normalizeSharedPlaylistPayload,
    normalizeSharedPlaylistRecord,
} from '../playlist-share';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const DEFAULT_RELATIVE_SHARE_DIR = path.join('data', 'playlist-shares');
const LINKS_DIR_NAME = 'links';
const BLOBS_DIR_NAME = 'blobs';
const CONTENT_HASH_REGEX = /^[a-f0-9]{64}$/;
const EDIT_TOKEN_HASH_REGEX = /^[a-f0-9]{64}$/;

type SharedPlaylistBlobV1 = {
    version: 1;
    playlist: SharedPlaylistSnapshot;
    checksum?: string;
};

export type SharedPlaylistLinkRecordV1 = {
    version: 1;
    shareId: string;
    contentHash: string;
    createdAt: string;
    revoked: boolean;
    editTokenHash?: string;
};

export type PlaylistShareWriteResult = {
    contentHash: string;
    blobCreated: boolean;
    editToken?: string;
};

export type PlaylistShareRevokeResult = 'ok' | 'not_found' | 'forbidden' | 'already_revoked' | 'unsupported';

type WritePlaylistShareOptions = {
    enableRevocation?: boolean;
};

const toDataDir = () => {
    const configured = String(process.env.PLAYLIST_SHARE_DATA_DIR || '').trim();
    const root = configured || path.join(process.cwd(), DEFAULT_RELATIVE_SHARE_DIR);
    return path.resolve(root);
};

const getSoftLimitBytes = () => {
    const raw = String(process.env.PLAYLIST_SHARE_SOFT_LIMIT_BYTES || '').trim();
    if (!raw) return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
};

const cleanupFile = async (filePath: string) => {
    try {
        await fs.unlink(filePath);
    } catch {
    }
};

const isCode = (error: unknown, code: string) => {
    return Boolean(error && typeof error === 'object' && (error as any).code === code);
};

const fileExists = async (filePath: string) => {
    try {
        await fs.access(filePath);
        return true;
    } catch (error: any) {
        if (isCode(error, 'ENOENT')) return false;
        throw error;
    }
};

const toLinksDir = () => path.join(toDataDir(), LINKS_DIR_NAME);
const toBlobsDir = () => path.join(toDataDir(), BLOBS_DIR_NAME);

const ensureBaseDirs = async () => {
    await fs.mkdir(toLinksDir(), { recursive: true });
    await fs.mkdir(toBlobsDir(), { recursive: true });
};

const toLegacyRecordPath = (shareId: string) => path.join(toDataDir(), `${shareId}.json`);
const toLinkPath = (shareId: string) => path.join(toLinksDir(), `${shareId}.json`);

const toBlobPath = (contentHash: string) => {
    const lowerHash = String(contentHash || '').trim().toLowerCase();
    if (!CONTENT_HASH_REGEX.test(lowerHash)) {
        throw new Error('Invalid content hash.');
    }
    const shardA = lowerHash.slice(0, 2);
    const shardB = lowerHash.slice(2, 4);
    return path.join(toBlobsDir(), shardA, shardB, `${lowerHash}.json.gz`);
};

const createTempPath = (targetPath: string) => {
    const token = randomBytes(6).toString('hex');
    return `${targetPath}.${Date.now()}.${token}.tmp`;
};

const writeUniqueFileAtomic = async (targetPath: string, payload: string | Buffer) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const tmpPath = createTempPath(targetPath);
    await fs.writeFile(tmpPath, data, { flag: 'wx' });

    try {
        await fs.link(tmpPath, targetPath);
        await cleanupFile(tmpPath);
        return true;
    } catch (error: any) {
        await cleanupFile(tmpPath);

        if (isCode(error, 'EEXIST')) return false;
        if (isCode(error, 'EPERM') || isCode(error, 'EACCES') || isCode(error, 'EXDEV') || isCode(error, 'ENOSYS')) {
            try {
                await fs.writeFile(targetPath, data, { flag: 'wx' });
                return true;
            } catch (fallbackError: any) {
                if (isCode(fallbackError, 'EEXIST')) return false;
                throw fallbackError;
            }
        }
        throw error;
    }
};

const writeReplaceFileAtomic = async (targetPath: string, payload: string | Buffer) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const tmpPath = createTempPath(targetPath);
    await fs.writeFile(tmpPath, data, { flag: 'wx' });
    try {
        await fs.rename(tmpPath, targetPath);
    } catch (error) {
        await cleanupFile(tmpPath);
        throw error;
    }
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

const normalizeAndHashSnapshot = (playlist: SharedPlaylistSnapshot) => {
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

    const canonicalJson = JSON.stringify(canonicalPayload);
    const contentHash = createHash('sha256').update(canonicalJson).digest('hex');
    return {
        playlist: normalized.playlist,
        contentHash,
    };
};

const hashEditToken = (editToken: string) => {
    return createHash('sha256').update(String(editToken || '').trim()).digest('hex');
};

const isValidEditToken = (raw: string) => {
    return String(raw || '').trim().length >= 16;
};

const parseLinkRecord = (raw: any): SharedPlaylistLinkRecordV1 | null => {
    if (!raw || typeof raw !== 'object') return null;
    const version = Number(raw.version);
    if (version !== 1) return null;

    const shareId = String(raw.shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(shareId)) return null;

    const contentHash = String(raw.contentHash || '').trim().toLowerCase();
    if (!CONTENT_HASH_REGEX.test(contentHash)) return null;

    const createdAtRaw = String(raw.createdAt || '').trim();
    const createdAtDate = new Date(createdAtRaw);
    if (!createdAtRaw || Number.isNaN(createdAtDate.getTime())) return null;

    const revoked = Boolean(raw.revoked);
    const editTokenHash = String(raw.editTokenHash || '').trim().toLowerCase();
    if (editTokenHash && !EDIT_TOKEN_HASH_REGEX.test(editTokenHash)) return null;

    return {
        version: 1,
        shareId,
        contentHash,
        createdAt: createdAtDate.toISOString(),
        revoked,
        ...(editTokenHash ? { editTokenHash } : {}),
    };
};

const readJsonFile = async (filePath: string) => {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
};

const readLinkRecordFromPath = async (filePath: string): Promise<SharedPlaylistLinkRecordV1 | null> => {
    try {
        const parsed = await readJsonFile(filePath);
        const normalized = parseLinkRecord(parsed);
        if (!normalized) {
            throw new Error('Invalid share link metadata.');
        }
        return normalized;
    } catch (error: any) {
        if (isCode(error, 'ENOENT')) return null;
        throw error;
    }
};

const readLegacyRecord = async (shareId: string): Promise<SharedPlaylistRecordV1 | null> => {
    const legacyPath = toLegacyRecordPath(shareId);
    try {
        const parsed = await readJsonFile(legacyPath);
        const normalized = normalizeSharedPlaylistRecord(parsed);
        if (!normalized) {
            throw new Error('Invalid legacy shared playlist record.');
        }
        return normalized;
    } catch (error: any) {
        if (isCode(error, 'ENOENT')) return null;
        throw error;
    }
};

const readBlobPlaylist = async (contentHash: string): Promise<SharedPlaylistSnapshot> => {
    const blobPath = toBlobPath(contentHash);
    const gzipBytes = await fs.readFile(blobPath);
    const jsonBytes = await gunzipAsync(gzipBytes);
    const rawText = jsonBytes.toString('utf8');
    const parsed: SharedPlaylistBlobV1 = JSON.parse(rawText);

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid blob payload.');
    }
    if (Number(parsed.version) !== 1) {
        throw new Error('Unsupported blob version.');
    }

    const normalized = normalizeSharedPlaylistPayload(parsed.playlist);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }

    const { contentHash: actualHash } = normalizeAndHashSnapshot(normalized.playlist);
    if (actualHash !== contentHash) {
        throw new Error('Shared playlist integrity check failed.');
    }

    const expectedChecksum = String(parsed.checksum || '').trim().toLowerCase();
    if (expectedChecksum && expectedChecksum !== actualHash) {
        throw new Error('Shared playlist checksum mismatch.');
    }

    return normalized.playlist;
};

const measureDirectoryBytes = async (dirPath: string): Promise<number> => {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error: any) {
        if (isCode(error, 'ENOENT')) return 0;
        throw error;
    }

    let total = 0;
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            total += await measureDirectoryBytes(fullPath);
            continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(fullPath);
        total += stat.size;
    }
    return total;
};

const enforceSoftStorageLimit = async (estimatedBytesToWrite: number) => {
    const softLimit = getSoftLimitBytes();
    if (!softLimit) return;

    const usedBytes = await measureDirectoryBytes(toDataDir());
    if (usedBytes + Math.max(0, estimatedBytesToWrite) > softLimit) {
        throw new Error('Playlist share storage limit exceeded.');
    }
};

export const computePlaylistShareContentHash = (playlist: SharedPlaylistSnapshot) => {
    return normalizeAndHashSnapshot(playlist).contentHash;
};

export const readPlaylistShareLinkRecord = async (shareId: string): Promise<SharedPlaylistLinkRecordV1 | null> => {
    const normalizedShareId = String(shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(normalizedShareId)) return null;
    const linkPath = toLinkPath(normalizedShareId);
    return readLinkRecordFromPath(linkPath);
};

export const writePlaylistShareRecord = async (
    record: SharedPlaylistRecordV1,
    options: WritePlaylistShareOptions = {}
): Promise<PlaylistShareWriteResult> => {
    const normalized = normalizeSharedPlaylistRecord(record);
    if (!normalized) throw new Error('Invalid shared playlist record.');

    await ensureBaseDirs();

    const linkPath = toLinkPath(normalized.shareId);
    const legacyPath = toLegacyRecordPath(normalized.shareId);
    if (await fileExists(linkPath) || await fileExists(legacyPath)) {
        throw new Error('Share id already exists.');
    }

    const { playlist, contentHash } = normalizeAndHashSnapshot(normalized.playlist);
    const blobPath = toBlobPath(contentHash);

    let editToken: string | undefined;
    let editTokenHash: string | undefined;
    if (options.enableRevocation) {
        editToken = randomBytes(24).toString('base64url');
        editTokenHash = hashEditToken(editToken);
    }

    const blobPayload: SharedPlaylistBlobV1 = {
        version: 1,
        playlist,
        checksum: contentHash,
    };
    const blobJson = JSON.stringify(blobPayload);
    const blobBytes = await gzipAsync(Buffer.from(blobJson, 'utf8'), { level: 9 });

    const linkPayload: SharedPlaylistLinkRecordV1 = {
        version: 1,
        shareId: normalized.shareId,
        contentHash,
        createdAt: normalized.createdAt,
        revoked: false,
        ...(editTokenHash ? { editTokenHash } : {}),
    };
    const linkJson = JSON.stringify(linkPayload);

    await enforceSoftStorageLimit(blobBytes.length + Buffer.byteLength(linkJson, 'utf8'));

    const blobCreated = await writeUniqueFileAtomic(blobPath, blobBytes);
    const linkCreated = await writeUniqueFileAtomic(linkPath, linkJson);
    if (!linkCreated) {
        throw new Error('Share id already exists.');
    }

    return {
        contentHash,
        blobCreated,
        ...(editToken ? { editToken } : {}),
    };
};

export const readPlaylistShareRecord = async (shareId: string): Promise<SharedPlaylistRecordV1 | null> => {
    const normalizedShareId = String(shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(normalizedShareId)) return null;

    const link = await readPlaylistShareLinkRecord(normalizedShareId);
    if (link) {
        if (link.revoked) return null;
        const playlist = await readBlobPlaylist(link.contentHash);
        return buildSharedPlaylistRecord(link.shareId, playlist, link.createdAt);
    }

    return readLegacyRecord(normalizedShareId);
};

export const revokePlaylistShare = async (shareId: string, editToken: string): Promise<PlaylistShareRevokeResult> => {
    const normalizedShareId = String(shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(normalizedShareId)) return 'not_found';

    const trimmedToken = String(editToken || '').trim();
    if (!isValidEditToken(trimmedToken)) return 'forbidden';

    const linkPath = toLinkPath(normalizedShareId);
    const link = await readLinkRecordFromPath(linkPath);
    if (!link) {
        const legacyExists = await fileExists(toLegacyRecordPath(normalizedShareId));
        return legacyExists ? 'unsupported' : 'not_found';
    }

    if (link.revoked) return 'already_revoked';
    if (!link.editTokenHash) return 'unsupported';

    const expected = Buffer.from(link.editTokenHash, 'hex');
    const received = Buffer.from(hashEditToken(trimmedToken), 'hex');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        return 'forbidden';
    }

    const updatedLink: SharedPlaylistLinkRecordV1 = {
        ...link,
        revoked: true,
    };
    await writeReplaceFileAtomic(linkPath, JSON.stringify(updatedLink));
    return 'ok';
};
