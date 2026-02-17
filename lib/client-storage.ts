import type { AudioQualityPreference } from './app-types';

type QualityPayloadV1 = {
    version: 1;
    value: AudioQualityPreference;
};

type LikedTracksPayloadV1 = {
    version: 1;
    tracks: unknown[];
};

const QUALITY_STORAGE_KEY = 'kh_quality_pref_v1';
const LEGACY_QUALITY_STORAGE_KEY = 'quality';
const LIKED_TRACKS_STORAGE_KEY = 'kh_liked_tracks_v1';
const LEGACY_LIKED_TRACKS_STORAGE_KEY = 'kh_liked_songs';

const isQualityPreference = (value: unknown): value is AudioQualityPreference => {
    return value === 'best' || value === 'flac' || value === 'm4a' || value === 'mp3';
};

const safeParseJson = (raw: string | null): unknown => {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const safeSetItem = (storage: Storage | null | undefined, key: string, value: string) => {
    if (!storage) return;
    try {
        storage.setItem(key, value);
    } catch {
    }
};

export const readQualityPreference = (
    storage: Storage | null | undefined,
    fallback: AudioQualityPreference = 'best'
): AudioQualityPreference => {
    if (!storage) return fallback;

    const parsedPrimary = safeParseJson(storage.getItem(QUALITY_STORAGE_KEY)) as Partial<QualityPayloadV1> | null;
    if (parsedPrimary?.version === 1 && isQualityPreference(parsedPrimary.value)) {
        return parsedPrimary.value;
    }

    const legacy = String(storage.getItem(LEGACY_QUALITY_STORAGE_KEY) || '').trim();
    if (isQualityPreference(legacy)) {
        writeQualityPreference(storage, legacy);
        return legacy;
    }

    return fallback;
};

export const writeQualityPreference = (
    storage: Storage | null | undefined,
    quality: AudioQualityPreference
) => {
    if (!storage) return;
    const payload: QualityPayloadV1 = { version: 1, value: quality };
    safeSetItem(storage, QUALITY_STORAGE_KEY, JSON.stringify(payload));
};

export const readLikedTracksFromStorage = (storage: Storage | null | undefined): unknown[] => {
    if (!storage) return [];

    const parsedPrimary = safeParseJson(storage.getItem(LIKED_TRACKS_STORAGE_KEY)) as Partial<LikedTracksPayloadV1> | null;
    if (parsedPrimary?.version === 1 && Array.isArray(parsedPrimary.tracks)) {
        return parsedPrimary.tracks;
    }

    const legacyParsed = safeParseJson(storage.getItem(LEGACY_LIKED_TRACKS_STORAGE_KEY));
    if (Array.isArray(legacyParsed)) {
        writeLikedTracksToStorage(storage, legacyParsed);
        return legacyParsed;
    }

    return [];
};

export const writeLikedTracksToStorage = (storage: Storage | null | undefined, tracks: unknown[]) => {
    if (!storage) return;
    const payload: LikedTracksPayloadV1 = {
        version: 1,
        tracks: Array.isArray(tracks) ? tracks : [],
    };
    safeSetItem(storage, LIKED_TRACKS_STORAGE_KEY, JSON.stringify(payload));
};

