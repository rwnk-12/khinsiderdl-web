export const PLAYLISTS_STORAGE_KEY = 'kh_playlists_v1';
export const PLAYLISTS_ALL_EXPORT_FILENAME = 'khi-dl-all-playlists.json';
export const PLAYLISTS_EXPORT_FILENAME = PLAYLISTS_ALL_EXPORT_FILENAME;
export const PLAYLISTS_STORE_VERSION = 1 as const;

const PLAYLIST_NAME_MAX = 60;
const PLAYLIST_BYLINE_MAX = 80;

export type PlaylistTrack = {
    trackKey: string;
    url: string;
    title: string;
    number?: number | string;
    duration?: string;
    bitrate?: string;
    fileSize?: string;
    albumName: string;
    albumUrl?: string;
    albumId?: string;
    albumArt?: string;
    thumbnail?: string;
    addedAt: number;
};

export type Playlist = {
    id: string;
    name: string;
    byline?: string;
    createdAt: number;
    updatedAt: number;
    revision: number;
    tracks: PlaylistTrack[];
};

export type PlaylistsStoreV1 = {
    version: 1;
    playlists: Playlist[];
    exportedAt?: string;
};

export type PlaylistImportSummary = {
    playlists: Playlist[];
    created: number;
    merged: number;
    tracksAdded: number;
    invalidEntries: number;
};

const asString = (value: unknown) => String(value ?? '').trim();

const toLowerSet = (names: string[]) => {
    const set = new Set<string>();
    names.forEach((name) => set.add(name.toLowerCase()));
    return set;
};

export const sanitizePlaylistName = (rawName: unknown, fallback = 'Untitled Playlist') => {
    const normalized = asString(rawName).replace(/\s+/g, ' ');
    if (!normalized) return fallback;
    if (normalized.length <= PLAYLIST_NAME_MAX) return normalized;
    return normalized.slice(0, PLAYLIST_NAME_MAX).trim();
};

export const sanitizePlaylistByline = (rawByline: unknown) => {
    const normalized = asString(rawByline).replace(/\s+/g, ' ');
    if (!normalized) return '';
    if (normalized.length <= PLAYLIST_BYLINE_MAX) return normalized;
    return normalized.slice(0, PLAYLIST_BYLINE_MAX).trim();
};

const stripDiacritics = (value: string) => {
    try {
        return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    } catch {
        return value;
    }
};

export const toPlaylistIdentifier = (rawName: unknown, fallback = 'playlist') => {
    const safeName = sanitizePlaylistName(rawName, fallback);
    const ascii = stripDiacritics(safeName);
    const normalized = ascii
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
};

export const createPlaylistId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const buildFallbackTrackKey = (raw: any) => {
    const urlKey = asString(raw?.url);
    if (urlKey) return `url:${urlKey}`;
    const title = asString(raw?.title).toLowerCase();
    const albumName = asString(raw?.albumName).toLowerCase();
    return `meta:${title}|${albumName}`;
};

export const normalizePlaylistTrack = (raw: any, fallbackAddedAt = Date.now()): PlaylistTrack | null => {
    if (!raw || typeof raw !== 'object') return null;

    const url = asString(raw.url);
    const title = asString(raw.title);
    const albumName = asString(raw.albumName || raw.album);
    if (!url || !title || !albumName) return null;

    const addedAtNum = Number(raw.addedAt);
    const addedAt = Number.isFinite(addedAtNum) && addedAtNum > 0 ? addedAtNum : fallbackAddedAt;
    const trackKey = asString(raw.trackKey) || buildFallbackTrackKey({ ...raw, url, title, albumName });

    const next: PlaylistTrack = {
        trackKey,
        url,
        title,
        albumName,
        addedAt,
    };

    const numberValue = raw.number;
    if (typeof numberValue === 'number' || typeof numberValue === 'string') {
        next.number = numberValue;
    }

    const duration = asString(raw.duration);
    if (duration) next.duration = duration;

    const bitrate = asString(raw.bitrate);
    if (bitrate) next.bitrate = bitrate;

    const fileSize = asString(raw.fileSize);
    if (fileSize) next.fileSize = fileSize;

    const albumUrl = asString(raw.albumUrl);
    if (albumUrl) next.albumUrl = albumUrl;

    const albumId = asString(raw.albumId);
    if (albumId) next.albumId = albumId;

    const albumArt = asString(raw.albumArt);
    if (albumArt) next.albumArt = albumArt;

    const thumbnail = asString(raw.thumbnail);
    if (thumbnail) next.thumbnail = thumbnail;

    return next;
};

const normalizePlaylist = (raw: any): Playlist | null => {
    if (!raw || typeof raw !== 'object') return null;

    const name = sanitizePlaylistName(raw.name);
    const byline = sanitizePlaylistByline(raw.byline || raw.by);
    const createdAtRaw = Number(raw.createdAt);
    const updatedAtRaw = Number(raw.updatedAt);
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : Date.now();
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : createdAt;
    const revisionRaw = Number(raw.revision);
    const revision = Number.isFinite(revisionRaw) && revisionRaw > 0 ? Math.floor(revisionRaw) : 1;
    const id = asString(raw.id) || createPlaylistId();

    const sourceTracks: unknown[] = Array.isArray(raw.tracks) ? raw.tracks : [];
    const seen = new Set<string>();
    const tracks: PlaylistTrack[] = [];
    sourceTracks.forEach((item: unknown, index: number) => {
        const normalized = normalizePlaylistTrack(item, createdAt + index);
        if (!normalized) return;
        if (seen.has(normalized.trackKey)) return;
        seen.add(normalized.trackKey);
        tracks.push(normalized);
    });

    return {
        id,
        name,
        ...(byline ? { byline } : {}),
        createdAt,
        updatedAt: Math.max(updatedAt, createdAt),
        revision,
        tracks,
    };
};

const normalizePlaylistList = (rawPlaylists: any[]): Playlist[] => {
    const ids = new Set<string>();
    const names = new Set<string>();
    const normalized: Playlist[] = [];

    rawPlaylists.forEach((entry: unknown) => {
        const next = normalizePlaylist(entry);
        if (!next) return;
        if (ids.has(next.id)) return;
        const lowerName = next.name.toLowerCase();
        if (names.has(lowerName)) return;
        ids.add(next.id);
        names.add(lowerName);
        normalized.push(next);
    });

    return normalized;
};

export const loadPlaylistsFromStorage = (storage: Storage | null | undefined): Playlist[] => {
    if (!storage) return [];
    const saved = storage.getItem(PLAYLISTS_STORAGE_KEY);
    if (!saved) return [];

    try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
            return normalizePlaylistList(parsed);
        }
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).playlists)) {
            return normalizePlaylistList((parsed as any).playlists);
        }
    } catch (error) {
        console.error('Failed to parse playlists from storage', error);
    }
    return [];
};

export const savePlaylistsToStorage = (
    storage: Storage | null | undefined,
    playlists: Playlist[]
): { ok: boolean; error?: string } => {
    if (!storage) return { ok: true };
    try {
        const payload: PlaylistsStoreV1 = {
            version: PLAYLISTS_STORE_VERSION,
            playlists,
        };
        storage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(payload));
        return { ok: true };
    } catch (error: any) {
        const message = asString(error?.message) || 'Failed to save playlists';
        return { ok: false, error: message };
    }
};

export const createPlaylistRecord = (name: string, bylineRaw?: string): Playlist => {
    const now = Date.now();
    const byline = sanitizePlaylistByline(bylineRaw);
    return {
        id: createPlaylistId(),
        name: sanitizePlaylistName(name),
        ...(byline ? { byline } : {}),
        createdAt: now,
        updatedAt: now,
        revision: 1,
        tracks: [],
    };
};

const makeImportedName = (baseName: string, namesInUse: Set<string>) => {
    const normalizedBase = sanitizePlaylistName(baseName);
    const lowerBase = normalizedBase.toLowerCase();
    if (!namesInUse.has(lowerBase)) {
        namesInUse.add(lowerBase);
        return normalizedBase;
    }

    const importedBase = sanitizePlaylistName(`${normalizedBase} (Imported)`);
    let candidate = importedBase;
    let counter = 2;
    while (namesInUse.has(candidate.toLowerCase())) {
        candidate = sanitizePlaylistName(`${importedBase} ${counter}`);
        counter += 1;
    }
    namesInUse.add(candidate.toLowerCase());
    return candidate;
};

export const appendTracksToPlaylist = (
    playlist: Playlist,
    rawTracks: any[]
): { playlist: Playlist; addedCount: number } => {
    const existing = new Set<string>(playlist.tracks.map((track) => track.trackKey));
    const appended: PlaylistTrack[] = [];
    let addedCount = 0;

    rawTracks.forEach((rawTrack, index) => {
        const normalized = normalizePlaylistTrack(rawTrack, Date.now() + index);
        if (!normalized) return;
        if (existing.has(normalized.trackKey)) return;
        existing.add(normalized.trackKey);
        addedCount += 1;
        appended.push(normalized);
    });

    if (addedCount === 0) {
        return { playlist, addedCount: 0 };
    }

    const now = Date.now();
    return {
        playlist: {
            ...playlist,
            tracks: [...playlist.tracks, ...appended],
            updatedAt: now,
            revision: playlist.revision + 1,
        },
        addedCount,
    };
};

export const removeTrackAtIndex = (playlist: Playlist, trackIndex: number): Playlist => {
    if (trackIndex < 0 || trackIndex >= playlist.tracks.length) return playlist;
    const nextTracks = playlist.tracks.filter((_, index) => index !== trackIndex);
    const now = Date.now();
    return {
        ...playlist,
        tracks: nextTracks,
        updatedAt: now,
        revision: playlist.revision + 1,
    };
};

export const moveTrackInPlaylist = (playlist: Playlist, fromIndex: number, toIndex: number): Playlist => {
    if (fromIndex === toIndex) return playlist;
    if (fromIndex < 0 || fromIndex >= playlist.tracks.length) return playlist;
    if (toIndex < 0 || toIndex >= playlist.tracks.length) return playlist;

    const nextTracks = [...playlist.tracks];
    const [moved] = nextTracks.splice(fromIndex, 1);
    if (!moved) return playlist;
    nextTracks.splice(toIndex, 0, moved);

    const now = Date.now();
    return {
        ...playlist,
        tracks: nextTracks,
        updatedAt: now,
        revision: playlist.revision + 1,
    };
};

export const buildPlaylistsExportPayload = (playlists: Playlist[]): PlaylistsStoreV1 => {
    return {
        version: PLAYLISTS_STORE_VERSION,
        playlists,
        exportedAt: new Date().toISOString(),
    };
};

export const importPlaylistsFromJson = (
    jsonText: string,
    existingPlaylists: Playlist[]
): PlaylistImportSummary => {
    let parsed: any;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error('Failed to parse file.');
    }

    const rawPlaylists = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.playlists)
            ? parsed.playlists
            : null;

    if (!rawPlaylists) {
        throw new Error('Invalid file format.');
    }

    const namesInUse = toLowerSet(existingPlaylists.map((playlist) => playlist.name));
    const imported: Playlist[] = [];
    let invalidEntries = 0;
    let tracksAdded = 0;

    rawPlaylists.forEach((entry: unknown) => {
        const normalized = normalizePlaylist(entry);
        if (!normalized) {
            invalidEntries += 1;
            return;
        }
        const name = makeImportedName(normalized.name, namesInUse);
        const next: Playlist = {
            ...normalized,
            id: createPlaylistId(),
            name,
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        tracksAdded += next.tracks.length;
        imported.push(next);
    });

    return {
        playlists: [...existingPlaylists, ...imported],
        created: imported.length,
        merged: 0,
        tracksAdded,
        invalidEntries,
    };
};
