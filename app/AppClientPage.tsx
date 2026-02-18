'use client';
import React, { startTransition, useDeferredValue, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import "./globals.css";

import { isUrl, extractPathFromUrl, isAbortLikeError, isTimeoutLikeError } from '../lib/utils';
import { api } from '../lib/khinsider-api';
import type { SearchFilterOption, SearchFilterOptions, SearchFilters, SearchPagination } from '../lib/search-types';
import type { BrowseAlbumItem, BrowsePagination, BrowseSectionKey } from '../lib/browse-types';
import { dlManager } from '../lib/download-manager';
import { consumeSuppressedPopStateEvent, useHistoryState } from '../lib/useHistoryState';
import type { Playlist, PlaylistTrack } from '../lib/playlists';
import {
    PLAYLISTS_ALL_EXPORT_FILENAME,
    appendTracksToPlaylist,
    buildPlaylistsExportPayload,
    createPlaylistRecord,
    importPlaylistsFromJson,
    loadPlaylistsFromStorage,
    moveTrackInPlaylist,
    normalizePlaylistTrack,
    removeTrackAtIndex,
    sanitizePlaylistByline,
    sanitizePlaylistName,
    savePlaylistsToStorage,
    toPlaylistIdentifier,
} from '../lib/playlists';
import type { AudioQualityPreference, LikedTrack, Track } from '../lib/app-types';
import { readLikedTracksFromStorage, writeLikedTracksToStorage } from '../lib/client-storage';
import type { SharedPlaylistRecordV1 } from '../lib/playlist-share';
import {
    SHARED_PLAY_ID_REGEX,
    normalizeSharedPlaylistPayload,
} from '../lib/playlist-share';
import { getSharedPlaylistKeyFromHash } from '../lib/playlist-share-crypto';

import { SimilarAlbums } from '../components/SimilarAlbums';
import { GalleryPortalHost, type GalleryPortalHostHandle } from '../components/GalleryPortalHost';
import { AlbumArtStack } from '../components/AlbumArtStack';
import { Player } from '../components/Player';
import { TrackRow } from '../components/TrackRow';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { MedievalSpinner } from '../components/MedievalSpinner';
import { QueueOverlayHost, type QueueOverlayHostHandle } from '../components/QueueOverlayHost';
import { Icon } from '../components/Icon';
import { HomeAlbumCard } from '../components/HomeAlbumCard';
import { PlaylistPickerOverlay } from '../components/PlaylistPickerOverlay';
import { TabHeader } from '../components/TabHeader';
import { AutoScrollLabel } from '../components/AutoScrollLabel';
import { ViewPanel } from '../components/ViewPanel';
import { ClientPerfVitals, type PerfSamplerMetrics } from './ClientPerfVitals';

const QueueView = dynamic(() => import('../components/QueueView').then((mod) => mod.QueueView), {
    loading: () => (
        <div className="home-feed-loading">
            <LoadingIndicator />
        </div>
    ),
});

const SettingsView = dynamic(() => import('../components/SettingsView').then((mod) => mod.SettingsView), {
    loading: () => (
        <div className="home-feed-loading">
            <LoadingIndicator />
        </div>
    ),
});

const PlaylistsView = dynamic(() => import('../components/PlaylistsView').then((mod) => mod.PlaylistsView), {
    loading: () => (
        <div className="home-feed-loading">
            <LoadingIndicator />
        </div>
    ),
});

const DISCORD_URL = "https://discord.gg/yuvnx7FS89";
const LIKED_ALBUM_META_CACHE_KEY = 'kh_liked_album_meta_cache_v3';
const LEGACY_LIKED_ALBUM_META_CACHE_KEY = 'kh_liked_album_meta_cache_v2';

const normalizeAlbumId = (raw?: string | null) => {
    const input = String(raw || '').trim();
    if (!input) return '';
    const path = extractPathFromUrl(input);
    const albumMatch = String(path || '').match(/(\/game-soundtracks\/album\/[^/?#]+)/i);
    if (albumMatch?.[1]) return albumMatch[1].replace(/[/?]+$/, '').toLowerCase();
    const shortAlbumMatch = String(path || '').match(/\/album\/([^/?#]+)/i);
    if (shortAlbumMatch?.[1]) {
        return `/game-soundtracks/album/${shortAlbumMatch[1]}`.replace(/[/?]+$/, '').toLowerCase();
    }
    const artMatch = String(path || '').match(/\/soundtracks\/([^/?#]+)/i);
    if (artMatch?.[1]) return `/game-soundtracks/album/${artMatch[1]}`.replace(/[/?]+$/, '').toLowerCase();
    return '';
};

const normalizeLikedTrack = (track: unknown): LikedTrack => {
    const normalized = { ...((track && typeof track === 'object') ? (track as Record<string, unknown>) : {}) } as LikedTrack;
    const derivedAlbumId =
        normalizeAlbumId(normalized?.albumId) ||
        normalizeAlbumId(normalized?.albumUrl) ||
        normalizeAlbumId(normalized?.url) ||
        normalizeAlbumId(normalized?.albumArt);
    if (derivedAlbumId) {
        normalized.albumId = derivedAlbumId;
        if (!normalized.albumUrl) {
            normalized.albumUrl = `https://downloads.khinsider.com${derivedAlbumId}`;
        }
    }
    const likedAt = Number(normalized.likedAt ?? normalized.addedAt ?? 0);
    normalized.likedAt = Number.isFinite(likedAt) && likedAt > 0 ? Math.floor(likedAt) : Date.now();
    return normalized;
};

type HomeCardData = {
    image?: string;
    artist?: string;
    albumType?: string;
    year?: string;
    metadataResolved?: boolean;
};

type AppView = 'home' | 'browse' | 'liked' | 'playlists' | 'queue' | 'settings';

const VIEW_PATHS: Record<AppView, string> = {
    home: '/home',
    browse: '/browse',
    liked: '/liked',
    playlists: '/playlists',
    queue: '/queue',
    settings: '/settings',
};

const normalizeRoutePath = (pathname: string) => {
    const raw = String(pathname || '').trim() || '/';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
    return trimmed.toLowerCase();
};

const getPathForView = (view: AppView) => VIEW_PATHS[view] || VIEW_PATHS.home;

const getViewFromPathname = (pathname: string): AppView => {
    const normalized = normalizeRoutePath(pathname);
    if (normalized === '/' || normalized === '/home' || normalized === '/results') return 'home';
    if (normalized === '/browse') return 'browse';
    if (normalized === '/liked') return 'liked';
    if (normalized === '/playlists' || normalized.startsWith('/playlists/')) return 'playlists';
    if (normalized === '/queue') return 'queue';
    if (normalized === '/settings') return 'settings';
    return 'home';
};

const getPlaylistIdentifierFromPathname = (pathname: string): string | null => {
    const normalized = normalizeRoutePath(pathname);
    const match = normalized.match(/^\/playlists\/(?!shared(?:\/|$))([^/?#]+)$/i);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
};

const getSharedPlaylistShareIdFromPathname = (pathname: string): string | null => {
    const raw = String(pathname || '').trim() || '/';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
    const match = trimmed.match(/^\/playlists\/shared\/([^/?#]+)$/i);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
};

const isSharedPlaylistHashPath = (pathname: string) => {
    const normalized = normalizeRoutePath(pathname);
    return normalized === '/playlists/shared';
};

const getPlaylistPathForIdentifier = (identifier: string) => {
    const trimmed = String(identifier || '').trim();
    if (!trimmed) return VIEW_PATHS.playlists;
    return `${VIEW_PATHS.playlists}/${encodeURIComponent(trimmed)}`;
};

const toCompactPlaylistId = (playlistId: string) => {
    return String(playlistId || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
};

const toPlaylistRouteIdentifier = (playlist: Pick<Playlist, 'id' | 'name'>) => {
    const slug = toPlaylistIdentifier(playlist.name || 'playlist');
    const compactId = toCompactPlaylistId(playlist.id);
    const shortId = compactId.slice(0, 8);
    return shortId ? `${slug}-${shortId}` : slug;
};

const resolvePlaylistFromRouteIdentifier = (identifier: string | null, playlists: Playlist[]): Playlist | null => {
    const raw = String(identifier || '').trim().toLowerCase();
    if (!raw) return null;

    const compactMatch = raw.match(/-([a-z0-9]{6,})$/);
    const compactIdHint = compactMatch?.[1] || '';
    if (compactIdHint) {
        const byCompactId = playlists.find((playlist) => toCompactPlaylistId(playlist.id).startsWith(compactIdHint));
        if (byCompactId) return byCompactId;
    }

    const slugCandidate = compactIdHint
        ? raw.replace(new RegExp(`-${compactIdHint}$`), '')
        : raw;
    const normalizedSlug = toPlaylistIdentifier(slugCandidate || raw);
    return playlists.find((playlist) => toPlaylistIdentifier(playlist.name) === normalizedSlug) || null;
};

const toAlbumUrlParam = (raw: string) => {
    const value = String(raw || '').trim();
    if (!value) return '';
    const normalizedAlbumId = normalizeAlbumId(value);
    if (normalizedAlbumId) return normalizedAlbumId;
    const path = String(extractPathFromUrl(value) || '').trim();
    return path || value;
};

const getCanonicalAlbumPathFromPathname = (pathname: string) => {
    const normalized = normalizeRoutePath(pathname);
    const match = normalized.match(/^(\/game-soundtracks\/album\/[^/?#]+)/i);
    return match?.[1] ? match[1].replace(/[/?]+$/, '').toLowerCase() : '';
};

const normalizeCompareValue = (raw: string) => {
    const input = String(raw || '');
    let normalized = input;
    try {
        normalized = normalized.normalize('NFKD');
    } catch {
    }
    return normalized
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
};

const decodePathSegments = (pathLike: string) => {
    return String(pathLike || '')
        .split('/')
        .map((segment) => {
            if (!segment) return '';
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join('/');
};

const normalizeTrackPathForMatch = (raw?: string | null) => {
    const value = String(raw || '').trim();
    if (!value) return '';
    const pathLike = String(extractPathFromUrl(value) || value).trim();
    if (!pathLike) return '';
    const decoded = decodePathSegments(pathLike);
    const cleaned = decoded
        .replace(/\\/g, '/')
        .replace(/\?.*$/, '')
        .replace(/#.*$/, '')
        .replace(/\/+/g, '/')
        .replace(/[/?]+$/, '');
    if (!cleaned) return '';
    const withLeadingSlash = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
    const normalized = normalizeCompareValue(withLeadingSlash)
        .replace(/\s*\/\s*/g, '/')
        .replace(/\/+/g, '/');
    return normalized === '/' ? '' : normalized;
};

const toAlbumPathAlias = (pathLike?: string | null) => {
    const normalized = normalizeTrackPathForMatch(pathLike);
    if (!normalized) return '';
    const match = normalized.match(/^\/(?:game-soundtracks\/album|album)\/(.+)$/i);
    if (!match?.[1]) return normalized;
    return `/album/${match[1]}`;
};

const toTrackNameKey = (pathOrName?: string | null) => {
    const normalized = normalizeTrackPathForMatch(pathOrName);
    const base = normalized
        ? normalized.split('/').pop() || ''
        : normalizeCompareValue(String(pathOrName || ''));
    const withoutExt = base.replace(/\.[a-z0-9]{1,5}$/i, '');
    return withoutExt
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

type ParsedTrackShareTarget = {
    raw: string;
    pathTarget: string;
    aliasTarget: string;
    nameKey: string;
    numberTarget: number | null;
};

const parseTrackShareTarget = (raw?: string | null): ParsedTrackShareTarget => {
    const input = String(raw || '').trim();
    if (!input) {
        return {
            raw: '',
            pathTarget: '',
            aliasTarget: '',
            nameKey: '',
            numberTarget: null,
        };
    }

    let pathPart = input;
    let numberTarget: number | null = null;
    const mixedMatch = input.match(/^n:(\d+)\|(.*)$/i);
    if (mixedMatch) {
        numberTarget = Number.parseInt(mixedMatch[1], 10);
        pathPart = String(mixedMatch[2] || '').trim();
    } else {
        const numberOnlyMatch = input.match(/^n:(\d+)$/i);
        if (numberOnlyMatch) {
            numberTarget = Number.parseInt(numberOnlyMatch[1], 10);
            pathPart = '';
        }
    }
    if (numberTarget === null || !Number.isFinite(numberTarget) || numberTarget <= 0) {
        numberTarget = null;
    }

    const pathTarget = normalizeTrackPathForMatch(pathPart);
    return {
        raw: input,
        pathTarget,
        aliasTarget: toAlbumPathAlias(pathTarget),
        nameKey: toTrackNameKey(pathTarget || pathPart),
        numberTarget,
    };
};

type PlaylistPickerState = {
    open: boolean;
    mode: 'track' | 'album' | 'queue';
    tracks: any[];
};

type PlaylistAddResult = {
    playlistId: string;
    playlistFound: boolean;
    requestedCount: number;
    uniqueSelectedCount: number;
    addedCount: number;
    existingCount: number;
    addedTrackKeys: string[];
};

type PlaylistRemoveResult = {
    playlistId: string;
    playlistFound: boolean;
    requestedCount: number;
    uniqueSelectedCount: number;
    removedCount: number;
    missingCount: number;
    removedTrackKeys: string[];
};

type PlaylistCreateAndAddResult = {
    playlistId: string | null;
    created: boolean;
    requestedCount: number;
    uniqueSelectedCount: number;
    addedCount: number;
    existingCount: number;
    addedTrackKeys: string[];
};

type SharedPlaylistMode = 'none' | 'server' | 'hash';
type SharedPlaylistStatus = 'idle' | 'loading' | 'ready' | 'error' | 'not_found';
type InlineToastTone = 'success' | 'error';
type PlaylistShareReuseCacheEntry = {
    shareId: string;
    updatedAt: number;
    contentHash?: string;
};
type PlaylistShareReuseCache = Record<string, PlaylistShareReuseCacheEntry[]>;
type PlaylistShareSecretEntry = {
    updatedAt: number;
    editToken?: string;
    shareKey?: string;
};

const DEFAULT_SEARCH_FILTERS: SearchFilters = {
    q: '',
    sort: 'relevance',
    album_type: '',
    album_year: '',
    album_category: '',
    result: '',
};

const DEFAULT_SEARCH_OPTIONS: SearchFilterOptions = {
    sort: [],
    albumType: [],
    albumYear: [],
    albumCategory: [],
};

const DEFAULT_SEARCH_PAGINATION: SearchPagination = {
    currentPage: 1,
    totalPages: 1,
    prevResult: null,
    nextResult: null,
};

const FALLBACK_SORT_OPTIONS: SearchFilterOption[] = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'name', label: 'Name' },
    { value: 'timestamp', label: 'Date Added' },
    { value: 'popularity', label: 'Popularity' },
    { value: 'year', label: 'Year' },
];

const DEFAULT_BROWSE_PAGINATION: BrowsePagination = {
    currentPage: 1,
    totalPages: 1,
    prevPage: null,
    nextPage: null,
};

const BROWSE_ALBUM_SHORTCUTS: Array<{ key: BrowseSectionKey; label: string }> = [
    { key: 'browse_all', label: 'Browse All' },
    { key: 'top40', label: 'Top 40' },
    { key: 'top1000_all_time', label: 'Top 1000 All Time' },
    { key: 'top100_last_6_months', label: 'Top 100 Last 6 Months' },
    { key: 'top100_newly_added', label: 'Top 100 Newly Added' },
    { key: 'currently_viewed', label: 'Currently Viewed' },
    { key: 'most_favorites', label: 'Most Favorites' },
];

const BROWSE_TYPE_OPTIONS: Array<{ slug: string; label: string }> = [
    { slug: 'gamerips', label: 'Gamerips' },
    { slug: 'ost', label: 'Soundtracks' },
    { slug: 'singles', label: 'Singles' },
    { slug: 'arrangements', label: 'Arrangements' },
    { slug: 'remixes', label: 'Remixes' },
    { slug: 'compilations', label: 'Compilations' },
    { slug: 'inspired-by', label: 'Inspired By' },
];

const BROWSE_SECTION_KEYS = new Set<BrowseSectionKey>([
    'browse_all',
    'top40',
    'top1000_all_time',
    'top100_last_6_months',
    'top100_newly_added',
    'currently_viewed',
    'most_favorites',
    'requests',
    'type',
    'year',
    'random_album',
    'random_album_advanced',
    'random_song',
]);

const BROWSE_TYPE_SLUGS = new Set<string>(BROWSE_TYPE_OPTIONS.map((option) => option.slug.toLowerCase()));

const coerceBrowsePage = (raw?: string | null) => {
    const parsed = Number.parseInt(String(raw || ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, 500);
};

const parseBrowseRouteFromSearch = (search: string) => {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const rawSection = String(params.get('section') || 'browse_all').trim().toLowerCase() as BrowseSectionKey;
    let section: BrowseSectionKey = BROWSE_SECTION_KEYS.has(rawSection) ? rawSection : 'browse_all';
    let slug = String(params.get('slug') || '').trim().toLowerCase();

    if (section === 'year') {
        if (!/^\d{4}$/.test(slug)) {
            section = 'browse_all';
            slug = '';
        }
    } else if (section === 'type') {
        if (!BROWSE_TYPE_SLUGS.has(slug)) {
            section = 'browse_all';
            slug = '';
        }
    } else {
        slug = '';
    }

    const page = coerceBrowsePage(params.get('page'));
    return { section, slug, page };
};

const getBrowseRouteUrl = (section: BrowseSectionKey, options?: { slug?: string; page?: number }) => {
    const normalizedSection = BROWSE_SECTION_KEYS.has(section) ? section : 'browse_all';
    const rawSlug = String(options?.slug || '').trim().toLowerCase();
    const page = coerceBrowsePage(String(options?.page || 1));
    const params = new URLSearchParams();

    let slug = '';
    if (normalizedSection === 'year' && /^\d{4}$/.test(rawSlug)) {
        slug = rawSlug;
    } else if (normalizedSection === 'type' && BROWSE_TYPE_SLUGS.has(rawSlug)) {
        slug = rawSlug;
    }

    if (normalizedSection !== 'browse_all' || slug || page > 1) {
        params.set('section', normalizedSection);
    }
    if (slug) params.set('slug', slug);
    if (page > 1) params.set('page', String(page));

    const path = getPathForView('browse');
    return params.toString() ? `${path}?${params.toString()}` : path;
};

const SIDEBAR_PUSH_MS = 260;
const TRACKLIST_VIRTUALIZATION_MIN_ITEMS = 120;
const TRACKLIST_VIRTUALIZATION_MIN_ITEMS_MOBILE = 80;
const TRACKLIST_VIRTUALIZATION_OVERSCAN_ROWS = 12;
const TRACKLIST_VIRTUALIZATION_FALLBACK_ROW_HEIGHT = 56;
const TRACKLIST_LIGHTWEIGHT_TITLE_MIN_ITEMS = 700;
const HOME_FEED_LIGHTWEIGHT_TEXT_MIN_ITEMS = 220;
const HOME_FEED_LIGHTWEIGHT_TEXT_MIN_ITEMS_MOBILE = 120;
const HOME_FEED_VIRTUALIZATION_MIN_ITEMS = 120;
const HOME_FEED_VIRTUALIZATION_MIN_ITEMS_MOBILE = 48;
const HOME_FEED_VIRTUALIZATION_OVERSCAN_ROWS = 4;
const HOME_FEED_VIRTUALIZATION_FALLBACK_ROW_HEIGHT = 296;
const HOME_FEED_VIRTUALIZATION_INITIAL_ROWS = 16;
const ALBUM_COMMENTS_COLLAPSED_COUNT = 6;
const PLAYLIST_ADD_FEEDBACK_MS = 2000;
const LIKED_EXPAND_VIRTUALIZATION_MIN_ITEMS = 60;
const LIKED_EXPAND_VIRTUALIZATION_OVERSCAN_ROWS = 8;
const LIKED_EXPAND_VIRTUALIZATION_RETAIN_ROWS = 4;
const LIKED_EXPAND_VIRTUALIZATION_MIN_WINDOW = 28;
const LIKED_EXPAND_VIRTUALIZATION_INITIAL_WINDOW = 64;
const LIKED_EXPAND_VIRTUALIZATION_ROW_HEIGHT_DESKTOP = 52;
const LIKED_EXPAND_VIRTUALIZATION_ROW_HEIGHT_MOBILE = 40;
const LIKED_EXPAND_VIRTUALIZATION_FALLBACK_ROW_HEIGHT = LIKED_EXPAND_VIRTUALIZATION_ROW_HEIGHT_DESKTOP;
const LIKED_EXPAND_VIRTUALIZATION_ENABLED = true;
const PLAYLIST_SHARE_REUSE_CACHE_KEY = 'kh_playlist_share_reuse_v1';
const PLAYLIST_SHARE_REUSE_CACHE_LIMIT = 300;
const PLAYLIST_SHARE_HINT_ON_SHARE_SEEN_KEY = 'kh_playlist_share_hint_on_share_seen_v1';
const PLAYLIST_SHARE_HINT_ON_OPEN_SEEN_KEY = 'kh_playlist_share_hint_on_open_seen_v1';
const SHARED_PLAYLIST_INVALIDATION_EVENT_KEY = 'kh_shared_playlist_invalidate_v1';
const SHARED_PLAYLIST_REVALIDATE_INTERVAL_MS = 15000;
const LIKED_META_CACHE_MAX_ENTRIES = 300;
const DL_UI_UPDATE_MIN_INTERVAL_MS = 96;
const PERF_QUEUE_TOGGLE_START_MARK = 'perf_queue_toggle_start';
const PERF_QUEUE_VISIBLE_MARK = 'perf_queue_visible';
const PERF_QUEUE_CLOSE_START_MARK = 'perf_queue_close_start';
const PERF_QUEUE_HIDDEN_MARK = 'perf_queue_hidden';
const PERF_QUEUE_ENQUEUE_START_MARK = 'perf_queue_enqueue_start';
const PERF_QUEUE_ENQUEUE_COMMIT_MARK = 'perf_queue_enqueue_commit';
const PERF_QUEUE_FIRST_ROW_PAINT_MARK = 'perf_queue_first_row_paint';
const PERF_QUEUE_TOGGLE_MEASURE = 'perf_queue_toggle_to_visible';
const PERF_QUEUE_CLOSE_MEASURE = 'perf_queue_close_to_hidden';
const PERF_QUEUE_ENQUEUE_MEASURE = 'perf_queue_enqueue_commit';
const PERF_QUEUE_FIRST_ROW_MEASURE = 'perf_queue_visible_to_first_row';
const PERF_GALLERY_OPEN_START_MARK = 'perf_gallery_open_start';
const PERF_GALLERY_VISIBLE_MARK = 'perf_gallery_visible';
const PERF_GALLERY_FIRST_IMAGE_MARK = 'perf_gallery_first_image_loaded';
const PERF_GALLERY_OPEN_MEASURE = 'perf_gallery_open_to_visible';
const PERF_GALLERY_FIRST_IMAGE_MEASURE = 'perf_gallery_visible_to_first_image';

const normalizePlaylistShareReuseCacheEntry = (
    rawEntry: any,
    fallbackUpdatedAt = Date.now()
): PlaylistShareReuseCacheEntry | null => {
    const shareId = String(rawEntry?.shareId || '').trim();
    if (!SHARED_PLAY_ID_REGEX.test(shareId)) return null;

    const updatedAtRaw = Number(rawEntry?.updatedAt);
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
        ? Math.floor(updatedAtRaw)
        : fallbackUpdatedAt;

    const contentHash = String(rawEntry?.contentHash || '').trim();
    return {
        shareId,
        updatedAt,
        ...(contentHash ? { contentHash } : {}),
    };
};

const dedupePlaylistShareReuseEntries = (entries: PlaylistShareReuseCacheEntry[]) => {
    const byShareId = new Map<string, PlaylistShareReuseCacheEntry>();
    entries.forEach((entry, index) => {
        const normalized = normalizePlaylistShareReuseCacheEntry(entry, Date.now() - index);
        if (!normalized) return;

        const previous = byShareId.get(normalized.shareId);
        if (!previous) {
            byShareId.set(normalized.shareId, normalized);
            return;
        }

        const updatedAt = Math.max(previous.updatedAt, normalized.updatedAt);
        const contentHash = String(normalized.contentHash || previous.contentHash || '').trim();
        byShareId.set(normalized.shareId, {
            shareId: normalized.shareId,
            updatedAt,
            ...(contentHash ? { contentHash } : {}),
        });
    });

    return [...byShareId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
};

const normalizePlaylistShareReuseCache = (rawCache: any): PlaylistShareReuseCache => {
    if (!rawCache || typeof rawCache !== 'object') return {};

    const normalized: PlaylistShareReuseCache = {};
    Object.entries(rawCache).forEach(([rawPlaylistId, rawEntries]) => {
        const playlistId = String(rawPlaylistId || '').trim();
        if (!playlistId) return;

        const entriesInput = Array.isArray(rawEntries)
            ? rawEntries
            : (rawEntries && typeof rawEntries === 'object' ? [rawEntries] : []);
        const entries = dedupePlaylistShareReuseEntries(entriesInput as PlaylistShareReuseCacheEntry[]);
        if (entries.length === 0) return;
        normalized[playlistId] = entries;
    });

    return normalized;
};

const prunePlaylistShareReuseCache = (cache: PlaylistShareReuseCache): PlaylistShareReuseCache => {
    const flattened: Array<{ playlistId: string; entry: PlaylistShareReuseCacheEntry }> = [];

    Object.entries(normalizePlaylistShareReuseCache(cache)).forEach(([playlistId, entries]) => {
        entries.forEach((entry) => {
            flattened.push({ playlistId, entry });
        });
    });

    flattened.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
    const kept = flattened.slice(0, PLAYLIST_SHARE_REUSE_CACHE_LIMIT);

    const next: PlaylistShareReuseCache = {};
    kept.forEach(({ playlistId, entry }) => {
        if (!next[playlistId]) next[playlistId] = [];
        next[playlistId].push(entry);
    });

    Object.keys(next).forEach((playlistId) => {
        const deduped = dedupePlaylistShareReuseEntries(next[playlistId] || []);
        if (deduped.length > 0) {
            next[playlistId] = deduped;
        } else {
            delete next[playlistId];
        }
    });

    return next;
};

const readPlaylistShareReuseCache = (storage: Storage | null | undefined): PlaylistShareReuseCache => {
    if (!storage) return {};
    try {
        const rawCache = storage.getItem(PLAYLIST_SHARE_REUSE_CACHE_KEY);
        if (!rawCache) return {};
        const parsed = JSON.parse(rawCache);
        return prunePlaylistShareReuseCache(normalizePlaylistShareReuseCache(parsed));
    } catch {
        return {};
    }
};

const writePlaylistShareReuseCache = (
    storage: Storage | null | undefined,
    cache: PlaylistShareReuseCache
) => {
    if (!storage) return;
    try {
        const normalized = prunePlaylistShareReuseCache(normalizePlaylistShareReuseCache(cache));
        if (Object.keys(normalized).length === 0) {
            storage.removeItem(PLAYLIST_SHARE_REUSE_CACHE_KEY);
            return;
        }
        storage.setItem(PLAYLIST_SHARE_REUSE_CACHE_KEY, JSON.stringify(normalized));
    } catch {
    }
};

const upsertPlaylistShareReuseCacheEntry = (
    cache: PlaylistShareReuseCache,
    playlistId: string,
    rawEntry: PlaylistShareReuseCacheEntry
) => {
    const normalizedPlaylistId = String(playlistId || '').trim();
    if (!normalizedPlaylistId) return prunePlaylistShareReuseCache(normalizePlaylistShareReuseCache(cache));

    const normalizedEntry = normalizePlaylistShareReuseCacheEntry(rawEntry);
    if (!normalizedEntry) return prunePlaylistShareReuseCache(normalizePlaylistShareReuseCache(cache));

    const nextCache = normalizePlaylistShareReuseCache(cache);
    const existingEntries = Array.isArray(nextCache[normalizedPlaylistId]) ? nextCache[normalizedPlaylistId] : [];
    nextCache[normalizedPlaylistId] = dedupePlaylistShareReuseEntries([
        ...existingEntries,
        normalizedEntry,
    ]);

    return prunePlaylistShareReuseCache(nextCache);
};

const removePlaylistShareReuseCacheEntries = (cache: PlaylistShareReuseCache, playlistId: string) => {
    const normalizedPlaylistId = String(playlistId || '').trim();
    const normalizedCache = normalizePlaylistShareReuseCache(cache);
    if (!normalizedPlaylistId || !normalizedCache[normalizedPlaylistId]) {
        return prunePlaylistShareReuseCache(normalizedCache);
    }

    const { [normalizedPlaylistId]: _removed, ...remaining } = normalizedCache;
    return prunePlaylistShareReuseCache(remaining);
};

const notifySharedPlaylistInvalidation = (storage: Storage | null | undefined, shareIds: string[]) => {
    if (!storage) return;
    const uniqueShareIds = Array.from(
        new Set(
            shareIds
                .map((shareId) => String(shareId || '').trim())
                .filter((shareId) => SHARED_PLAY_ID_REGEX.test(shareId))
        )
    );
    if (uniqueShareIds.length === 0) return;

    try {
        storage.setItem(SHARED_PLAYLIST_INVALIDATION_EVENT_KEY, JSON.stringify({
            shareIds: uniqueShareIds,
            at: Date.now(),
        }));
    } catch {
    }
};

const readLikedMetaCacheTimestamp = (value: any, fallback: number) => {
    const direct = Number(value?.__cacheTs);
    if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
    const fetchedAt = Number(value?.fetchedAt);
    if (Number.isFinite(fetchedAt) && fetchedAt > 0) return Math.floor(fetchedAt);
    return fallback;
};

const withLikedMetaCacheTimestamp = (value: any, fallback: number) => {
    if (!value || typeof value !== 'object') return value;
    const ts = readLikedMetaCacheTimestamp(value, fallback);
    if (Number(value.__cacheTs) === ts) return value;
    return { ...value, __cacheTs: ts };
};

const pruneLikedAlbumMetaCache = (raw: Record<string, any>, maxEntries: number) => {
    const entries = Object.entries(raw)
        .filter(([, value]) => !!value && typeof value === 'object')
        .map(([key, value], index) => {
            const fallbackTs = Date.now() - index;
            const ts = readLikedMetaCacheTimestamp(value, fallbackTs);
            return [key, withLikedMetaCacheTimestamp(value, ts), ts] as const;
        })
        .sort((a, b) => b[2] - a[2]);

    const limit = Math.max(1, Math.floor(maxEntries));
    const next: Record<string, any> = {};
    for (let index = 0; index < entries.length && index < limit; index += 1) {
        const [key, value] = entries[index];
        next[key] = value;
    }
    return next;
};

const markPerf = (markName: string) => {
    if (typeof window === 'undefined') return;
    if (!window.performance?.mark) return;
    try {
        window.performance.clearMarks(markName);
        window.performance.mark(markName);
    } catch {
    }
};

const measurePerf = (measureName: string, startMark: string, endMark: string) => {
    if (typeof window === 'undefined') return;
    if (!window.performance?.measure) return;
    try {
        window.performance.measure(measureName, startMark, endMark);
        if (process.env.NODE_ENV === 'development') {
            const entries = window.performance.getEntriesByName(measureName);
            const latest = entries[entries.length - 1];
            if (latest) {
                console.info(`[perf:measure] ${measureName} ${latest.duration.toFixed(1)}ms`);
            }
        }
    } catch {
    } finally {
        try {
            window.performance.clearMeasures(measureName);
            window.performance.clearMarks(startMark);
            window.performance.clearMarks(endMark);
        } catch {
        }
    }
};

const areProgressMapsEqual = (a: Record<string, number>, b: Record<string, number>) => {
    if (a === b) return true;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!(key in b)) return false;
        if (a[key] !== b[key]) return false;
    }
    return true;
};

const isSameAlbumDownloadSnapshot = (a: any, b: any) => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
        String(a?.id || '') === String(b?.id || '') &&
        Number(a?.progress ?? -1) === Number(b?.progress ?? -1) &&
        String(a?.statusText || '') === String(b?.statusText || '')
    );
};

const normalizeSearchFilterValue = (raw: unknown) => {
    const value = String(raw ?? '').trim();
    if (!value || value === '0') return '';
    return value;
};

const getSearchResultKey = (item: any) => {
    const albumId = normalizeAlbumId(item?.albumId || item?.url);
    if (albumId) return `id:${albumId}`;
    const rawUrl = String(item?.url || '').trim().toLowerCase();
    if (rawUrl) return `url:${rawUrl}`;
    const fallback = String(item?.id || item?.title || '').trim().toLowerCase();
    return fallback ? `fallback:${fallback}` : '';
};

const sortTracksForPlayback = (tracks: any[] = []) => {
    return [...tracks].sort((a: any, b: any) => {
        const an = Number(a?.number || 0);
        const bn = Number(b?.number || 0);
        if (an !== bn) return an - bn;
        return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
};

const prepareLikedTracksForPlayback = (group: any) => {
    const fallbackArt = String(group?.albumArt || '').trim();
    const fallbackName = String(group?.albumName || 'Unknown Album').trim() || 'Unknown Album';
    const fallbackUrl = String(group?.albumUrl || '').trim();
    const fallbackAlbumId = normalizeAlbumId(group?.albumId || fallbackUrl || fallbackArt);

    const normalized = (Array.isArray(group?.tracks) ? group.tracks : []).map((raw: any) => {
        const base = normalizeLikedTrack(raw);
        const albumArt = String(base?.albumArt || fallbackArt || '').trim();
        const thumbnail = String(base?.thumbnail || albumArt || '').trim();
        const albumUrl = String(base?.albumUrl || fallbackUrl || '').trim();
        const albumId = normalizeAlbumId(base?.albumId || albumUrl || albumArt || base?.url || fallbackAlbumId);
        return {
            ...base,
            albumName: base?.albumName || fallbackName,
            albumArt,
            thumbnail,
            albumUrl,
            albumId: albumId || undefined,
        };
    });

    return sortTracksForPlayback(normalized);
};

const getPlaybackTrackKey = (track: any) => {
    const urlKey = String(track?.url || '').trim();
    if (urlKey) return `url:${urlKey}`;
    const titleKey = String(track?.title || '').trim().toLowerCase();
    const albumKey = String(track?.albumName || '').trim().toLowerCase();
    return `meta:${titleKey}|${albumKey}`;
};

const isSamePlaybackTrack = (a: any, b: any) => {
    return getPlaybackTrackKey(a) === getPlaybackTrackKey(b);
};

export default function HomePage() {
    const [view, setView] = useState<AppView>('home');
    const [query, setQuery] = useState('');
    const [isSearchInputFocused, setIsSearchInputFocused] = useState(false);
    const [activeSearchTerm, setActiveSearchTerm] = useState('');
    const [results, setResults] = useState<any[]>([]);
    const [searchFilters, setSearchFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS);
    const [searchOptions, setSearchOptions] = useState<SearchFilterOptions>(DEFAULT_SEARCH_OPTIONS);
    const [searchPagination, setSearchPagination] = useState<SearchPagination>(DEFAULT_SEARCH_PAGINATION);
    const [searchTotalMatches, setSearchTotalMatches] = useState<number | null>(null);
    const [isSearchAppending, setIsSearchAppending] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isSidebarVisible, setIsSidebarVisible] = useState(true);
    const [isSidebarShifted, setIsSidebarShifted] = useState(false);
    const [isSidebarHandoff, setIsSidebarHandoff] = useState(false);
    const [selectedAlbum, setSelectedAlbum] = useState<any>(null);
    const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [qualityPref, setQualityPref] = useState<AudioQualityPreference>('best');
    const [latestUpdates, setLatestUpdates] = useState<any[]>([]);
    const [homeCardArt, setHomeCardArt] = useState<Record<string, HomeCardData>>({});
    const [browseSection, setBrowseSection] = useState<BrowseSectionKey>('browse_all');
    const [browseSlug, setBrowseSlug] = useState('');
    const [browseItems, setBrowseItems] = useState<BrowseAlbumItem[]>([]);
    const [browseTopItems, setBrowseTopItems] = useState<BrowseAlbumItem[]>([]);
    const [browseTopItemsLabel, setBrowseTopItemsLabel] = useState('');
    const [browsePagination, setBrowsePagination] = useState<BrowsePagination>(DEFAULT_BROWSE_PAGINATION);
    const [browseTotalItems, setBrowseTotalItems] = useState<number | null>(null);
    const [browseLabel, setBrowseLabel] = useState('Browse All');
    const [browseNotice, setBrowseNotice] = useState('');
    const [browseLoading, setBrowseLoading] = useState(false);
    const [showAllBrowseYears, setShowAllBrowseYears] = useState(false);
    const [isBrowseToolbarOpenMobile, setIsBrowseToolbarOpenMobile] = useState(false);
    const [isSearchFiltersOpenMobile, setIsSearchFiltersOpenMobile] = useState(false);
    const [isAlbumCommentsOpenMobile, setIsAlbumCommentsOpenMobile] = useState(false);

    const [trackProgressByKey, setTrackProgressByKey] = useState<Record<string, number>>({});
    const [albumProgress, setAlbumProgress] = useState<any>(null);
    const [albumIsQueued, setAlbumIsQueued] = useState(false);
    const [albumQueueItemId, setAlbumQueueItemId] = useState<string | null>(null);
    const [queueCount, setQueueCount] = useState(0);
    const [pageShowSignal, setPageShowSignal] = useState(0);

    const [isClient, setIsClient] = useState(false);
    const [hasInitialRouteSync, setHasInitialRouteSync] = useState(false);
    const [playerMode, setPlayerMode] = useState<'standard' | 'minimized'>('standard');
    const [currentTrack, setCurrentTrack] = useState<any>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isAudioLoading, setIsAudioLoading] = useState(false);
    const [audioDuration, setAudioDuration] = useState(0);
    const [volume, setVolume] = useState(0.8);
    const [playbackRate, setPlaybackRate] = useState(1.0);
    const [isRepeatEnabled, setIsRepeatEnabled] = useState(false);
    const [queue, setQueue] = useState<any[]>([]);
    const [currentTrackIndex, setCurrentTrackIndex] = useState(-1);
    const currentTrackIndexRef = useRef(-1);
    const [playbackSourceLabel, setPlaybackSourceLabel] = useState('');
    const playbackSourceLabelRef = useRef('');
    const [isMobileFullScreen, setMobileFullScreen] = useState(false);
    const lastStableUrlRef = useRef('');
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const galleryHostRef = useRef<GalleryPortalHostHandle | null>(null);
    const queueOverlayHostRef = useRef<QueueOverlayHostHandle | null>(null);
    const toggleQueueOverlay = useCallback(() => {
        queueOverlayHostRef.current?.toggle();
    }, []);
    const setCurrentTrackIndexWithRef = useCallback((nextIndex: number) => {
        currentTrackIndexRef.current = nextIndex;
        setCurrentTrackIndex(nextIndex);
    }, []);
    const handleQueueOverlayOpenRequest = useCallback(() => {
        markPerf(PERF_QUEUE_TOGGLE_START_MARK);
    }, []);
    const handleQueueOverlayCloseRequest = useCallback(() => {
        markPerf(PERF_QUEUE_CLOSE_START_MARK);
    }, []);
    const handleQueueOverlayVisibilityApplied = useCallback((visible: boolean) => {
        if (visible) {
            markPerf(PERF_QUEUE_VISIBLE_MARK);
            measurePerf(PERF_QUEUE_TOGGLE_MEASURE, PERF_QUEUE_TOGGLE_START_MARK, PERF_QUEUE_VISIBLE_MARK);
            return;
        }
        markPerf(PERF_QUEUE_HIDDEN_MARK);
        measurePerf(PERF_QUEUE_CLOSE_MEASURE, PERF_QUEUE_CLOSE_START_MARK, PERF_QUEUE_HIDDEN_MARK);
    }, []);
    const handleQueueOverlayFirstRowPainted = useCallback(() => {
        markPerf(PERF_QUEUE_FIRST_ROW_PAINT_MARK);
        measurePerf(PERF_QUEUE_FIRST_ROW_MEASURE, PERF_QUEUE_VISIBLE_MARK, PERF_QUEUE_FIRST_ROW_PAINT_MARK);
    }, []);
    const handleQueueProfilerRender = useCallback<React.ProfilerOnRenderCallback>((id, phase, actualDuration) => {
        if (process.env.NODE_ENV !== 'development') return;
        if (actualDuration < 8) return;
        console.info(`[perf:react] ${id} ${phase} ${actualDuration.toFixed(1)}ms`);
    }, []);
    const handleGalleryVisibilityApplied = useCallback((visible: boolean) => {
        if (!visible) return;
        markPerf(PERF_GALLERY_VISIBLE_MARK);
        measurePerf(PERF_GALLERY_OPEN_MEASURE, PERF_GALLERY_OPEN_START_MARK, PERF_GALLERY_VISIBLE_MARK);
    }, []);
    const handleGalleryFirstImageLoaded = useCallback(() => {
        markPerf(PERF_GALLERY_FIRST_IMAGE_MARK);
        measurePerf(PERF_GALLERY_FIRST_IMAGE_MEASURE, PERF_GALLERY_VISIBLE_MARK, PERF_GALLERY_FIRST_IMAGE_MARK);
    }, []);
    const getLocationKey = useCallback(() => {
        if (typeof window === 'undefined') return '';
        return `${window.location.pathname}${window.location.search}${window.location.hash}`;
    }, []);
    useEffect(() => {
        if (!isClient) return;
        lastStableUrlRef.current = getLocationKey();
    });
    const openSelectedAlbumGallery = useCallback(() => {
        const albumImages = Array.isArray(selectedAlbum?.albumImages) ? selectedAlbum.albumImages : [];
        const albumThumbs = Array.isArray(selectedAlbum?.imagesThumbs) ? selectedAlbum.imagesThumbs : [];
        if (albumImages.length === 0 && albumThumbs.length === 0) return;
        markPerf(PERF_GALLERY_OPEN_START_MARK);
        galleryHostRef.current?.open({
            images: albumImages.length > 0 ? albumImages : albumThumbs,
            thumbs: albumThumbs,
            initialIndex: 0,
        });
    }, [selectedAlbum]);
    const [trackFilterQuery, setTrackFilterQuery] = useState('');
    const [isDesktopViewport, setIsDesktopViewport] = useState(false);
    const previousIsDesktopViewportRef = useRef<boolean | null>(null);
    const [virtualTrackRowHeight, setVirtualTrackRowHeight] = useState(TRACKLIST_VIRTUALIZATION_FALLBACK_ROW_HEIGHT);
    const [virtualTrackRange, setVirtualTrackRange] = useState<{ start: number; end: number }>({ start: 0, end: -1 });
    const [virtualHomeGridRowHeight, setVirtualHomeGridRowHeight] = useState(HOME_FEED_VIRTUALIZATION_FALLBACK_ROW_HEIGHT);
    const [virtualHomeGridColumns, setVirtualHomeGridColumns] = useState(1);
    const [virtualHomeGridRange, setVirtualHomeGridRange] = useState<{ start: number; end: number }>({ start: 0, end: -1 });
    const [isAlbumDescExpanded, setIsAlbumDescExpanded] = useState(false);
    const [isAlbumDescOverflowing, setIsAlbumDescOverflowing] = useState(false);
    const [albumDescCollapsedText, setAlbumDescCollapsedText] = useState('');
    const [isAllCommentsVisible, setIsAllCommentsVisible] = useState(false);

    const closeMobileSearchInput = useCallback(() => {
        searchInputRef.current?.blur();
        setIsSearchInputFocused(false);
    }, []);
    const shouldTrapSearchBackForKeyboard = !isDesktopViewport && isSearchInputFocused;

    useHistoryState('search-input-focus', shouldTrapSearchBackForKeyboard, closeMobileSearchInput);
    useHistoryState('player', isMobileFullScreen, () => setMobileFullScreen(false));

    const [likedTracks, setLikedTracks] = useState<LikedTrack[]>([]);
    const [likedExpandedKey, setLikedExpandedKey] = useState<string | null>(null);
    const [likedGridColumns, setLikedGridColumns] = useState(4);
    const [likedExpandVirtualRowHeight, setLikedExpandVirtualRowHeight] = useState(LIKED_EXPAND_VIRTUALIZATION_FALLBACK_ROW_HEIGHT);
    const [likedExpandVirtualRange, setLikedExpandVirtualRange] = useState<{ start: number; end: number }>({ start: 0, end: -1 });
    const [likedExpandVirtualizationDisabled, setLikedExpandVirtualizationDisabled] = useState(false);
    const [likedAlbumMetaCache, setLikedAlbumMetaCache] = useState<Record<string, any | null>>({});
    const [likedAlbumMetaLoading, setLikedAlbumMetaLoading] = useState<Record<string, boolean>>({});
    const [likedAlbumMetaError, setLikedAlbumMetaError] = useState<Record<string, string>>({});
    const [playlists, setPlaylists] = useState<Playlist[]>(() => {
        if (typeof window === 'undefined') return [];
        try { return loadPlaylistsFromStorage(window.localStorage); } catch { return []; }
    });
    const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        try {
            const saved = loadPlaylistsFromStorage(window.localStorage);
            return saved.length > 0 ? saved[0].id : null;
        } catch { return null; }
    });
    const [playlistRouteIdentifier, setPlaylistRouteIdentifier] = useState<string | null>(null);
    const [sharedPlaylistMode, setSharedPlaylistMode] = useState<SharedPlaylistMode>('none');
    const [sharedPlaylistStatus, setSharedPlaylistStatus] = useState<SharedPlaylistStatus>('idle');
    const [sharedPlaylistData, setSharedPlaylistData] = useState<SharedPlaylistRecordV1 | null>(null);
    const [sharedPlaylistServerKey, setSharedPlaylistServerKey] = useState('');
    const [playlistPickerState, setPlaylistPickerState] = useState<PlaylistPickerState>({
        open: false,
        mode: 'track',
        tracks: [],
    });
    const [playlistStorageWarning, setPlaylistStorageWarning] = useState('');
    const [playlistAddFeedbackByTrackKey, setPlaylistAddFeedbackByTrackKey] = useState<Record<string, number>>({});
    const [playlistAddToastMessage, setPlaylistAddToastMessage] = useState('');
    const [playlistAddToastTone, setPlaylistAddToastTone] = useState<InlineToastTone>('success');
    const [appNotice, setAppNotice] = useState<{
        title: string;
        message: string;
        suppressKey?: string;
        suppressLabel?: string;
    } | null>(null);
    const [appNoticeSuppressChecked, setAppNoticeSuppressChecked] = useState(false);
    const [isAlbumPlaylistFeedbackActive, setIsAlbumPlaylistFeedbackActive] = useState(false);
    const [pendingSharedTrackSignal, setPendingSharedTrackSignal] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const playlistImportInputRef = useRef<HTMLInputElement>(null);
    const homeCardMetaInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
    const homeCardArtRef = useRef<Record<string, HomeCardData>>({});
    const browseRequestSeqRef = useRef(0);
    const browseInitializedRef = useRef(false);
    const browseRouteRequestKeyRef = useRef('');
    const loadBrowseSectionRef = useRef<((section: BrowseSectionKey, options?: {
        slug?: string;
        page?: number;
        historyMode?: 'replace' | 'push' | 'none';
        skipUrlSync?: boolean;
    }) => Promise<void>) | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const albumFetchControllerRef = useRef<AbortController | null>(null);
    const selectAlbumRef = useRef<((item: any, options?: { historyMode?: 'replace' | 'push' | 'none' }) => Promise<void>) | null>(null);
    const hasHydratedInitialSearchRef = useRef(false);
    const panelContentRef = useRef<HTMLDivElement | null>(null);
    const trackListRef = useRef<HTMLDivElement | null>(null);
    const virtualTrackListTopRef = useRef(0);
    const virtualTrackScrollRafRef = useRef<number | null>(null);
    const likedExpandTracklistRef = useRef<HTMLDivElement | null>(null);
    const likedExpandVirtualScrollRafRef = useRef<number | null>(null);
    const likedExpandLastInitializedKeyRef = useRef<string | null>(null);
    const likedExpandRangeResetTimestampsRef = useRef<number[]>([]);
    const likedExpandAutoDisableScheduledRef = useRef(false);
    const homeCardGridRef = useRef<HTMLDivElement | null>(null);
    const virtualHomeGridTopRef = useRef(0);
    const virtualHomeGridScrollRafRef = useRef<number | null>(null);
    const searchLoadMoreRef = useRef<HTMLDivElement | null>(null);
    const albumDescRef = useRef<HTMLDivElement | null>(null);
    const albumDescTextRef = useRef<HTMLSpanElement | null>(null);
    const albumDescMeasureRafRef = useRef<number | null>(null);
    const fetchedSearchResultTokensRef = useRef<Set<string>>(new Set());
    const searchResultKeySetRef = useRef<Set<string>>(new Set());
    const isChangingTrackRef = useRef(false);
    const playbackRequestSeqRef = useRef(0);
    const playbackResolveControllerRef = useRef<AbortController | null>(null);
    const sidebarTimersRef = useRef<number[]>([]);
    const sidebarHandoffRafRef = useRef<number | null>(null);
    const playlistAddToastTimeoutRef = useRef<number | null>(null);
    const albumPlaylistFeedbackTimeoutRef = useRef<number | null>(null);
    const playlistAddFeedbackTimersRef = useRef<number[]>([]);
    const queueRef = useRef<Track[]>([]);
    const manualQueueIndexByTrackKeyRef = useRef<Map<string, number>>(new Map());
    const queueEnqueuePendingRef = useRef(false);
    const playlistShareSecretsRef = useRef<Record<string, Record<string, PlaylistShareSecretEntry>>>({});
    const sharedPlaylistLoadSeqRef = useRef(0);
    const pendingSharedTrackTargetRef = useRef<ParsedTrackShareTarget>(parseTrackShareTarget(''));
    const pendingSharedTrackAlbumIdRef = useRef('');

    const selectedAlbumName = useMemo(() => String(selectedAlbum?.name || '').trim(), [selectedAlbum?.name]);
    const dlUpdateRafRef = useRef<number | null>(null);
    const dlUpdateTimerRef = useRef<number | null>(null);
    const dlLastUiUpdateAtRef = useRef(0);
    const loadingDebounceRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (playbackResolveControllerRef.current) {
                playbackResolveControllerRef.current.abort();
                playbackResolveControllerRef.current = null;
            }
            if (playlistAddToastTimeoutRef.current !== null) {
                window.clearTimeout(playlistAddToastTimeoutRef.current);
                playlistAddToastTimeoutRef.current = null;
            }
            if (albumPlaylistFeedbackTimeoutRef.current !== null) {
                window.clearTimeout(albumPlaylistFeedbackTimeoutRef.current);
                albumPlaylistFeedbackTimeoutRef.current = null;
            }
            if (playlistAddFeedbackTimersRef.current.length > 0) {
                playlistAddFeedbackTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
                playlistAddFeedbackTimersRef.current = [];
            }
        };
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const sanitizedCache = readPlaylistShareReuseCache(window.localStorage);
        writePlaylistShareReuseCache(window.localStorage, sanitizedCache);
    }, []);

    const closeAppNotice = useCallback(() => {
        const suppressKey = String(appNotice?.suppressKey || '').trim();
        if (suppressKey && appNoticeSuppressChecked && typeof window !== 'undefined') {
            try {
                window.localStorage.setItem(suppressKey, '1');
            } catch {
            }
        }
        setAppNotice(null);
        setAppNoticeSuppressChecked(false);
    }, [appNotice?.suppressKey, appNoticeSuppressChecked]);

    useEffect(() => {
        setAppNoticeSuppressChecked(false);
    }, [appNotice?.title, appNotice?.message, appNotice?.suppressKey]);

    useEffect(() => {
        if (!appNotice) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeAppNotice();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [appNotice, closeAppNotice]);

    useEffect(() => {
        queueRef.current = queue;
        const manualIndex = new Map<string, number>();
        queue.forEach((queuedTrack: any, idx: number) => {
            if (queuedTrack?.queueSource !== 'manual') return;
            const key = getPlaybackTrackKey(queuedTrack);
            if (!manualIndex.has(key)) manualIndex.set(key, idx);
        });
        manualQueueIndexByTrackKeyRef.current = manualIndex;
        if (!queueEnqueuePendingRef.current) return;
        markPerf(PERF_QUEUE_ENQUEUE_COMMIT_MARK);
        measurePerf(PERF_QUEUE_ENQUEUE_MEASURE, PERF_QUEUE_ENQUEUE_START_MARK, PERF_QUEUE_ENQUEUE_COMMIT_MARK);
        queueEnqueuePendingRef.current = false;
    }, [queue]);

    useEffect(() => {
        currentTrackIndexRef.current = currentTrackIndex;
    }, [currentTrackIndex]);

    useEffect(() => {
        playbackSourceLabelRef.current = playbackSourceLabel;
    }, [playbackSourceLabel]);

    useEffect(() => {
        const queueSnapshot = (Array.isArray(queueRef.current) ? queueRef.current : []) as any[];
        const activeIndex = currentTrackIndexRef.current;
        if (activeIndex < 0 || queueSnapshot.length === 0) return;
        const upcomingTrack = queueSnapshot[activeIndex + 1];
        const upcomingUrl = String(upcomingTrack?.url || '').trim();
        if (!upcomingUrl) return;
        const timerId = window.setTimeout(() => {
            void dlManager.resolveTrackFormats(upcomingUrl).catch(() => { });
        }, 80);
        return () => {
            window.clearTimeout(timerId);
        };
    }, [queue, currentTrackIndex]);

    const showAppNotice = useCallback((
        message: string,
        title = 'Notice',
        options?: { suppressKey?: string; suppressLabel?: string }
    ) => {
        const normalizedMessage = String(message || '').trim() || 'Done.';
        setAppNotice({
            title,
            message: normalizedMessage,
            suppressKey: String(options?.suppressKey || '').trim() || undefined,
            suppressLabel: String(options?.suppressLabel || '').trim() || undefined,
        });
    }, []);

    const showPlaylistShareHint = useCallback((kind: 'share' | 'open') => {
        if (typeof window === 'undefined') return;

        const storageKey =
            kind === 'share'
                ? PLAYLIST_SHARE_HINT_ON_SHARE_SEEN_KEY
                : PLAYLIST_SHARE_HINT_ON_OPEN_SEEN_KEY;

        try {
            if (window.localStorage.getItem(storageKey) === '1') return;
        } catch {
        }

        if (kind === 'share') {
            showAppNotice(
                'This link shares your playlist as it looks right now. If you edit it later, create a new share link to share those updates.',
                'About Shared Links',
                {
                    suppressKey: storageKey,
                    suppressLabel: "Don't show this again",
                }
            );
        } else {
            showAppNotice(
                'This is a shared copy. It can play right away, but it will not update automatically if the original changes. Use "Import to Library" to save your own version.',
                'Shared Playlist',
                {
                    suppressKey: storageKey,
                    suppressLabel: "Don't show this again",
                }
            );
        }
    }, [showAppNotice]);

    const showInlineToast = useCallback((
        message: string,
        tone: InlineToastTone = 'success',
        durationMs = PLAYLIST_ADD_FEEDBACK_MS
    ) => {
        const normalizedMessage = String(message || '').trim();
        if (!normalizedMessage) return;
        setPlaylistAddToastTone(tone);
        setPlaylistAddToastMessage(normalizedMessage);
        if (playlistAddToastTimeoutRef.current !== null) {
            window.clearTimeout(playlistAddToastTimeoutRef.current);
            playlistAddToastTimeoutRef.current = null;
        }
        playlistAddToastTimeoutRef.current = window.setTimeout(() => {
            setPlaylistAddToastMessage('');
            playlistAddToastTimeoutRef.current = null;
        }, durationMs);
    }, []);

    const resetSharedPlaylistState = useCallback(() => {
        sharedPlaylistLoadSeqRef.current += 1;
        setSharedPlaylistMode('none');
        setSharedPlaylistStatus('idle');
        setSharedPlaylistData(null);
        setSharedPlaylistServerKey('');
    }, []);

    const hydrateSharedPlaylistFromLocation = useCallback(async (pathname: string, hashValue: string) => {
        const shareId = getSharedPlaylistShareIdFromPathname(pathname);
        const isHashPath = isSharedPlaylistHashPath(pathname);
        const requestSeq = sharedPlaylistLoadSeqRef.current + 1;
        sharedPlaylistLoadSeqRef.current = requestSeq;

        if (shareId) {
            const decryptionKey = getSharedPlaylistKeyFromHash(hashValue);
            setSharedPlaylistMode('server');
            setSharedPlaylistStatus('loading');
            setSharedPlaylistData(null);
            try {
                const record = await api.getPlaylistShare(shareId, {
                    ...(decryptionKey ? { decryptionKey } : {}),
                });
                if (sharedPlaylistLoadSeqRef.current !== requestSeq) return;
                setSharedPlaylistMode('server');
                setSharedPlaylistStatus('ready');
                setSharedPlaylistData(record);
                setSharedPlaylistServerKey(decryptionKey);
                showPlaylistShareHint('open');
            } catch (error: any) {
                if (sharedPlaylistLoadSeqRef.current !== requestSeq) return;
                const message = String(error?.message || '').toLowerCase();
                setSharedPlaylistMode('server');
                setSharedPlaylistData(null);
                setSharedPlaylistServerKey(decryptionKey);
                setSharedPlaylistStatus(message.includes('not found') ? 'not_found' : 'error');
            }
            return;
        }

        if (isHashPath) {
            setSharedPlaylistMode('hash');
            setSharedPlaylistStatus(String(hashValue || '').trim() ? 'error' : 'idle');
            setSharedPlaylistData(null);
            setSharedPlaylistServerKey('');
            return;
        }

        setSharedPlaylistMode('none');
        setSharedPlaylistStatus('idle');
        setSharedPlaylistData(null);
        setSharedPlaylistServerKey('');
    }, [showPlaylistShareHint]);

    useEffect(() => {
        if (sharedPlaylistMode !== 'server' || sharedPlaylistStatus !== 'ready') return;
        const shareId = String(sharedPlaylistData?.shareId || '').trim();
        if (!shareId || !SHARED_PLAY_ID_REGEX.test(shareId)) return;
        if (typeof window === 'undefined') return;

        let cancelled = false;
        let timerId: number | null = null;

        const revalidate = async () => {
            if (cancelled) return;
            try {
                const record = await api.getPlaylistShare(shareId, {
                    ...(sharedPlaylistServerKey ? { decryptionKey: sharedPlaylistServerKey } : {}),
                });
                if (cancelled) return;
                setSharedPlaylistMode('server');
                setSharedPlaylistStatus('ready');
                setSharedPlaylistData(record);
                schedule();
            } catch (error: any) {
                if (cancelled) return;
                const message = String(error?.message || '').toLowerCase();
                if (message.includes('not found')) {
                    setSharedPlaylistMode('server');
                    setSharedPlaylistData(null);
                    setSharedPlaylistStatus('not_found');
                    window.location.reload();
                    return;
                }
                schedule();
            }
        };

        const schedule = () => {
            if (cancelled) return;
            timerId = window.setTimeout(() => {
                void revalidate();
            }, SHARED_PLAYLIST_REVALIDATE_INTERVAL_MS);
        };

        const handleVisibilityChange = () => {
            if (cancelled) return;
            if (typeof document !== 'undefined' && !document.hidden) {
                if (timerId !== null) {
                    window.clearTimeout(timerId);
                    timerId = null;
                }
                void revalidate();
            }
        };

        window.addEventListener('visibilitychange', handleVisibilityChange);
        schedule();
        return () => {
            cancelled = true;
            if (timerId !== null) {
                window.clearTimeout(timerId);
                timerId = null;
            }
            window.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [sharedPlaylistData?.shareId, sharedPlaylistMode, sharedPlaylistStatus, sharedPlaylistServerKey]);

    useEffect(() => {
        if (sharedPlaylistMode !== 'server' || sharedPlaylistStatus !== 'ready') return;
        const currentShareId = String(sharedPlaylistData?.shareId || '').trim();
        if (!currentShareId || !SHARED_PLAY_ID_REGEX.test(currentShareId)) return;
        if (typeof window === 'undefined') return;

        const handleStorage = (event: StorageEvent) => {
            if (event.key !== SHARED_PLAYLIST_INVALIDATION_EVENT_KEY) return;
            const rawPayload = String(event.newValue || '').trim();
            if (!rawPayload) return;

            try {
                const parsed = JSON.parse(rawPayload);
                const shareIds = Array.isArray(parsed?.shareIds)
                    ? parsed.shareIds.map((shareId: unknown) => String(shareId || '').trim())
                    : [];
                if (!shareIds.includes(currentShareId)) return;
                window.location.reload();
            } catch {
            }
        };

        window.addEventListener('storage', handleStorage);
        return () => {
            window.removeEventListener('storage', handleStorage);
        };
    }, [sharedPlaylistData?.shareId, sharedPlaylistMode, sharedPlaylistStatus]);

    const clearSidebarTimers = useCallback(() => {
        if (sidebarTimersRef.current.length === 0) return;
        sidebarTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
        sidebarTimersRef.current = [];
    }, []);

    const clearSidebarHandoffRaf = useCallback(() => {
        if (sidebarHandoffRafRef.current == null) return;
        window.cancelAnimationFrame(sidebarHandoffRafRef.current);
        sidebarHandoffRafRef.current = null;
    }, []);

    const runSidebarHandoff = useCallback((commit: () => void) => {
        clearSidebarHandoffRaf();
        setIsSidebarHandoff(true);
        commit();
        sidebarHandoffRafRef.current = window.requestAnimationFrame(() => {
            setIsSidebarHandoff(false);
            sidebarHandoffRafRef.current = null;
        });
    }, [clearSidebarHandoffRaf]);

    const closeSidebar = useCallback(() => {
        clearSidebarTimers();
        runSidebarHandoff(() => {
            setIsSidebarOpen(false);
            setIsSidebarShifted(true);
        });
        const closeTimer = window.setTimeout(() => {
            setIsSidebarShifted(false);
            setIsSidebarVisible(false);
        }, SIDEBAR_PUSH_MS);
        sidebarTimersRef.current.push(closeTimer);
    }, [clearSidebarTimers, runSidebarHandoff]);

    const openSidebar = useCallback(() => {
        clearSidebarTimers();
        setIsSidebarVisible(true);
        setIsSidebarShifted(true);
        setIsSidebarOpen(false);
        const applyLayoutTimer = window.setTimeout(() => {
            runSidebarHandoff(() => {
                setIsSidebarOpen(true);
                setIsSidebarShifted(false);
            });
        }, SIDEBAR_PUSH_MS);
        sidebarTimersRef.current.push(applyLayoutTimer);
    }, [clearSidebarTimers, runSidebarHandoff]);

    const toggleSidebar = useCallback(() => {
        if (isSidebarVisible) {
            closeSidebar();
            return;
        }
        openSidebar();
    }, [closeSidebar, isSidebarVisible, openSidebar]);

    const setAudioLoadingDebounced = useCallback((isLoading: boolean) => {
        if (loadingDebounceRef.current !== null) {
            window.clearTimeout(loadingDebounceRef.current);
            loadingDebounceRef.current = null;
        }

        if (isLoading) {
            setIsAudioLoading(true);
        } else {
            loadingDebounceRef.current = window.setTimeout(() => {
                setIsAudioLoading(false);
                loadingDebounceRef.current = null;
            }, 200);
        }
    }, []);

    useEffect(() => {
        setIsClient(true);
        dlManager.initializeQuality();
        setQualityPref(dlManager.qualityPref);
        api.getLatest().then(setLatestUpdates);

        let disposed = false;
        let idleHandle: number | null = null;
        let fallbackHandle: number | null = null;

        const hydrateLocalState = () => {
            if (disposed) return;

            const savedMode = localStorage.getItem('playerMode');
            if (savedMode === 'minimized' || savedMode === 'standard') {
                setPlayerMode(savedMode);
            }
            const savedRepeat = localStorage.getItem('playerRepeatEnabled');
            if (savedRepeat === '1' || savedRepeat === 'true') {
                setIsRepeatEnabled(true);
            }

            const savedLikes = readLikedTracksFromStorage(window.localStorage);
            if (savedLikes.length > 0) {
                const baseNow = Date.now();
                setLikedTracks(savedLikes.map((track: unknown, index: number) => {
                    const source = (track && typeof track === 'object') ? (track as Record<string, unknown>) : {};
                    const rawLikedAt = Number(source.likedAt ?? source.addedAt ?? 0);
                    const likedAt = Number.isFinite(rawLikedAt) && rawLikedAt > 0
                        ? Math.floor(rawLikedAt)
                        : Math.max(1, baseNow - index);
                    return normalizeLikedTrack({ ...source, likedAt });
                }));
            }

            const savedLikedMetaCache = localStorage.getItem(LIKED_ALBUM_META_CACHE_KEY)
                || localStorage.getItem(LEGACY_LIKED_ALBUM_META_CACHE_KEY);
            if (!savedLikedMetaCache) return;

            try {
                const parsed = JSON.parse(savedLikedMetaCache);
                if (!parsed || typeof parsed !== 'object') return;
                const baseNow = Date.now();
                const cleaned: Record<string, any> = {};
                Object.entries(parsed).forEach(([key, value], index) => {
                    if (!value || typeof value !== 'object') return;
                    const fallbackTs = baseNow - index;
                    const stamped = withLikedMetaCacheTimestamp(value, fallbackTs);
                    cleaned[key] = stamped;
                    const albumId = normalizeAlbumId((value as any)?.albumId || (value as any)?.canonicalUrl);
                    if (albumId) cleaned[`id:${albumId}`] = stamped;
                });
                setLikedAlbumMetaCache(pruneLikedAlbumMetaCache(cleaned, LIKED_META_CACHE_MAX_ENTRIES));
            } catch (e) {
                console.error("Failed to parse liked album meta cache", e);
            }
        };

        const win = window as Window & {
            requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
            cancelIdleCallback?: (id: number) => void;
        };
        if (typeof win.requestIdleCallback === 'function') {
            idleHandle = win.requestIdleCallback(() => hydrateLocalState(), { timeout: 1200 });
        } else {
            fallbackHandle = window.setTimeout(hydrateLocalState, 32);
        }

        return () => {
            disposed = true;
            if (idleHandle !== null && typeof win.cancelIdleCallback === 'function') {
                win.cancelIdleCallback(idleHandle);
            }
            if (fallbackHandle !== null) {
                window.clearTimeout(fallbackHandle);
            }
            if (loadingDebounceRef.current !== null) {
                window.clearTimeout(loadingDebounceRef.current);
                loadingDebounceRef.current = null;
            }
            clearSidebarTimers();
            clearSidebarHandoffRaf();
        };
    }, [clearSidebarHandoffRaf, clearSidebarTimers]);

    useEffect(() => {
        if (!isClient) return;
        let disposed = false;
        let idleHandle: number | null = null;
        let fallbackHandle: number | null = null;

        const warmViewChunks = () => {
            if (disposed) return;
            void import('../components/QueueView');
            void import('../components/SettingsView');
            void import('../components/PlaylistsView');
            void import('../components/PlaybackQueue');
            void import('../components/GalleryModal');
        };

        const win = window as Window & {
            requestIdleCallback?: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
            cancelIdleCallback?: (id: number) => void;
        };

        if (typeof win.requestIdleCallback === 'function') {
            idleHandle = win.requestIdleCallback(() => warmViewChunks(), { timeout: 2200 });
        } else {
            fallbackHandle = window.setTimeout(warmViewChunks, 700);
        }

        return () => {
            disposed = true;
            if (idleHandle !== null && typeof win.cancelIdleCallback === 'function') {
                win.cancelIdleCallback(idleHandle);
            }
            if (fallbackHandle !== null) {
                window.clearTimeout(fallbackHandle);
            }
        };
    }, [isClient]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const media = window.matchMedia('(min-width: 769px)');
        const applyViewport = () => setIsDesktopViewport(media.matches);
        applyViewport();

        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', applyViewport);
            return () => media.removeEventListener('change', applyViewport);
        }

        media.addListener(applyViewport);
        return () => media.removeListener(applyViewport);
    }, []);

    useEffect(() => {
        if (isDesktopViewport) {
            setIsBrowseToolbarOpenMobile(true);
            setIsSearchFiltersOpenMobile(true);
            setIsAlbumCommentsOpenMobile(true);
            return;
        }
        setIsBrowseToolbarOpenMobile(false);
        setIsSearchFiltersOpenMobile(false);
        setIsAlbumCommentsOpenMobile(false);
    }, [isDesktopViewport]);

    useEffect(() => {
        if (isDesktopViewport) return;
        if (activeSearchTerm.trim()) return;
        setIsSearchFiltersOpenMobile(false);
    }, [activeSearchTerm, isDesktopViewport]);

    useEffect(() => {
        const previous = previousIsDesktopViewportRef.current;
        previousIsDesktopViewportRef.current = isDesktopViewport;
        if (!isDesktopViewport) return;
        if (previous !== false) return;
        if (!isSearchInputFocused) return;
        searchInputRef.current?.blur();
        setIsSearchInputFocused(false);
    }, [isDesktopViewport, isSearchInputFocused]);

    useEffect(() => {
        if (isDesktopViewport) return;
        setIsAlbumCommentsOpenMobile(false);
    }, [isDesktopViewport, selectedAlbum?.url]);

    useEffect(() => {
        if (isClient) {
            writeLikedTracksToStorage(window.localStorage, likedTracks);
        }
    }, [likedTracks, isClient]);

    useEffect(() => {
        if (!isClient) return;
        const prunedCache = pruneLikedAlbumMetaCache(likedAlbumMetaCache, LIKED_META_CACHE_MAX_ENTRIES);
        localStorage.setItem(LIKED_ALBUM_META_CACHE_KEY, JSON.stringify(prunedCache));
    }, [likedAlbumMetaCache, isClient]);

    useEffect(() => {
        if (!isClient) return;
        const result = savePlaylistsToStorage(window.localStorage, playlists);
        if (!result.ok) {
            const message = result.error || 'Failed to save playlists locally.';
            setPlaylistStorageWarning(message);
            console.warn(message);
            return;
        }
        if (playlistStorageWarning) {
            setPlaylistStorageWarning('');
        }
    }, [isClient, playlists, playlistStorageWarning]);

    useEffect(() => {
        const validPlaylistIds = new Set(playlists.map((playlist) => String(playlist.id || '').trim()).filter(Boolean));
        const existing = playlistShareSecretsRef.current;
        Object.keys(existing).forEach((playlistId) => {
            if (validPlaylistIds.has(playlistId)) return;
            delete existing[playlistId];
        });
    }, [playlists]);

    useEffect(() => {
        if (sharedPlaylistMode !== 'none') {
            return;
        }
        if (playlists.length === 0) {
            if (selectedPlaylistId) setSelectedPlaylistId(null);
            return;
        }
        if (playlistRouteIdentifier) {
            const matched = resolvePlaylistFromRouteIdentifier(playlistRouteIdentifier, playlists);
            if (matched) {
                if (selectedPlaylistId !== matched.id) {
                    setSelectedPlaylistId(matched.id);
                }
            } else if (selectedPlaylistId !== null) {
                setSelectedPlaylistId(null);
            }
            return;
        }
        if (!selectedPlaylistId || !playlists.some((playlist) => playlist.id === selectedPlaylistId)) {
            setSelectedPlaylistId(playlists[0].id);
        }
    }, [playlists, playlistRouteIdentifier, selectedPlaylistId, sharedPlaylistMode]);

    useEffect(() => {
        setTrackFilterQuery('');
        setIsAllCommentsVisible(false);
    }, [selectedUrl]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const activeTag = document.activeElement?.tagName;
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

            if (e.code === 'Space') {
                e.preventDefault();
                const media = audioRef.current;
                if (!media) return;
                if (media.paused) {
                    media.play().catch(() => { });
                    setIsPlaying(true);
                } else {
                    media.pause();
                    setIsPlaying(false);
                }
            } else if (e.code === 'ArrowRight') {
                e.preventDefault();
                if (audioRef.current) {
                    audioRef.current.currentTime = Math.min((audioRef.current.duration || 0), audioRef.current.currentTime + 5);
                }
            } else if (e.code === 'ArrowLeft') {
                e.preventDefault();
                if (audioRef.current) {
                    audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 5);
                }
            } else if (e.code === 'ArrowUp') {
                e.preventDefault();
                setVolume((prev) => {
                    const next = Math.min(1, prev + 0.05);
                    if (audioRef.current) audioRef.current.volume = next;
                    return next;
                });
            } else if (e.code === 'ArrowDown') {
                e.preventDefault();
                setVolume((prev) => {
                    const next = Math.max(0, prev - 0.05);
                    if (audioRef.current) audioRef.current.volume = next;
                    return next;
                });
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    useEffect(() => {
        const shouldTrackProgressByKey = !!selectedAlbum || view === 'liked' || view === 'playlists';

        const processState = () => {
            const state = dlManager.getState();
            const nextQueueCount = state.active.length + state.queue.length;
            setQueueCount((prev) => (prev === nextQueueCount ? prev : nextQueueCount));

            const nextTrackProgressByKey: Record<string, number> = {};
            if (shouldTrackProgressByKey) {
                state.active.forEach((item: any) => {
                    if (item?.type === 'track') {
                        const key = getPlaybackTrackKey(item?.track);
                        const progress = Number(item?.progress ?? 0);
                        if (!key || !Number.isFinite(progress) || progress <= 0) return;
                        nextTrackProgressByKey[key] = Math.min(100, Math.max(0, progress));
                        return;
                    }
                    if (item?.type !== 'album' || !item?.trackProgressMap) return;

                    const albumTracks = Array.isArray(item?.tracks)
                        ? item.tracks
                        : Array.isArray(item?.meta?.tracks)
                            ? item.meta.tracks
                            : [];

                    for (const [rawIndex, rawProgress] of Object.entries(item.trackProgressMap as Record<string, unknown>)) {
                        const index = Number(rawIndex);
                        if (!Number.isFinite(index)) continue;
                        const track = albumTracks[index];
                        if (!track) continue;
                        const key = getPlaybackTrackKey(track);
                        if (!key) continue;
                        const progress = Number(rawProgress ?? 0);
                        if (!Number.isFinite(progress) || progress <= 0) continue;
                        const safeProgress = Math.min(100, Math.max(0, progress));
                        const existing = nextTrackProgressByKey[key];
                        if (existing == null || safeProgress > existing) {
                            nextTrackProgressByKey[key] = safeProgress;
                        }
                    }
                });
            }
            startTransition(() => {
                setTrackProgressByKey((prev) => (areProgressMapsEqual(prev, nextTrackProgressByKey) ? prev : nextTrackProgressByKey));
            });

            if (selectedAlbum) {
                let foundAlbumDownload: any = null;
                let isQueued = false;
                let matchedAlbumItemId: string | null = null;
                const albumName = selectedAlbumName;

                state.active.forEach((item: any) => {
                    if (item.type === 'album' && String(item?.meta?.name || '') === albumName) {
                        foundAlbumDownload = item;
                        matchedAlbumItemId = item.id;
                    }
                });

                if (!foundAlbumDownload) {
                    const queuedAlbumItem = state.queue.find((item: any) =>
                        item.type === 'album' && String(item?.meta?.name || '') === albumName
                    );
                    if (queuedAlbumItem) {
                        isQueued = true;
                        matchedAlbumItemId = queuedAlbumItem.id;
                    }
                }

                setAlbumProgress((prev: any) => (isSameAlbumDownloadSnapshot(prev, foundAlbumDownload) ? prev : foundAlbumDownload));
                setAlbumIsQueued((prev) => (prev === isQueued ? prev : isQueued));
                setAlbumQueueItemId((prev) => (prev === matchedAlbumItemId ? prev : matchedAlbumItemId));
            } else {
                setAlbumProgress((prev: any) => (prev === null ? prev : null));
                setAlbumIsQueued((prev) => (prev ? false : prev));
                setAlbumQueueItemId((prev) => (prev === null ? prev : null));
            }
        };

        const flush = () => {
            if (dlUpdateRafRef.current != null) return;
            dlUpdateRafRef.current = window.requestAnimationFrame(() => {
                dlUpdateRafRef.current = null;
                dlLastUiUpdateAtRef.current = (typeof performance !== 'undefined' && performance.now)
                    ? performance.now()
                    : Date.now();
                processState();
            });
        };

        const handler = () => {
            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            const elapsed = now - dlLastUiUpdateAtRef.current;
            if (elapsed >= DL_UI_UPDATE_MIN_INTERVAL_MS) {
                if (dlUpdateTimerRef.current != null) {
                    window.clearTimeout(dlUpdateTimerRef.current);
                    dlUpdateTimerRef.current = null;
                }
                flush();
                return;
            }
            if (dlUpdateTimerRef.current != null) return;
            const waitMs = Math.max(0, Math.ceil(DL_UI_UPDATE_MIN_INTERVAL_MS - elapsed));
            dlUpdateTimerRef.current = window.setTimeout(() => {
                dlUpdateTimerRef.current = null;
                flush();
            }, waitMs);
        };

        handler();
        dlManager.on('update', handler);
        if (shouldTrackProgressByKey) {
            dlManager.on('itemUpdate', handler);
        }
        return () => {
            if (dlUpdateRafRef.current != null) {
                cancelAnimationFrame(dlUpdateRafRef.current);
                dlUpdateRafRef.current = null;
            }
            if (dlUpdateTimerRef.current != null) {
                window.clearTimeout(dlUpdateTimerRef.current);
                dlUpdateTimerRef.current = null;
            }
            dlManager.off('update', handler);
            if (shouldTrackProgressByKey) {
                dlManager.off('itemUpdate', handler);
            }
        };
    }, [selectedAlbum, selectedAlbumName, view]);

    const getTrackDownloadProgress = useCallback((track: any) => {
        const key = getPlaybackTrackKey(track);
        if (!key) return undefined;
        const progress = trackProgressByKey[key];
        if (!Number.isFinite(progress) || progress <= 0) return undefined;
        return Math.min(100, Math.max(0, progress));
    }, [trackProgressByKey]);

    const resetSearchState = useCallback(() => {
        setActiveSearchTerm('');
        setResults([]);
        setSearchFilters(DEFAULT_SEARCH_FILTERS);
        setSearchOptions(DEFAULT_SEARCH_OPTIONS);
        setSearchPagination(DEFAULT_SEARCH_PAGINATION);
        setSearchTotalMatches(null);
        setIsSearchAppending(false);
        fetchedSearchResultTokensRef.current.clear();
        searchResultKeySetRef.current.clear();
    }, []);

    const mergeSearchFilters = useCallback((
        term: string,
        base: SearchFilters,
        overrides: Partial<SearchFilters>
    ): SearchFilters => {
        const sortRaw = String(
            overrides.sort !== undefined ? overrides.sort : base.sort
        ).trim();

        return {
            q: term,
            sort: sortRaw || 'relevance',
            album_type: normalizeSearchFilterValue(
                overrides.album_type !== undefined ? overrides.album_type : base.album_type
            ),
            album_year: normalizeSearchFilterValue(
                overrides.album_year !== undefined ? overrides.album_year : base.album_year
            ),
            album_category: normalizeSearchFilterValue(
                overrides.album_category !== undefined ? overrides.album_category : base.album_category
            ),
            result: normalizeSearchFilterValue(
                overrides.result !== undefined ? overrides.result : base.result
            ),
        };
    }, []);

    const replaceSearchUrl = useCallback((
        term: string,
        filters: SearchFilters,
        options?: { force?: boolean; historyMode?: 'auto' | 'replace' | 'push' }
    ) => {
        if (typeof window === 'undefined') return;
        const currentHistoryKey = String(window.history.state?.historyStateKey || '');
        if (!options?.force && currentHistoryKey === 'album') {
            return;
        }
        const hasTransientHistoryKey = !!currentHistoryKey;
        const currentPath = normalizeRoutePath(window.location.pathname);
        const currentParams = new URLSearchParams(window.location.search);
        const currentSearchTerm = String(currentParams.get('search') || '').trim();
        const params = new URLSearchParams();
        const trimmedTerm = term.trim();
        if (trimmedTerm) {
            params.set('search', trimmedTerm);
            params.set('sort', filters.sort || 'relevance');
            if (filters.album_type) params.set('album_type', filters.album_type);
            if (filters.album_year) params.set('album_year', filters.album_year);
            if (filters.album_category) params.set('album_category', filters.album_category);
            if (filters.result) params.set('result', filters.result);
        }
        const homePath = getPathForView('home');
        const nextUrl = params.toString()
            ? `${homePath}?${params.toString()}`
            : homePath;
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (currentUrl === nextUrl) return;

        const mode = options?.historyMode || 'auto';
        let shouldPush = false;
        if (mode === 'push') {
            shouldPush = true;
        } else if (mode === 'auto') {
            shouldPush = !!trimmedTerm && (!currentSearchTerm || currentPath !== homePath) && !hasTransientHistoryKey;
        }
        const currentState = (window.history.state && typeof window.history.state === 'object')
            ? window.history.state
            : {};
        if (shouldPush) {
            window.history.pushState({ ...currentState }, '', nextUrl);
            return;
        }
        window.history.replaceState({ ...currentState }, '', nextUrl);
    }, []);

    const syncAlbumUrl = useCallback((albumUrl: string, options?: { historyMode?: 'replace' | 'push' | 'none' }) => {
        if (typeof window === 'undefined') return;
        const historyMode = options?.historyMode || 'push';
        if (historyMode === 'none') return;

        const currentPath = normalizeRoutePath(window.location.pathname);
        const params = currentPath === getPathForView('home')
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
        const albumParam = toAlbumUrlParam(albumUrl);
        if (!albumParam) {
            params.delete('album');
        } else {
            params.set('album', albumParam);
        }
        const nextUrl = params.toString()
            ? `${getPathForView('home')}?${params.toString()}`
            : getPathForView('home');
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (nextUrl === currentUrl) return;

        const currentState = (window.history.state && typeof window.history.state === 'object')
            ? window.history.state
            : {};
        if (historyMode === 'push') {
            window.history.pushState({ ...currentState }, '', nextUrl);
            return;
        }
        window.history.replaceState({ ...currentState }, '', nextUrl);
    }, []);

    const replaceBrowseUrl = useCallback((
        section: BrowseSectionKey,
        options?: { slug?: string; page?: number; historyMode?: 'replace' | 'push' | 'none' }
    ) => {
        if (typeof window === 'undefined') return;
        const historyMode = options?.historyMode || 'replace';
        if (historyMode === 'none') return;

        const nextUrl = getBrowseRouteUrl(section, {
            slug: String(options?.slug || '').trim().toLowerCase(),
            page: coerceBrowsePage(String(options?.page || 1)),
        });
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (currentUrl === nextUrl) return;

        const currentState = (window.history.state && typeof window.history.state === 'object')
            ? window.history.state
            : {};
        if (historyMode === 'push') {
            window.history.pushState({ ...currentState }, '', nextUrl);
            return;
        }
        window.history.replaceState({ ...currentState }, '', nextUrl);
    }, []);

    const handleSearch = async (
        term: string,
        overrides: Partial<SearchFilters> = {},
        options?: { skipUrlSync?: boolean; preservePage?: boolean; append?: boolean }
    ) => {
        const trimmed = term.trim();
        const isAppend = !!options?.append;
        setQuery(trimmed);

        if (!trimmed) {
            if (albumFetchControllerRef.current) {
                albumFetchControllerRef.current.abort();
            }
            resetSearchState();
            setSelectedAlbum(null);
            setSelectedUrl(null);
            setLoading(false);
            setView('home');
            if (!options?.skipUrlSync) {
                replaceSearchUrl('', DEFAULT_SEARCH_FILTERS, { force: true });
            }
            return;
        }

        if (isUrl(trimmed)) {
            const path = extractPathFromUrl(trimmed);
            const albumItem = {
                url: path,
                title: path.split('/').pop() || path,
                albumId: normalizeAlbumId(path) || null,
                icon: ''
            };
            resetSearchState();
            setView('home');
            if (!options?.skipUrlSync) {
                replaceSearchUrl('', DEFAULT_SEARCH_FILTERS, { force: true });
            }
            selectAlbum(albumItem);
            return;
        }

        if (albumFetchControllerRef.current) {
            albumFetchControllerRef.current.abort();
        }

        const baseFilters: SearchFilters = {
            ...searchFilters,
            q: trimmed,
        };
        if (!options?.preservePage && overrides.result === undefined) {
            baseFilters.result = '';
        }
        const nextFilters = mergeSearchFilters(trimmed, baseFilters, overrides);

        const nextResultToken = normalizeSearchFilterValue(nextFilters.result);
        if (isAppend && !nextResultToken) {
            return;
        }
        if (isAppend && fetchedSearchResultTokensRef.current.has(nextResultToken)) {
            return;
        }
        if (!isAppend) {
            fetchedSearchResultTokensRef.current.clear();
            searchResultKeySetRef.current.clear();
        }
        fetchedSearchResultTokensRef.current.add(nextResultToken);

        setActiveSearchTerm(trimmed);
        setSearchFilters(nextFilters);
        if (isAppend) {
            setIsSearchAppending(true);
        } else {
            setLoading(true);
            setResults([]);
            setSelectedAlbum(null);
            setSelectedUrl(null);
            setView('home');
        }
        if (!options?.skipUrlSync) {
            replaceSearchUrl(trimmed, nextFilters);
        }

        try {
            const payload = await api.searchAlbums(nextFilters);
            const incomingItems = payload.items || [];
            if (isAppend) {
                setResults((prev) => {
                    const dedupe = searchResultKeySetRef.current;
                    if (dedupe.size === 0 && prev.length > 0) {
                        prev.forEach((item) => {
                            const key = getSearchResultKey(item);
                            if (key) dedupe.add(key);
                        });
                    }
                    const appended: any[] = [];
                    incomingItems.forEach((item: any) => {
                        const key = getSearchResultKey(item);
                        if (!key) {
                            appended.push(item);
                            return;
                        }
                        if (dedupe.has(key)) return;
                        dedupe.add(key);
                        appended.push(item);
                    });
                    if (appended.length === 0) return prev;
                    return [...prev, ...appended];
                });
            } else {
                const nextDedupe = new Set<string>();
                const dedupedIncoming: any[] = [];
                incomingItems.forEach((item: any) => {
                    const key = getSearchResultKey(item);
                    if (!key) {
                        dedupedIncoming.push(item);
                        return;
                    }
                    if (nextDedupe.has(key)) return;
                    nextDedupe.add(key);
                    dedupedIncoming.push(item);
                });
                searchResultKeySetRef.current = nextDedupe;
                setResults(dedupedIncoming);
            }
            setSearchFilters(payload.applied || nextFilters);
            setSearchOptions(payload.filterOptions || DEFAULT_SEARCH_OPTIONS);
            setSearchPagination(payload.pagination || DEFAULT_SEARCH_PAGINATION);
            setSearchTotalMatches(payload.totalMatches ?? null);

            if (!isAppend) {
                fetchedSearchResultTokensRef.current.clear();
                const appliedResultToken = normalizeSearchFilterValue((payload.applied || nextFilters).result);
                fetchedSearchResultTokensRef.current.add(appliedResultToken);
            }

            if (!options?.skipUrlSync) {
                replaceSearchUrl(trimmed, payload.applied || nextFilters);
            }
        } catch (e) {
            console.error(e);
            if (isAppend) {
                fetchedSearchResultTokensRef.current.delete(nextResultToken);
            }
            setSearchOptions(DEFAULT_SEARCH_OPTIONS);
            setSearchPagination(DEFAULT_SEARCH_PAGINATION);
            setSearchTotalMatches(null);
        } finally {
            if (isAppend) {
                setIsSearchAppending(false);
            } else {
                setLoading(false);
            }
        }
    };

    const handleInputKey = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return;
        void handleSearch(query);
    }, [handleSearch, query]);

    const handleInputPaste = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
        const pastedText = event.clipboardData.getData('text');
        if (!isUrl(pastedText)) return;
        event.preventDefault();
        const next = String(pastedText || '').trim();
        setQuery(next);
        void handleSearch(next);
    }, [handleSearch]);

    const syncStateFromLocation = useCallback(() => {
        if (typeof window === 'undefined') return;

        const normalizedPath = normalizeRoutePath(window.location.pathname);
        const nextView = getViewFromPathname(normalizedPath);
        const sharedShareId = nextView === 'playlists'
            ? getSharedPlaylistShareIdFromPathname(window.location.pathname)
            : null;
        const sharedHashPath = nextView === 'playlists'
            ? isSharedPlaylistHashPath(normalizedPath)
            : false;
        const nextPlaylistIdentifier = nextView === 'playlists' && !sharedShareId && !sharedHashPath
            ? getPlaylistIdentifierFromPathname(normalizedPath)
            : null;
        setView(nextView);
        setPlaylistRouteIdentifier(nextPlaylistIdentifier);

        if (nextView === 'playlists') {
            pendingSharedTrackTargetRef.current = parseTrackShareTarget('');
            pendingSharedTrackAlbumIdRef.current = '';
            setSelectedAlbum(null);
            setSelectedUrl(null);
            void hydrateSharedPlaylistFromLocation(window.location.pathname, window.location.hash);
            return;
        }

        if (nextView === 'browse') {
            resetSharedPlaylistState();
            pendingSharedTrackTargetRef.current = parseTrackShareTarget('');
            pendingSharedTrackAlbumIdRef.current = '';
            setSelectedAlbum(null);
            setSelectedUrl(null);

            const browseRoute = parseBrowseRouteFromSearch(window.location.search);
            const browseRouteKey = `${browseRoute.section}|${browseRoute.slug || ''}|${browseRoute.page}`;
            if (browseRouteRequestKeyRef.current === browseRouteKey) {
                return;
            }
            browseInitializedRef.current = true;
            browseRouteRequestKeyRef.current = browseRouteKey;
            void loadBrowseSectionRef.current?.(browseRoute.section, {
                ...(browseRoute.slug ? { slug: browseRoute.slug } : {}),
                page: browseRoute.page,
                historyMode: 'none',
                skipUrlSync: true,
            });
            return;
        }

        resetSharedPlaylistState();

        if (nextView !== 'home') {
            pendingSharedTrackTargetRef.current = parseTrackShareTarget('');
            pendingSharedTrackAlbumIdRef.current = '';
            setSelectedAlbum(null);
            setSelectedUrl(null);
            return;
        }

        const params = new URLSearchParams(window.location.search);
        const term = String(params.get('search') || '').trim();
        const sharedTrackTarget = parseTrackShareTarget(params.get('track'));
        const canonicalAlbumPath = getCanonicalAlbumPathFromPathname(window.location.pathname);
        if (canonicalAlbumPath) {
            const pendingAlbumId = normalizeAlbumId(canonicalAlbumPath) || canonicalAlbumPath;
            pendingSharedTrackTargetRef.current = sharedTrackTarget;
            pendingSharedTrackAlbumIdRef.current = pendingAlbumId;
            setPendingSharedTrackSignal((prev) => prev + 1);
            setQuery('');
            resetSearchState();
            const currentSelected = toAlbumUrlParam(selectedUrl || '');
            if (currentSelected !== canonicalAlbumPath) {
                void selectAlbumRef.current?.(
                    {
                        url: canonicalAlbumPath,
                        albumId: normalizeAlbumId(canonicalAlbumPath) || null,
                        title: canonicalAlbumPath.split('/').pop() || canonicalAlbumPath,
                    },
                    { historyMode: 'none' }
                );
            }
            return;
        }

        const albumParamRaw = String(params.get('album') || '').trim();
        const albumParam = toAlbumUrlParam(albumParamRaw);

        if (albumParam) {
            const pendingAlbumId = normalizeAlbumId(albumParam) || '';
            pendingSharedTrackTargetRef.current = sharedTrackTarget;
            pendingSharedTrackAlbumIdRef.current = pendingAlbumId;
            setPendingSharedTrackSignal((prev) => prev + 1);
            if (term) {
                setQuery(term);
            } else {
                setQuery('');
                resetSearchState();
            }
            const currentSelected = toAlbumUrlParam(selectedUrl || '');
            if (currentSelected !== albumParam) {
                void selectAlbumRef.current?.(
                    {
                        url: albumParam,
                        albumId: normalizeAlbumId(albumParam) || null,
                        title: albumParam.split('/').pop() || albumParam,
                    },
                    { historyMode: 'none' }
                );
            }
            return;
        }

        pendingSharedTrackTargetRef.current = parseTrackShareTarget('');
        pendingSharedTrackAlbumIdRef.current = '';
        setPendingSharedTrackSignal((prev) => prev + 1);

        if (selectedUrl) {
            setSelectedAlbum(null);
            setSelectedUrl(null);
        }

        if (!term) {
            resetSearchState();
            setQuery('');
            return;
        }

        const initialOverrides: Partial<SearchFilters> = {
            sort: String(params.get('sort') || '').trim() || 'relevance',
            album_type: normalizeSearchFilterValue(params.get('album_type')),
            album_year: normalizeSearchFilterValue(params.get('album_year')),
            album_category: normalizeSearchFilterValue(params.get('album_category')),
            result: normalizeSearchFilterValue(params.get('result')),
        };
        const initialFilters = mergeSearchFilters(
            term,
            { ...DEFAULT_SEARCH_FILTERS, q: term },
            initialOverrides
        );

        setQuery(term);
        void handleSearch(term, initialFilters, {
            skipUrlSync: true,
            preservePage: true,
        });
    }, [handleSearch, hydrateSharedPlaylistFromLocation, mergeSearchFilters, resetSearchState, resetSharedPlaylistState, selectedUrl]);

    useEffect(() => {
        if (!isClient || hasHydratedInitialSearchRef.current) return;
        hasHydratedInitialSearchRef.current = true;
        try {
            syncStateFromLocation();
        } finally {
            setHasInitialRouteSync(true);
        }
    }, [isClient, syncStateFromLocation]);

    useEffect(() => {
        if (!isClient) return;
        const handlePopState = (event: PopStateEvent) => {
            const taggedEvent = event as PopStateEvent & { __khHandled?: boolean; __khSuppressed?: boolean };
            if (consumeSuppressedPopStateEvent(taggedEvent)) return;
            if (taggedEvent.__khHandled || taggedEvent.__khSuppressed) return;

            const restoreIfRoutePopped = () => {
                if (typeof window === 'undefined') return;
                const currentUrl = getLocationKey();
                const stableUrl = String(lastStableUrlRef.current || '').trim();
                if (!stableUrl || currentUrl === stableUrl) return;
                const baseState = (window.history.state && typeof window.history.state === 'object')
                    ? window.history.state
                    : {};
                window.history.replaceState({ ...baseState }, '', stableUrl);
            };

            const isQueueOverlayOpen = !!queueOverlayHostRef.current?.isOpen?.();
            if (isQueueOverlayOpen) {
                taggedEvent.__khHandled = true;
                queueOverlayHostRef.current?.close();
                restoreIfRoutePopped();
                return;
            }

            if (isMobileFullScreen) {
                taggedEvent.__khHandled = true;
                setMobileFullScreen(false);
                restoreIfRoutePopped();
                return;
            }

            syncStateFromLocation();
        };
        const handleHashChange = () => {
            syncStateFromLocation();
        };
        const handlePageShow = () => {
            setPageShowSignal((prev) => prev + 1);
            syncStateFromLocation();
        };
        window.addEventListener('popstate', handlePopState);
        window.addEventListener('hashchange', handleHashChange);
        window.addEventListener('pageshow', handlePageShow);
        return () => {
            window.removeEventListener('popstate', handlePopState);
            window.removeEventListener('hashchange', handleHashChange);
            window.removeEventListener('pageshow', handlePageShow);
        };
    }, [getLocationKey, isClient, isMobileFullScreen, syncStateFromLocation]);

    const selectAlbum = useCallback(async (item: any, options?: { historyMode?: 'replace' | 'push' | 'none' }) => {
        if (albumFetchControllerRef.current) {
            albumFetchControllerRef.current.abort();
        }
        const rawCandidates: string[] = Array.isArray(item?.urls) ? item.urls : [item?.url];
        const candidateSet = new Set<string>();
        const albumCandidates: string[] = [];
        const addCandidate = (raw: any) => {
            const asString = String(raw || '').trim();
            if (!asString) return;
            const normalizedAlbumId = normalizeAlbumId(asString);
            const path = extractPathFromUrl(asString);
            const pathStr = String(path || '');
            const soundtracksMatch = pathStr.match(/\/soundtracks\/([^/?#]+)/i);

            let candidate = normalizedAlbumId || asString;
            if (!normalizedAlbumId && soundtracksMatch?.[1]) {
                candidate = `/game-soundtracks/album/${soundtracksMatch[1]}`;
            } else if (!normalizedAlbumId && !candidate.includes('/')) {
                candidate = `/game-soundtracks/album/${candidate}`;
            }

            const norm = candidate.replace(/[/?]+$/, '').toLowerCase();
            if (!norm || candidateSet.has(norm)) return;
            candidateSet.add(norm);
            albumCandidates.push(candidate);
        };

        addCandidate(item?.albumId);
        rawCandidates.forEach(addCandidate);
        addCandidate(item?.albumUrl);
        addCandidate(item?.trackUrl);
        addCandidate(item?.albumArt);

        if (albumCandidates.length === 0) return;

        if (typeof window !== 'undefined' && getViewFromPathname(window.location.pathname) !== 'home') {
            replaceSearchUrl('', DEFAULT_SEARCH_FILTERS, { force: true, historyMode: 'replace' });
        }
        setView('home');
        const controller = new AbortController();
        albumFetchControllerRef.current = controller;
        setSelectedUrl(albumCandidates[0]);
        setLoading(true);
        setSelectedAlbum(null);
        setAlbumProgress(null);
        setAlbumIsQueued(false);
        try {
            let resolvedUrl = albumCandidates[0];
            let meta: any = null;
            let lastError: any = null;
            for (const candidate of albumCandidates) {
                try {
                    meta = await api.getAlbum(candidate, controller.signal);
                    resolvedUrl = candidate;
                    break;
                } catch (e: any) {
                    if (e?.name === 'AbortError') throw e;
                    lastError = e;
                }
            }

            if (!meta) {
                let lookupTitle = String(item?.title || item?.albumName || '').trim();
                if (!lookupTitle || lookupTitle.toLowerCase() === 'unknown') {
                    const slugMatch = String(albumCandidates[0] || '').match(/\/game-soundtracks\/album\/([^/?#]+)/i);
                    if (slugMatch?.[1]) {
                        lookupTitle = slugMatch[1].replace(/[-_]+/g, ' ').trim();
                    }
                }

                if (lookupTitle) {
                    try {
                        const searchResults = await api.search(lookupTitle);
                        const normalizedLookup = lookupTitle.toLowerCase();
                        const lookupCandidates = (searchResults || [])
                            .filter((res: any) => !!res?.url)
                            .sort((a: any, b: any) => {
                                const aTitle = String(a?.title || '').toLowerCase();
                                const bTitle = String(b?.title || '').toLowerCase();
                                const aExact = aTitle === normalizedLookup ? 0 : 1;
                                const bExact = bTitle === normalizedLookup ? 0 : 1;
                                return aExact - bExact;
                            })
                            .slice(0, 6);

                        for (const res of lookupCandidates) {
                            try {
                                const resolvedCandidate = res.albumId || res.url;
                                meta = await api.getAlbum(resolvedCandidate, controller.signal);
                                resolvedUrl = resolvedCandidate;
                                break;
                            } catch (e: any) {
                                if (e?.name === 'AbortError') throw e;
                                lastError = e;
                            }
                        }
                    } catch {
                    }
                }
            }

            if (!meta) {
                throw lastError || new Error('Metadata Failed');
            }
            albumFetchControllerRef.current = null;
            const resolvedAlbumId = normalizeAlbumId(meta?.albumId || resolvedUrl);
            const canonicalResolvedUrl = resolvedAlbumId
                ? `https://downloads.khinsider.com${resolvedAlbumId}`
                : resolvedUrl;
            setSelectedUrl(canonicalResolvedUrl);
            setSelectedAlbum({ ...meta, albumId: resolvedAlbumId || null });
            syncAlbumUrl(canonicalResolvedUrl, { historyMode: options?.historyMode || 'push' });
        } catch (e: any) {
            const message = String(e?.message || '');
            if (!isAbortLikeError(e) && !isTimeoutLikeError(e) && !message.includes('Khinsider returned 404')) {
                console.error(e);
            }
        } finally {
            if (!controller.signal.aborted) {
                setLoading(false);
            }
        }
    }, [replaceSearchUrl, syncAlbumUrl]);

    selectAlbumRef.current = selectAlbum;

    const handleBack = useCallback(() => {
        if (typeof window !== 'undefined') {
            const params = new URLSearchParams(window.location.search);
            if (String(params.get('album') || '').trim()) {
                window.history.back();
                return;
            }
        }
        setSelectedAlbum(null);
        setSelectedUrl(null);
    }, []);

    const updateQuality = (q: AudioQualityPreference) => {
        setQualityPref(q);
        dlManager.setQuality(q);
    };

    const addToQueue = useCallback((track: any) => {
        dlManager.addTrackToQueue(track, selectedAlbum);
    }, [selectedAlbum]);

    const buildPlaybackTrack = useCallback((track: any) => {
        const albumName = track?.albumName || selectedAlbum?.name || "Unknown Album";
        const albumArt = track?.albumArt || selectedAlbum?.albumImages?.[0] || "";
        const thumbnail = track?.thumbnail || selectedAlbum?.imagesThumbs?.[0] || albumArt || "";
        const albumUrl = track?.albumUrl || selectedUrl || "";
        const albumId = normalizeAlbumId(track?.albumId || selectedAlbum?.albumId || albumUrl || track?.url || albumArt);
        return {
            ...track,
            albumName,
            albumArt,
            thumbnail,
            albumUrl,
            albumId: albumId || undefined,
        };
    }, [selectedAlbum, selectedUrl]);

    const downloadFullAlbum = useCallback(() => {
        dlManager.addAlbumToQueue(selectedAlbum);
    }, [selectedAlbum]);

    const handleTrackLike = useCallback((track: any) => {
        const albumContext = selectedAlbum ? {
            name: selectedAlbum.name,
            url: selectedUrl,
            albumImages: selectedAlbum.albumImages,
            albumId: selectedAlbum.albumId,
            albumArtist: selectedAlbum.primaryArtist || selectedAlbum.albumArtist || selectedAlbum.composers || selectedAlbum.developers || selectedAlbum.publisher || '',
            albumType: selectedAlbum.albumType || '',
            year: selectedAlbum.year || ''
        } : undefined;

        const albumName = albumContext?.name || track.albumName || "Unknown Album";
        const albumUrl = albumContext?.url || track.albumUrl || "";
        const albumArt = albumContext?.albumImages?.[0] || track.albumArt || "";
        const albumId = normalizeAlbumId(albumContext?.albumId || albumUrl || track.albumId || track.url || albumArt);
        const trackData = normalizeLikedTrack({
            ...track,
            albumName,
            albumUrl,
            albumArt,
            albumId: albumId || undefined,
            albumArtist: albumContext?.albumArtist || track.albumArtist || '',
            albumType: albumContext?.albumType || track.albumType || '',
            year: albumContext?.year || track.year || ''
        });

        setLikedTracks(prev => {
            const exists = prev.find(t => t.url === track.url);
            if (exists) return prev.filter(t => t.url !== track.url);
            return [trackData, ...prev];
        });
    }, [selectedAlbum, selectedUrl]);

    const toggleSelectedAlbumLike = useCallback(() => {
        if (!selectedAlbum?.tracks?.length) return;
        const albumContext = {
            name: selectedAlbum.name,
            url: selectedUrl,
            albumImages: selectedAlbum.albumImages,
            albumId: selectedAlbum.albumId,
            albumArtist: selectedAlbum.primaryArtist || selectedAlbum.albumArtist || selectedAlbum.composers || selectedAlbum.developers || selectedAlbum.publisher || '',
            albumType: selectedAlbum.albumType || '',
            year: selectedAlbum.year || ''
        };

        const albumTracks = selectedAlbum.tracks
            .filter((track: any) => String(track?.url || '').trim().length > 0)
            .map((track: any) => {
                const albumName = albumContext.name || track.albumName || "Unknown Album";
                const albumUrl = albumContext.url || track.albumUrl || "";
                const albumArt = albumContext.albumImages?.[0] || track.albumArt || "";
                const albumId = normalizeAlbumId(albumContext.albumId || albumUrl || track.albumId || track.url || albumArt);
                return normalizeLikedTrack({
                    ...track,
                    albumName,
                    albumUrl,
                    albumArt,
                    albumId: albumId || undefined,
                    albumArtist: albumContext.albumArtist || track.albumArtist || '',
                    albumType: albumContext.albumType || track.albumType || '',
                    year: albumContext.year || track.year || ''
                });
            });

        setLikedTracks((prev) => {
            const prevUrls = prev.map((track: any) => String(track?.url || '').trim()).filter((url: string) => url.length > 0);
            const albumUrls = albumTracks.map((track: any) => String(track?.url || '').trim()).filter((url: string) => url.length > 0);
            const prevUrlSet = new Set<string>(prevUrls);
            const albumUrlSet = new Set<string>(albumUrls);
            const albumFullyLiked = albumUrls.length > 0 && albumUrls.every((url: string) => prevUrlSet.has(url));

            if (albumFullyLiked) {
                return prev.filter((track: any) => !albumUrlSet.has(String(track?.url || '').trim()));
            }

            const missing = albumTracks.filter((track: any) => {
                const url = String(track?.url || '').trim();
                return !!url && !prevUrlSet.has(url);
            });
            const now = Date.now();
            const likedMissing = missing.map((track: any, index: number) => (
                normalizeLikedTrack({ ...(track || {}), likedAt: Math.max(1, now - index) })
            ));
            return [...likedMissing, ...prev];
        });
    }, [selectedAlbum, selectedUrl]);

    const cancelSelectedAlbumDownload = useCallback(() => {
        if (!albumQueueItemId) return;
        dlManager.cancel(albumQueueItemId);
    }, [albumQueueItemId]);

    const toggleLike = useCallback((track: any) => {
        setLikedTracks(prev => {
            const exists = prev.find(t => t.url === track.url);
            if (exists) return prev.filter(t => t.url !== track.url);

            return [normalizeLikedTrack({ ...track, likedAt: Date.now() }), ...prev];
        });
    }, []);

    const isLiked = useCallback((trackUrl: string) => {
        return likedTracks.some(t => t.url === trackUrl);
    }, [likedTracks]);
    const likedTrackUrlSet = useMemo(
        () => new Set(likedTracks.map((track: any) => String(track?.url || '').trim()).filter(Boolean)),
        [likedTracks]
    );

    const isSelectedAlbumLiked = useMemo(() => {
        if (!selectedAlbum?.tracks?.length) return false;
        const likedUrls = new Set(likedTracks.map((track: any) => String(track?.url || '').trim()).filter(Boolean));
        const albumUrls = selectedAlbum.tracks.map((track: any) => String(track?.url || '').trim()).filter(Boolean);
        if (albumUrls.length === 0) return false;
        return albumUrls.every((url: string) => likedUrls.has(url));
    }, [likedTracks, selectedAlbum]);

    const getUniquePlaylistName = useCallback((rawName: string, existingPlaylists: Playlist[], excludeId?: string) => {
        const desired = sanitizePlaylistName(rawName);
        const namesInUse = new Set(
            existingPlaylists
                .filter((playlist) => !excludeId || playlist.id !== excludeId)
                .map((playlist) => playlist.name.toLowerCase())
        );
        if (!namesInUse.has(desired.toLowerCase())) return desired;
        let counter = 2;
        let candidate = sanitizePlaylistName(`${desired} ${counter}`);
        while (namesInUse.has(candidate.toLowerCase())) {
            counter += 1;
            candidate = sanitizePlaylistName(`${desired} ${counter}`);
        }
        return candidate;
    }, []);

    const toPlaylistTrack = useCallback((rawTrack: any): PlaylistTrack | null => {
        const prepared = buildPlaybackTrack(normalizeLikedTrack(rawTrack || {}));
        const normalized = normalizePlaylistTrack({
            ...prepared,
            trackKey: getPlaybackTrackKey(prepared),
            addedAt: Date.now(),
        });
        if (!normalized) return null;
        return {
            ...normalized,
            albumId: normalizeAlbumId(normalized.albumId || normalized.albumUrl || normalized.url || normalized.albumArt) || undefined,
        };
    }, [buildPlaybackTrack]);

    const toUniquePlaylistTracks = useCallback((rawTracks: any[]): PlaylistTrack[] => {
        const normalizedTracks = (Array.isArray(rawTracks) ? rawTracks : [])
            .map((track) => toPlaylistTrack(track))
            .filter(Boolean) as PlaylistTrack[];
        if (normalizedTracks.length <= 1) return normalizedTracks;

        const seen = new Set<string>();
        const unique: PlaylistTrack[] = [];
        normalizedTracks.forEach((track) => {
            const key = String(track?.trackKey || '').trim();
            if (!key || seen.has(key)) return;
            seen.add(key);
            unique.push(track);
        });
        return unique;
    }, [toPlaylistTrack]);

    const createPlaylist = useCallback((name: string, bylineRaw?: string): string | null => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return null;
        const uniqueName = getUniquePlaylistName(trimmed, playlists);
        const byline = sanitizePlaylistByline(bylineRaw);
        const nextPlaylist = createPlaylistRecord(uniqueName, byline);
        setPlaylists((prev) => [nextPlaylist, ...prev]);
        setSelectedPlaylistId(nextPlaylist.id);
        return nextPlaylist.id;
    }, [getUniquePlaylistName, playlists]);

    const renamePlaylist = useCallback((playlistId: string, nextName: string, nextBylineRaw?: string) => {
        const trimmed = String(nextName || '').trim();
        if (!trimmed) return;
        const nextByline = sanitizePlaylistByline(nextBylineRaw);
        setPlaylists((prev) => {
            const uniqueName = getUniquePlaylistName(trimmed, prev, playlistId);
            return prev.map((playlist) => {
                if (playlist.id !== playlistId) return playlist;
                const currentByline = sanitizePlaylistByline(playlist.byline || '');
                if (playlist.name === uniqueName && currentByline === nextByline) return playlist;

                const updated = {
                    ...playlist,
                    name: uniqueName,
                    updatedAt: Date.now(),
                    revision: playlist.revision + 1,
                };

                if (!nextByline) {
                    const { byline: _removed, ...rest } = updated;
                    return rest;
                }

                return {
                    ...updated,
                    byline: nextByline,
                };
            });
        });
    }, [getUniquePlaylistName]);

    const deletePlaylist = useCallback((playlistId: string) => {
        const normalizedPlaylistId = String(playlistId || '').trim();
        if (!normalizedPlaylistId) return;

        const cachedSecretsByShareId = playlistShareSecretsRef.current[normalizedPlaylistId] || {};
        const cachedShareSecretEntries = Object.entries(cachedSecretsByShareId).map(([shareId, secret]) => ({
            shareId: String(shareId || '').trim(),
            editToken: String(secret?.editToken || '').trim(),
        }));
        delete playlistShareSecretsRef.current[normalizedPlaylistId];

        if (typeof window !== 'undefined') {
            const cachedShareMap = readPlaylistShareReuseCache(window.localStorage);
            const nextShareMap = removePlaylistShareReuseCacheEntries(cachedShareMap, normalizedPlaylistId);
            writePlaylistShareReuseCache(window.localStorage, nextShareMap);
        }

        if (playlistRouteIdentifier && selectedPlaylistId === normalizedPlaylistId) {
            setPlaylistRouteIdentifier(null);
            if (typeof window !== 'undefined') {
                const targetPath = getPathForView('playlists');
                const currentUrl = `${window.location.pathname}${window.location.search}`;
                if (currentUrl !== targetPath) {
                    const currentState = (window.history.state && typeof window.history.state === 'object')
                        ? window.history.state
                        : {};
                    window.history.replaceState({ ...currentState }, '', targetPath);
                }
            }
        }
        setPlaylists((prev) => prev.filter((playlist) => playlist.id !== normalizedPlaylistId));
        setSelectedPlaylistId((prev) => (prev === normalizedPlaylistId ? null : prev));

        if (cachedShareSecretEntries.length === 0) return;

        const revocableEntries = cachedShareSecretEntries.filter((entry) => {
            const shareId = String(entry.shareId || '').trim();
            const editToken = String(entry.editToken || '').trim();
            return Boolean(shareId && editToken);
        });

        void (async () => {
            if (revocableEntries.length > 0) {
                const revokeResults = await Promise.allSettled(
                    revocableEntries.map((entry) =>
                        api.revokePlaylistShare(String(entry.shareId || '').trim(), String(entry.editToken || '').trim())
                    )
                );

                if (typeof window !== 'undefined') {
                    const revokedShareIds = revokeResults
                        .map((result, index) => ({ result, entry: revocableEntries[index] }))
                        .filter(({ result }) => result.status === 'fulfilled')
                        .map(({ entry }) => String(entry.shareId || '').trim())
                        .filter((shareId) => !!shareId);
                    notifySharedPlaylistInvalidation(window.localStorage, revokedShareIds);
                }
            }
        })();
    }, [playlistRouteIdentifier, selectedPlaylistId]);

    const addTracksToPlaylist = useCallback((playlistId: string, rawTracks: any[]): PlaylistAddResult => {
        const requestedCount = Array.isArray(rawTracks) ? rawTracks.length : 0;
        const uniqueTracks = toUniquePlaylistTracks(rawTracks);
        const target = playlists.find((playlist) => playlist.id === playlistId);
        if (!target) {
            return {
                playlistId,
                playlistFound: false,
                requestedCount,
                uniqueSelectedCount: uniqueTracks.length,
                addedCount: 0,
                existingCount: 0,
                addedTrackKeys: [],
            };
        }

        const existingKeys = new Set<string>(
            (target.tracks || []).map((track) => String(track?.trackKey || '').trim()).filter(Boolean)
        );
        const toAdd: PlaylistTrack[] = [];
        let existingCount = 0;
        uniqueTracks.forEach((track) => {
            const key = String(track?.trackKey || '').trim();
            if (!key) return;
            if (existingKeys.has(key)) {
                existingCount += 1;
                return;
            }
            existingKeys.add(key);
            toAdd.push(track);
        });

        const addedCount = toAdd.length;
        const addedTrackKeys = toAdd
            .map((track) => String(track?.trackKey || '').trim())
            .filter(Boolean);
        if (addedCount > 0) {
            const now = Date.now();
            setPlaylists((prev) => prev.map((playlist) => {
                if (playlist.id !== playlistId) return playlist;
                return {
                    ...playlist,
                    tracks: [...playlist.tracks, ...toAdd],
                    updatedAt: now,
                    revision: playlist.revision + 1,
                };
            }));
        }

        return {
            playlistId,
            playlistFound: true,
            requestedCount,
            uniqueSelectedCount: uniqueTracks.length,
            addedCount,
            existingCount,
            addedTrackKeys,
        };
    }, [playlists, toUniquePlaylistTracks]);

    const removeTracksFromPlaylist = useCallback((playlistId: string, rawTracks: any[]): PlaylistRemoveResult => {
        const requestedCount = Array.isArray(rawTracks) ? rawTracks.length : 0;
        const uniqueTracks = toUniquePlaylistTracks(rawTracks);
        const target = playlists.find((playlist) => playlist.id === playlistId);
        if (!target) {
            return {
                playlistId,
                playlistFound: false,
                requestedCount,
                uniqueSelectedCount: uniqueTracks.length,
                removedCount: 0,
                missingCount: 0,
                removedTrackKeys: [],
            };
        }

        const removeKeySet = new Set<string>(
            uniqueTracks
                .map((track) => String(track?.trackKey || '').trim())
                .filter(Boolean)
        );
        if (removeKeySet.size <= 0) {
            return {
                playlistId,
                playlistFound: true,
                requestedCount,
                uniqueSelectedCount: uniqueTracks.length,
                removedCount: 0,
                missingCount: 0,
                removedTrackKeys: [],
            };
        }

        const removedTrackKeys = target.tracks
            .filter((track) => removeKeySet.has(String(track?.trackKey || '').trim()))
            .map((track) => String(track?.trackKey || '').trim())
            .filter(Boolean);
        const removedCount = removedTrackKeys.length;
        const missingCount = Math.max(0, removeKeySet.size - removedCount);

        if (removedCount > 0) {
            const now = Date.now();
            setPlaylists((prev) => prev.map((playlist) => {
                if (playlist.id !== playlistId) return playlist;
                return {
                    ...playlist,
                    tracks: playlist.tracks.filter((track) => !removeKeySet.has(String(track?.trackKey || '').trim())),
                    updatedAt: now,
                    revision: playlist.revision + 1,
                };
            }));
        }

        return {
            playlistId,
            playlistFound: true,
            requestedCount,
            uniqueSelectedCount: uniqueTracks.length,
            removedCount,
            missingCount,
            removedTrackKeys,
        };
    }, [playlists, toUniquePlaylistTracks]);

    const createPlaylistAndAddTracks = useCallback((name: string, rawTracks: any[], bylineRaw?: string): PlaylistCreateAndAddResult => {
        const requestedCount = Array.isArray(rawTracks) ? rawTracks.length : 0;
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            return {
                playlistId: null,
                created: false,
                requestedCount,
                uniqueSelectedCount: 0,
                addedCount: 0,
                existingCount: 0,
                addedTrackKeys: [],
            };
        }

        const uniqueTracks = toUniquePlaylistTracks(rawTracks);
        const uniqueName = getUniquePlaylistName(trimmed, playlists);
        const byline = sanitizePlaylistByline(bylineRaw);
        const created = createPlaylistRecord(uniqueName, byline);
        const appended = appendTracksToPlaylist(created, uniqueTracks);
        const addedCount = appended.addedCount;
        const existingCount = Math.max(0, uniqueTracks.length - addedCount);
        const addedTrackKeys = uniqueTracks
            .map((track) => String(track?.trackKey || '').trim())
            .filter(Boolean);

        setPlaylists((prev) => [appended.playlist, ...prev]);
        setSelectedPlaylistId(appended.playlist.id);

        return {
            playlistId: appended.playlist.id,
            created: true,
            requestedCount,
            uniqueSelectedCount: uniqueTracks.length,
            addedCount,
            existingCount,
            addedTrackKeys,
        };
    }, [getUniquePlaylistName, playlists, toUniquePlaylistTracks]);

    const removePlaylistTrack = useCallback((playlistId: string, trackIndex: number) => {
        setPlaylists((prev) => prev.map((playlist) => {
            if (playlist.id !== playlistId) return playlist;
            return removeTrackAtIndex(playlist, trackIndex);
        }));
    }, []);

    const movePlaylistTrack = useCallback((playlistId: string, fromIndex: number, toIndex: number) => {
        setPlaylists((prev) => prev.map((playlist) => {
            if (playlist.id !== playlistId) return playlist;
            return moveTrackInPlaylist(playlist, fromIndex, toIndex);
        }));
    }, []);

    const closePlaylistPicker = useCallback(() => {
        setPlaylistPickerState((prev) => ({ ...prev, open: false, tracks: [] }));
    }, []);

    const trackHasRecentPlaylistAdd = useCallback((track: any) => {
        const directKey = String(track?.trackKey || '').trim();
        const fallbackKey = getPlaybackTrackKey(track);
        const key = directKey || fallbackKey;
        if (!key) return false;
        const expiry = Number(playlistAddFeedbackByTrackKey[key] || 0);
        return expiry > Date.now();
    }, [playlistAddFeedbackByTrackKey]);

    const handlePlaylistAddSuccess = useCallback((payload: {
        mode: 'track' | 'album' | 'queue';
        tracks: any[];
        addedTrackKeys: string[];
    }) => {
        const now = Date.now();
        const expiresAt = now + PLAYLIST_ADD_FEEDBACK_MS;
        const uniqueKeys = [...new Set((Array.isArray(payload.addedTrackKeys) ? payload.addedTrackKeys : [])
            .map((key) => String(key || '').trim())
            .filter(Boolean))];

        if (uniqueKeys.length > 0) {
            setPlaylistAddFeedbackByTrackKey((prev) => {
                const next = { ...prev };
                uniqueKeys.forEach((key) => {
                    next[key] = expiresAt;
                });
                return next;
            });

            const feedbackTimerId = window.setTimeout(() => {
                setPlaylistAddFeedbackByTrackKey((prev) => {
                    let changed = false;
                    const next: Record<string, number> = { ...prev };
                    uniqueKeys.forEach((key) => {
                        if (Number(next[key] || 0) <= Date.now()) {
                            delete next[key];
                            changed = true;
                        }
                    });
                    return changed ? next : prev;
                });
                playlistAddFeedbackTimersRef.current = playlistAddFeedbackTimersRef.current.filter((id) => id !== feedbackTimerId);
            }, PLAYLIST_ADD_FEEDBACK_MS + 60);
            playlistAddFeedbackTimersRef.current.push(feedbackTimerId);
        }

        const selectedTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
        const addedKeySet = new Set(uniqueKeys);
        const toastSourceTrack =
            selectedTracks.find((track) => addedKeySet.has(String(track?.trackKey || '').trim())) ||
            selectedTracks[0];
        const albumName = String(
            toastSourceTrack?.albumName ||
            selectedAlbum?.name ||
            'Unknown Album'
        ).trim() || 'Unknown Album';
        showInlineToast(`Album ${albumName} added to playlist.`);

        if (payload.mode === 'album') {
            setIsAlbumPlaylistFeedbackActive(true);
            if (albumPlaylistFeedbackTimeoutRef.current !== null) {
                window.clearTimeout(albumPlaylistFeedbackTimeoutRef.current);
                albumPlaylistFeedbackTimeoutRef.current = null;
            }
            albumPlaylistFeedbackTimeoutRef.current = window.setTimeout(() => {
                setIsAlbumPlaylistFeedbackActive(false);
                albumPlaylistFeedbackTimeoutRef.current = null;
            }, PLAYLIST_ADD_FEEDBACK_MS);
        }
    }, [selectedAlbum?.name, showInlineToast]);

    const openPlaylistPicker = useCallback((mode: 'track' | 'album' | 'queue', rawTracks: any[]) => {
        const tracks = (Array.isArray(rawTracks) ? rawTracks : [])
            .map((track) => toPlaylistTrack(track))
            .filter(Boolean);
        if (tracks.length === 0) return;
        setPlaylistPickerState({
            open: true,
            mode,
            tracks,
        });
    }, [toPlaylistTrack]);

    const handleAddCurrentAlbumToPlaylist = useCallback(() => {
        if (!selectedAlbum?.tracks?.length) return;
        openPlaylistPicker('album', selectedAlbum.tracks);
    }, [openPlaylistPicker, selectedAlbum]);

    const handleAddTrackToPlaylist = useCallback((track: any) => {
        openPlaylistPicker('track', [track]);
    }, [openPlaylistPicker]);

    const handleAddQueueTrackToPlaylist = useCallback((track: any) => {
        queueOverlayHostRef.current?.close();
        openPlaylistPicker('queue', [track]);
    }, [openPlaylistPicker]);

    const handleAddManualQueueToPlaylist = useCallback(() => {
        const manualTracks = queue.filter((queuedTrack: any) => queuedTrack?.queueSource === 'manual');
        if (manualTracks.length <= 0) {
            showInlineToast('Manual queue is empty.', 'error');
            return;
        }
        queueOverlayHostRef.current?.close();
        openPlaylistPicker('queue', manualTracks);
    }, [openPlaylistPicker, queue, showInlineToast]);

    const triggerJsonDownload = useCallback((payload: unknown, filename: string) => {
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: 'application/json;charset=utf-8',
        });
        const objectUrl = URL.createObjectURL(blob);
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute('href', objectUrl);
        downloadAnchorNode.setAttribute('download', filename);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        URL.revokeObjectURL(objectUrl);
    }, []);

    const copyTextToClipboard = useCallback(async (rawText: string) => {
        const text = String(rawText || '').trim();
        if (!text) return false;
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
            return false;
        }
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }, []);

    const exportPlaylists = useCallback(() => {
        const payload = buildPlaylistsExportPayload(playlists);
        triggerJsonDownload(payload, PLAYLISTS_ALL_EXPORT_FILENAME);
    }, [playlists, triggerJsonDownload]);

    const exportSinglePlaylist = useCallback((playlistId: string) => {
        const targetPlaylist = playlists.find((playlist) => playlist.id === playlistId);
        if (!targetPlaylist) {
            showAppNotice('Could not find the selected playlist to export.', 'Export Failed');
            return;
        }
        const identifier = toPlaylistRouteIdentifier(targetPlaylist);
        const payload = buildPlaylistsExportPayload([targetPlaylist]);
        triggerJsonDownload(payload, `khi-dl-${identifier}.json`);
    }, [playlists, showAppNotice, triggerJsonDownload]);

    const downloadPlaylistAsZip = useCallback((payload: { name: string; tracks: any[] }) => {
        const playlistName = sanitizePlaylistName(payload?.name || 'Playlist');
        const sourceTracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
        const tracks = sourceTracks
            .filter((track) => String(track?.url || '').trim().length > 0)
            .map((track, index) => ({
                ...track,
                title: String(track?.title || `Track ${index + 1}`),
                number: track?.number ?? (index + 1),
            }));

        if (tracks.length === 0) {
            showInlineToast('Playlist has no downloadable tracks.', 'error');
            return;
        }

        dlManager.addAlbumToQueue({
            name: playlistName,
            tracks,
            albumImages: [],
        });
        showInlineToast(`Queued "${playlistName}" for ZIP download.`, 'success');
    }, [showInlineToast]);

    const importPlaylists = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            try {
                const text = String(loadEvent.target?.result || '');
                const summary = importPlaylistsFromJson(text, playlists);
                setPlaylists(summary.playlists);
                if (summary.created > 0) {
                    const firstImported = summary.playlists[playlists.length];
                    if (firstImported?.id) {
                        setSelectedPlaylistId(firstImported.id);
                    }
                }
                showAppNotice(
                    `Imported playlists: ${summary.created}, merged: ${summary.merged}, tracks added: ${summary.tracksAdded}, invalid entries: ${summary.invalidEntries}.`,
                    'Playlists Imported'
                );
            } catch (error: any) {
                const message = String(error?.message || 'Failed to import playlists.');
                console.error(error);
                showAppNotice(message, 'Import Failed');
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }, [playlists, showAppNotice]);

    const createPlaylistShareLink = useCallback(async (playlistId: string) => {
        const normalizedPlaylistId = String(playlistId || '').trim();
        if (!normalizedPlaylistId) {
            showInlineToast('Could not find playlist to share.', 'error');
            return;
        }

        const targetPlaylist = playlists.find((playlist) => playlist.id === normalizedPlaylistId);
        if (!targetPlaylist) {
            showInlineToast('Could not find playlist to share.', 'error');
            return;
        }

        const normalized = normalizeSharedPlaylistPayload({
            name: targetPlaylist.name,
            byline: targetPlaylist.byline,
            tracks: targetPlaylist.tracks,
        });
        if (!normalized.ok) {
            showInlineToast(normalized.error, 'error');
            return;
        }

        try {
            let reuseShareId = '';
            let reuseShareKey = '';
            if (typeof window !== 'undefined') {
                const cachedShareMap = readPlaylistShareReuseCache(window.localStorage);
                const cachedEntries = Array.isArray(cachedShareMap[normalizedPlaylistId])
                    ? cachedShareMap[normalizedPlaylistId]
                    : [];
                const playlistSecrets = playlistShareSecretsRef.current[normalizedPlaylistId] || {};
                const reusableEntry = cachedEntries.find((entry) => {
                    const secret = playlistSecrets[String(entry.shareId || '').trim()];
                    const shareKey = String(secret?.shareKey || '').trim();
                    return !!shareKey;
                });
                if (reusableEntry) {
                    reuseShareId = reusableEntry.shareId;
                    reuseShareKey = String(playlistSecrets[reuseShareId]?.shareKey || '').trim();
                }
            }

            const created = await api.createPlaylistShare(normalized.playlist, {
                ...(reuseShareId ? { reuseShareId } : {}),
                ...(reuseShareKey ? { reuseShareKey } : {}),
            });

            if (typeof window !== 'undefined') {
                const cachedShareMap = readPlaylistShareReuseCache(window.localStorage);
                const existingForShare = (cachedShareMap[normalizedPlaylistId] || []).find((entry) => entry.shareId === created.shareId);
                const contentHash = String(created.contentHash || existingForShare?.contentHash || '').trim();
                const editToken = String(created.editToken || '').trim();
                const shareKey = String(created.shareKey || '').trim();

                if (shareKey || editToken) {
                    const existingSecrets = playlistShareSecretsRef.current[normalizedPlaylistId] || {};
                    const previous = existingSecrets[created.shareId] || { updatedAt: 0 };
                    playlistShareSecretsRef.current[normalizedPlaylistId] = {
                        ...existingSecrets,
                        [created.shareId]: {
                            updatedAt: Date.now(),
                            ...(shareKey ? { shareKey } : (previous.shareKey ? { shareKey: previous.shareKey } : {})),
                            ...(editToken ? { editToken } : (previous.editToken ? { editToken: previous.editToken } : {})),
                        },
                    };
                }

                const nextShareMap = upsertPlaylistShareReuseCacheEntry(cachedShareMap, normalizedPlaylistId, {
                    shareId: created.shareId,
                    updatedAt: Date.now(),
                    ...(contentHash ? { contentHash } : {}),
                });
                writePlaylistShareReuseCache(window.localStorage, nextShareMap);
            }

            const copied = await copyTextToClipboard(created.url);
            if (copied) {
                showInlineToast('Share link copied to clipboard.', 'success');
            } else {
                showInlineToast('Could not copy automatically. Link shown in popup.', 'error');
                showAppNotice(`Share link:\n${created.url}`, 'Playlist Shared');
            }
            showPlaylistShareHint('share');
            return;
        } catch (error: any) {
            const message = String(error?.message || 'Failed to create secure share link.');
            showInlineToast(message, 'error');
        }
    }, [copyTextToClipboard, playlists, showAppNotice, showInlineToast, showPlaylistShareHint]);

    const buildCanonicalAlbumShareUrl = useCallback((options?: { trackToken?: string; albumPath?: string }) => {
        if (typeof window === 'undefined') return '';

        let albumPath =
            normalizeAlbumId(options?.albumPath || selectedAlbum?.albumId || selectedUrl || '') ||
            getCanonicalAlbumPathFromPathname(window.location.pathname);

        if (!albumPath) {
            const params = new URLSearchParams(window.location.search);
            const albumParam = toAlbumUrlParam(String(params.get('album') || '').trim());
            albumPath = normalizeAlbumId(albumParam);
        }

        if (!albumPath) return '';

        const url = new URL(albumPath, window.location.origin);
        const trackToken = String(options?.trackToken || '').trim();
        if (trackToken) {
            url.searchParams.set('track', trackToken);
        }
        return url.toString();
    }, [selectedAlbum?.albumId, selectedUrl]);

    const handleShareAlbumLink = useCallback(async () => {
        const shareUrl = buildCanonicalAlbumShareUrl();
        if (!shareUrl) {
            showInlineToast('Could not build album share link.', 'error');
            return;
        }
        const copied = await copyTextToClipboard(shareUrl);
        if (copied) {
            showInlineToast('Album link copied to clipboard.', 'success');
        } else {
            showInlineToast('Could not copy automatically. Album link shown in popup.', 'error');
            showAppNotice(`Album link:\n${shareUrl}`, 'Album Shared');
        }
    }, [buildCanonicalAlbumShareUrl, copyTextToClipboard, showAppNotice, showInlineToast]);

    const handleShareTrackLink = useCallback(async (track: any) => {
        const trackTarget = normalizeTrackPathForMatch(track?.url);
        const explicitAlbumPath = normalizeAlbumId(track?.albumId || track?.albumUrl || track?.url || track?.albumArt || '');
        const trackNumberRaw = Number.parseInt(String(track?.number || '').trim(), 10);
        const trackNumber = Number.isFinite(trackNumberRaw) && trackNumberRaw > 0
            ? trackNumberRaw
            : null;
        const trackToken = trackNumber !== null
            ? (trackTarget ? `n:${trackNumber}|${trackTarget}` : `n:${trackNumber}`)
            : trackTarget;
        if (!trackToken) {
            showInlineToast('Could not build track share link.', 'error');
            return;
        }
        const shareUrl = buildCanonicalAlbumShareUrl({
            trackToken,
            albumPath: explicitAlbumPath,
        });
        if (!shareUrl) {
            showInlineToast('Could not build track share link.', 'error');
            return;
        }
        const copied = await copyTextToClipboard(shareUrl);
        if (copied) {
            showInlineToast('Track link copied to clipboard.', 'success');
        } else {
            showInlineToast('Could not copy automatically. Track link shown in popup.', 'error');
            showAppNotice(`Track link:\n${shareUrl}`, 'Track Shared');
        }
    }, [buildCanonicalAlbumShareUrl, copyTextToClipboard, showAppNotice, showInlineToast]);

    const playTrackWithResolution = useCallback(async (trackData: any) => {
        const resolvedTrack = trackData || {};
        const resolvedUrl = String(resolvedTrack?.url || '').trim();
        if (!resolvedUrl) {
            setIsPlaying(false);
            setAudioLoadingDebounced(false);
            return;
        }

        const requestId = playbackRequestSeqRef.current + 1;
        playbackRequestSeqRef.current = requestId;
        if (playbackResolveControllerRef.current) {
            playbackResolveControllerRef.current.abort();
        }
        const controller = new AbortController();
        playbackResolveControllerRef.current = controller;

        const media = audioRef.current;
        if (media) {
            media.pause();
        }

        isChangingTrackRef.current = true;
        setCurrentTrack(resolvedTrack);
        setIsPlaying(true);
        setAudioLoadingDebounced(true);

        try {
            const formats = await dlManager.resolveTrackFormats(resolvedUrl, controller.signal);
            if (requestId !== playbackRequestSeqRef.current || controller.signal.aborted) return;

            const directUrl = dlManager.pickDirectUrl(formats);
            if (!directUrl) {
                throw new Error('No playable format found for this track.');
            }

            const playbackMedia = audioRef.current;
            if (!playbackMedia) return;

            playbackMedia.src = directUrl;
            playbackMedia.volume = volume;
            if ((playbackMedia as any).mozPreservesPitch !== undefined) {
                (playbackMedia as any).mozPreservesPitch = false;
            } else {
                (playbackMedia as any).preservesPitch = false;
            }

            const playPromise = playbackMedia.play();
            if (playPromise !== undefined) {
                playPromise.catch((e) => {
                    if (requestId !== playbackRequestSeqRef.current || controller.signal.aborted) return;
                    if (audioRef.current && !audioRef.current.src.includes('/api/download')) {
                        console.warn("Direct playback failed, switching to proxy...");
                        audioRef.current.src = `/api/download?url=${encodeURIComponent(directUrl)}`;
                        audioRef.current.play().catch((err) => {
                            if (!isAbortLikeError(err) && !isTimeoutLikeError(err)) {
                                console.error("Proxy playback failed", err);
                            }
                        });
                    } else if (!isAbortLikeError(e) && !isTimeoutLikeError(e)) {
                        console.error("Playback failed", e);
                    }
                });
            }
        } catch (e) {
            if (requestId !== playbackRequestSeqRef.current || controller.signal.aborted) return;
            if (!isAbortLikeError(e) && !isTimeoutLikeError(e)) {
                console.error("Failed to resolve track for streaming", e);
            }
            setIsPlaying(false);
            setAudioLoadingDebounced(false);
        } finally {
            if (requestId === playbackRequestSeqRef.current) {
                isChangingTrackRef.current = false;
                if (playbackResolveControllerRef.current === controller) {
                    playbackResolveControllerRef.current = null;
                }
            }
        }
    }, [setAudioLoadingDebounced, volume]);

    const playTrack = useCallback(async (
        track: any,
        albumTracks: any[] = [],
        options?: { forceAlbumQueue?: boolean }
    ) => {
        if (!selectedAlbum && !track.albumName) {
            return;
        }
        const albumName = track.albumName || (selectedAlbum ? selectedAlbum.name : "");
        const albumId = normalizeAlbumId(track.albumId || selectedAlbum?.albumId || selectedUrl || track.url || track.albumArt);

        const highResArt = track.albumArt || (selectedAlbum ? selectedAlbum.albumImages?.[0] : "") || "";
        const lowResArt = track.thumbnail || (selectedAlbum ? selectedAlbum.imagesThumbs?.[0] : "") || highResArt || "";

        const albumUrl = selectedUrl || track.albumUrl || "";

        if (!options?.forceAlbumQueue && currentTrack?.url && track?.url && currentTrack.url === track.url) {
            if (audioRef.current) {
                if (isPlaying) audioRef.current.pause();
                else audioRef.current.play().catch(() => { });
                setIsPlaying(!isPlaying);
            }
            return;
        }

        const currentQueueSnapshot = Array.isArray(queueRef.current) ? queueRef.current : [];
        const hasManualQueue = currentQueueSnapshot.some((queuedTrack: any) => queuedTrack?.queueSource === 'manual');
        if (!options?.forceAlbumQueue && hasManualQueue) {
            const manualTrackData = {
                ...track,
                albumName,
                albumArt: highResArt,
                thumbnail: lowResArt,
                albumUrl,
                albumId,
                queueSource: 'manual',
            };
            const nextQueue = [...currentQueueSnapshot];
            let targetIdx = nextQueue.findIndex((queuedTrack: any) => isSamePlaybackTrack(queuedTrack, manualTrackData));
            if (targetIdx === -1) {
                const activeIndex = currentTrackIndexRef.current;
                const insertAt = currentTrack ? Math.min(Math.max(activeIndex + 1, 0), nextQueue.length) : nextQueue.length;
                nextQueue.splice(insertAt, 0, manualTrackData);
                targetIdx = insertAt;
            }
            queueRef.current = nextQueue;
            if (nextQueue.length > 150) {
                startTransition(() => {
                    setQueue(nextQueue);
                });
            } else {
                setQueue(nextQueue);
            }
            if (targetIdx >= 0) {
                setCurrentTrackIndexWithRef(targetIdx);
            }
            setPlaybackSourceLabel('Manual Queue');
            await playTrackWithResolution(manualTrackData);
            return;
        }

        let newQueue: any[] = [];
        if (albumTracks.length > 0) {
            newQueue = albumTracks.map(t => ({
                ...t,
                albumName: t.albumName || albumName,
                albumArt: t.albumArt || highResArt,
                thumbnail: t.thumbnail || t.albumArt || lowResArt,
                albumUrl: t.albumUrl || albumUrl,
                albumId: normalizeAlbumId(t.albumId || albumId || t.albumUrl || t.url || t.albumArt),
                queueSource: 'context',
            }));
        } else {
            newQueue = [{ ...track, albumName, albumArt: highResArt, thumbnail: lowResArt, albumUrl, albumId, queueSource: 'context' }];
        }

        let idx = newQueue.findIndex((t) => isSamePlaybackTrack(t, track));
        if (idx === -1) idx = 0;
        const preservedManual = currentQueueSnapshot
            .filter((queuedTrack: any) => queuedTrack?.queueSource === 'manual')
            .filter((queuedTrack: any) => !newQueue.some((contextTrack: any) => isSamePlaybackTrack(contextTrack, queuedTrack)));
        const mergedQueue = [...newQueue, ...preservedManual];

        queueRef.current = mergedQueue;
        if (mergedQueue.length > 150) {
            startTransition(() => {
                setQueue(mergedQueue);
            });
        } else {
            setQueue(mergedQueue);
        }
        setCurrentTrackIndexWithRef(idx);
        setPlaybackSourceLabel(albumName ? `From ${albumName}` : 'Album Queue');

        const trackData = { ...track, albumName, albumArt: highResArt, thumbnail: lowResArt, albumUrl, albumId, queueSource: 'context' };
        await playTrackWithResolution(trackData);
    }, [selectedAlbum, selectedUrl, currentTrack, isPlaying, playTrackWithResolution]);

    const scrollAlbumTrackIntoView = useCallback((originalIndex: number) => {
        if (typeof window === 'undefined') return;
        const safeIndex = Number.isFinite(originalIndex) ? Math.max(0, Math.trunc(originalIndex)) : -1;
        if (safeIndex < 0) return;

        if (trackFilterQuery.trim().length > 0) {
            setTrackFilterQuery('');
        }

        const rowHeight = Math.max(1, virtualTrackRowHeight || TRACKLIST_VIRTUALIZATION_FALLBACK_ROW_HEIGHT);
        const maxAttempts = 8;
        const overscan = TRACKLIST_VIRTUALIZATION_OVERSCAN_ROWS;

        const attemptScroll = (attempt: number) => {
            const root = panelContentRef.current;
            const list = trackListRef.current;
            if (!root || !list) {
                if (attempt < maxAttempts) {
                    window.requestAnimationFrame(() => attemptScroll(attempt + 1));
                }
                return;
            }

            setVirtualTrackRange((prev) => {
                const targetStart = Math.max(0, safeIndex - overscan);
                const targetEnd = safeIndex + overscan;
                if (prev.start <= safeIndex && prev.end >= safeIndex) return prev;
                if (prev.start === targetStart && prev.end === targetEnd) return prev;
                return { start: targetStart, end: targetEnd };
            });

            const rootRect = root.getBoundingClientRect();
            const listRect = list.getBoundingClientRect();
            const listTopInRoot = root.scrollTop + (listRect.top - rootRect.top);
            const estimatedTop = Math.max(
                0,
                listTopInRoot + (safeIndex * rowHeight) - (root.clientHeight * 0.32)
            );
            root.scrollTo({ top: estimatedTop, behavior: 'auto' });

            const rowHost = list.querySelector(`[data-track-index="${safeIndex}"]`) as HTMLElement | null;
            const rowElement = (rowHost?.querySelector('.track-row') as HTMLElement | null) || rowHost;
            if (rowElement) {
                rowElement.scrollIntoView({ block: 'center', behavior: 'auto' });
                return;
            }

            if (attempt < maxAttempts) {
                window.requestAnimationFrame(() => attemptScroll(attempt + 1));
            }
        };

        window.requestAnimationFrame(() => attemptScroll(0));
    }, [trackFilterQuery, virtualTrackRowHeight]);

    useEffect(() => {
        const pendingTarget = pendingSharedTrackTargetRef.current;
        if (!pendingTarget.pathTarget && !pendingTarget.aliasTarget && !pendingTarget.nameKey && pendingTarget.numberTarget === null) {
            return;
        }
        if (!selectedAlbum?.tracks?.length) return;
        const currentAlbumId = normalizeAlbumId(selectedAlbum?.albumId || selectedUrl || '');
        const pendingAlbumId = pendingSharedTrackAlbumIdRef.current;
        if (pendingAlbumId && currentAlbumId && pendingAlbumId !== currentAlbumId) {
            return;
        }

        const getTrackNumber = (track: any) => {
            const parsed = Number.parseInt(String(track?.number || '').trim(), 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        };

        type TrackMatchCandidate = {
            track: any;
            originalIndex: number;
            pathKey: string;
            aliasKey: string;
            nameKey: string;
            numberKey: number | null;
        };

        const candidateRows: TrackMatchCandidate[] = selectedAlbum.tracks.map((track: any, originalIndex: number) => {
            const pathKey = normalizeTrackPathForMatch(track?.url);
            return {
                track,
                originalIndex,
                pathKey,
                aliasKey: toAlbumPathAlias(pathKey),
                nameKey: toTrackNameKey(pathKey || track?.title || ''),
                numberKey: getTrackNumber(track),
            };
        });

        let matchedRow = null as TrackMatchCandidate | null;
        if (pendingTarget.pathTarget) {
            matchedRow = candidateRows.find((row: TrackMatchCandidate) => row.pathKey === pendingTarget.pathTarget) || null;
        }
        if (!matchedRow && pendingTarget.aliasTarget) {
            matchedRow = candidateRows.find((row: TrackMatchCandidate) => row.aliasKey === pendingTarget.aliasTarget) || null;
        }
        if (!matchedRow && pendingTarget.nameKey) {
            matchedRow = candidateRows.find((row: TrackMatchCandidate) => row.nameKey === pendingTarget.nameKey) || null;
        }
        if (!matchedRow && pendingTarget.numberTarget !== null) {
            matchedRow = candidateRows.find((row: TrackMatchCandidate) => row.numberKey === pendingTarget.numberTarget) || null;
        }

        pendingSharedTrackTargetRef.current = parseTrackShareTarget('');
        pendingSharedTrackAlbumIdRef.current = '';
        if (!matchedRow) {
            if (process.env.NODE_ENV !== 'production') {
                console.debug('[track-share] unresolved deep-link target', {
                    pendingTarget,
                    albumId: currentAlbumId || selectedAlbum?.albumId || '',
                    sampleCandidates: candidateRows.slice(0, 5).map((row) => ({
                        number: row.numberKey,
                        path: row.pathKey,
                        alias: row.aliasKey,
                        name: row.nameKey,
                    })),
                });
            }
            showAppNotice('Track from this link was not found in the selected album.', 'Track Not Found');
            return;
        }

        scrollAlbumTrackIntoView(matchedRow.originalIndex);
        void playTrack(matchedRow.track, selectedAlbum.tracks, { forceAlbumQueue: true });
        window.requestAnimationFrame(() => {
            scrollAlbumTrackIntoView(matchedRow.originalIndex);
        });
    }, [pendingSharedTrackSignal, playTrack, scrollAlbumTrackIntoView, selectedAlbum, selectedUrl, showAppNotice]);

    const queueAlbumForPlayback = useCallback((tracks: any[]) => {
        const ordered = sortTracksForPlayback(Array.isArray(tracks) ? tracks : []);
        if (ordered.length === 0) return;
        void playTrack(ordered[0], ordered, { forceAlbumQueue: true });
    }, [playTrack]);

    const playCurrentAlbumAll = useCallback(() => {
        if (!selectedAlbum?.tracks?.length) return;
        queueAlbumForPlayback(selectedAlbum.tracks);
    }, [selectedAlbum, queueAlbumForPlayback]);

    const playLikedAlbumAll = useCallback((group: { tracks: any[] }) => {
        const tracks = prepareLikedTracksForPlayback(group);
        if (tracks.length === 0) return;
        queueAlbumForPlayback(tracks);
    }, [queueAlbumForPlayback]);

    const playNext = useCallback(() => {
        const queueSnapshot = (Array.isArray(queueRef.current) ? queueRef.current : []) as any[];
        const activeIndex = currentTrackIndexRef.current;
        if (queueSnapshot.length === 0 || activeIndex === -1) return;

        if (activeIndex < queueSnapshot.length - 1) {
            const nextIdx = activeIndex + 1;
            const nextTrack = queueSnapshot[nextIdx] as any;
            setCurrentTrackIndexWithRef(nextIdx);
            const nextLabel =
                nextTrack?.queueSource === 'manual'
                    ? 'Manual Queue'
                    : nextTrack?.queueSource === 'playlist'
                        ? (nextTrack?.playlistName ? `Playlist: ${nextTrack.playlistName}` : playbackSourceLabelRef.current)
                        : (nextTrack?.albumName ? `From ${nextTrack.albumName}` : playbackSourceLabelRef.current);
            playbackSourceLabelRef.current = nextLabel;
            setPlaybackSourceLabel(nextLabel);
            void playTrackWithResolution(nextTrack);
            return;
        }

        if (currentTrack?.queueSource === 'playlist' || currentTrack?.queueSource === 'manual') return;
        if (view !== 'liked' || !currentTrack || likedTracks.length === 0) return;

        const normalizeName = (name?: string) => String(name || 'Unknown Album').trim().replace(/\s+/g, ' ').toLowerCase();
        const getAlbumKey = (track: any) => normalizeAlbumId(track?.albumId || track?.albumUrl || track?.url || track?.albumArt) || `name:${normalizeName(track?.albumName)}`;

        const orderedAlbums: Array<{ key: string; tracks: any[] }> = [];
        const indexByKey = new Map<string, number>();

        likedTracks.forEach((rawTrack: any) => {
            const track = normalizeLikedTrack(rawTrack);
            const key = getAlbumKey(track);
            const existingIdx = indexByKey.get(key);
            if (existingIdx === undefined) {
                indexByKey.set(key, orderedAlbums.length);
                orderedAlbums.push({ key, tracks: [track] });
            } else {
                orderedAlbums[existingIdx].tracks.push(track);
            }
        });

        if (orderedAlbums.length <= 1) return;

        orderedAlbums.forEach((album) => {
            album.tracks.sort((a: any, b: any) => {
                const an = Number(a?.number || 0);
                const bn = Number(b?.number || 0);
                if (an !== bn) return an - bn;
                return String(a?.title || '').localeCompare(String(b?.title || ''));
            });
        });

        const currentAlbumKey = getAlbumKey(currentTrack);
        const currentAlbumIdx = orderedAlbums.findIndex((album) => album.key === currentAlbumKey);
        if (currentAlbumIdx === -1 || currentAlbumIdx >= orderedAlbums.length - 1) return;

        const nextAlbum = orderedAlbums[currentAlbumIdx + 1];
        const nextTrack = nextAlbum?.tracks?.[0];
        if (!nextTrack) return;

        playTrack(nextTrack, nextAlbum.tracks);
    }, [currentTrack, likedTracks, playTrack, playTrackWithResolution, view]);

    const playPrev = useCallback(() => {
        const queueSnapshot = (Array.isArray(queueRef.current) ? queueRef.current : []) as any[];
        const activeIndex = currentTrackIndexRef.current;
        if (queueSnapshot.length === 0 || activeIndex <= 0) return;
        const prevIdx = activeIndex - 1;
        const prevTrack = queueSnapshot[prevIdx] as any;
        setCurrentTrackIndexWithRef(prevIdx);
        const prevLabel =
            prevTrack?.queueSource === 'manual'
                ? 'Manual Queue'
                : prevTrack?.queueSource === 'playlist'
                    ? (prevTrack?.playlistName ? `Playlist: ${prevTrack.playlistName}` : playbackSourceLabelRef.current)
                    : (prevTrack?.albumName ? `From ${prevTrack.albumName}` : playbackSourceLabelRef.current);
        playbackSourceLabelRef.current = prevLabel;
        setPlaybackSourceLabel(prevLabel);
        void playTrackWithResolution(prevTrack);
    }, [playTrackWithResolution]);

    const playTrackInternal = useCallback(async (track: any) => {
        if (!track?.url) return;
        await playTrackWithResolution(track);
    }, [playTrackWithResolution]);

    const playPlaylist = useCallback((playlistId: string, startIndex = 0, shuffle = false) => {
        const sourcePlaylist = playlists.find((playlist) => playlist.id === playlistId);
        if (!sourcePlaylist || sourcePlaylist.tracks.length === 0) return;

        let playlistQueue = sourcePlaylist.tracks.map((track) => ({
            ...track,
            albumId: normalizeAlbumId(track.albumId || track.albumUrl || track.url || track.albumArt),
            queueSource: 'playlist',
            playlistId: sourcePlaylist.id,
            playlistName: sourcePlaylist.name,
        }));

        if (shuffle) {
            const shuffled = [...playlistQueue];
            for (let idx = shuffled.length - 1; idx > 0; idx -= 1) {
                const swap = Math.floor(Math.random() * (idx + 1));
                [shuffled[idx], shuffled[swap]] = [shuffled[swap], shuffled[idx]];
            }
            playlistQueue = shuffled;
        }

        const safeStartIndex = Math.min(Math.max(startIndex, 0), playlistQueue.length - 1);
        const currentQueueSnapshot = Array.isArray(queueRef.current) ? queueRef.current : [];
        const preservedManual = currentQueueSnapshot
            .filter((queuedTrack: any) => queuedTrack?.queueSource === 'manual')
            .filter((queuedTrack: any) => !playlistQueue.some((contextTrack: any) => isSamePlaybackTrack(contextTrack, queuedTrack)));
        const mergedQueue = [...playlistQueue, ...preservedManual];
        queueRef.current = mergedQueue;
        if (mergedQueue.length > 150) {
            startTransition(() => {
                setQueue(mergedQueue);
            });
        } else {
            setQueue(mergedQueue);
        }
        setCurrentTrackIndexWithRef(safeStartIndex);
        setPlaybackSourceLabel(`Playlist: ${sourcePlaylist.name}`);

        const selectedTrack = playlistQueue[safeStartIndex];
        if (selectedTrack) {
            void playTrackInternal(selectedTrack);
        }
    }, [playTrackInternal, playlists]);

    const playPlaylistTrack = useCallback((playlistId: string, trackIndex: number) => {
        playPlaylist(playlistId, trackIndex, false);
    }, [playPlaylist]);

    const playSharedPlaylist = useCallback((startIndex = 0, shuffle = false) => {
        const shared = sharedPlaylistData?.playlist;
        if (!shared || shared.tracks.length === 0) return;

        let playlistQueue = shared.tracks.map((track) => ({
            ...track,
            albumId: normalizeAlbumId(track.albumId || track.albumUrl || track.url || track.albumArt),
            queueSource: 'playlist',
            playlistId: `shared:${sharedPlaylistData?.shareId || 'hash'}`,
            playlistName: shared.name,
        }));

        if (shuffle) {
            const shuffled = [...playlistQueue];
            for (let idx = shuffled.length - 1; idx > 0; idx -= 1) {
                const swap = Math.floor(Math.random() * (idx + 1));
                [shuffled[idx], shuffled[swap]] = [shuffled[swap], shuffled[idx]];
            }
            playlistQueue = shuffled;
        }

        const safeStartIndex = Math.min(Math.max(startIndex, 0), playlistQueue.length - 1);
        const currentQueueSnapshot = Array.isArray(queueRef.current) ? queueRef.current : [];
        const preservedManual = currentQueueSnapshot
            .filter((queuedTrack: any) => queuedTrack?.queueSource === 'manual')
            .filter((queuedTrack: any) => !playlistQueue.some((contextTrack: any) => isSamePlaybackTrack(contextTrack, queuedTrack)));
        const mergedQueue = [...playlistQueue, ...preservedManual];
        queueRef.current = mergedQueue;
        if (mergedQueue.length > 150) {
            startTransition(() => {
                setQueue(mergedQueue);
            });
        } else {
            setQueue(mergedQueue);
        }
        setCurrentTrackIndexWithRef(safeStartIndex);
        setPlaybackSourceLabel(`Playlist: ${shared.name}`);

        const selectedTrack = playlistQueue[safeStartIndex];
        if (selectedTrack) {
            void playTrackInternal(selectedTrack);
        }
    }, [playTrackInternal, sharedPlaylistData]);

    const playTrackFromSharedPlaylist = useCallback((trackIndex: number) => {
        playSharedPlaylist(trackIndex, false);
    }, [playSharedPlaylist]);

    const enqueuePlaybackTrack = useCallback((track: any) => {
        const preparedTrack = { ...buildPlaybackTrack(track), queueSource: 'manual' };
        const currentQueue = Array.isArray(queueRef.current) ? queueRef.current : [];
        const preparedKey = getPlaybackTrackKey(preparedTrack);
        const indexedManualIdx = manualQueueIndexByTrackKeyRef.current.get(preparedKey);
        const indexedManualTrack = typeof indexedManualIdx === 'number' ? currentQueue[indexedManualIdx] : null;
        const existingManualIdx = (
            typeof indexedManualIdx === 'number' &&
            indexedManualTrack?.queueSource === 'manual' &&
            isSamePlaybackTrack(indexedManualTrack, preparedTrack)
        )
            ? indexedManualIdx
            : currentQueue.findIndex((queuedTrack: any) => (
                queuedTrack?.queueSource === 'manual' &&
                isSamePlaybackTrack(queuedTrack, preparedTrack)
            ));
        if (existingManualIdx !== -1) {
            const existingTrack = currentQueue[existingManualIdx] || preparedTrack;
            if (!currentTrack && existingTrack?.url) {
                setCurrentTrackIndexWithRef(existingManualIdx);
                setPlaybackSourceLabel('Manual Queue');
                void playTrackInternal(existingTrack);
            }
            return {
                added: false,
                track: existingTrack,
            };
        }

        const nextQueue = [...currentQueue, preparedTrack];
        queueRef.current = nextQueue;
        manualQueueIndexByTrackKeyRef.current.set(preparedKey, nextQueue.length - 1);
        queueEnqueuePendingRef.current = true;
        if (nextQueue.length > 150) {
            startTransition(() => {
                setQueue(nextQueue);
            });
        } else {
            setQueue(nextQueue);
        }

        if (!currentTrack && preparedTrack?.url) {
            const autoplayIndex = nextQueue.length - 1;
            setCurrentTrackIndexWithRef(autoplayIndex);
            setPlaybackSourceLabel('Manual Queue');
            void playTrackInternal(preparedTrack);
        }

        return {
            added: true,
            track: preparedTrack,
        };
    }, [buildPlaybackTrack, currentTrack, playTrackInternal]);

    const addTrackToPlaybackQueue = useCallback((track: any) => {
        markPerf(PERF_QUEUE_ENQUEUE_START_MARK);
        const result = enqueuePlaybackTrack(track);
        const title = String(result?.track?.title || track?.title || 'Track').trim() || 'Track';
        if (result.added) {
            showInlineToast(`${title} added to manual queue.`, 'success', 1800);
            return;
        }
        showInlineToast(`${title} is already in manual queue.`, 'error', 1600);
    }, [enqueuePlaybackTrack, showInlineToast]);

    const removeFromPlaybackQueue = useCallback((index: number) => {
        setQueue((prev) => {
            if (index < 0 || index >= prev.length) return prev;
            if (index <= currentTrackIndex) return prev;
            const next = prev.filter((_: any, idx: number) => idx !== index);
            queueRef.current = next;
            return next;
        });
    }, [currentTrackIndex]);

    const clearManualQueue = useCallback(() => {
        setQueue((prev) => {
            const next = prev.filter((item: any, idx: number) => {
                if (item?.queueSource !== 'manual') return true;
                return !!currentTrack && idx === currentTrackIndex && currentTrack?.queueSource === 'manual';
            });
            queueRef.current = next;
            return next;
        });
    }, [currentTrack, currentTrackIndex]);

    const clearAlbumQueue = useCallback(() => {
        setQueue((prev) => {
            const next = prev.filter((item: any, idx: number) => {
                if (item?.queueSource === 'manual') return true;
                return !!currentTrack && idx === currentTrackIndex && currentTrack?.queueSource !== 'manual';
            });
            queueRef.current = next;
            return next;
        });
    }, [currentTrack, currentTrackIndex]);

    const handleQueueTrackPlay = useCallback((track: any, index: number) => {
        if (index >= 0) {
            setCurrentTrackIndexWithRef(index);
        }
        setPlaybackSourceLabel(
            track?.queueSource === 'manual'
                ? 'Manual Queue'
                : track?.queueSource === 'playlist'
                    ? (track?.playlistName ? `Playlist: ${track.playlistName}` : playbackSourceLabel)
                    : (track?.albumName ? `From ${track.albumName}` : playbackSourceLabel)
        );
        void playTrackInternal(track);
    }, [playTrackInternal, playbackSourceLabel]);

    const togglePlayPause = () => {
        const media = audioRef.current;
        if (!media) return;
        if (media.paused) {
            media.play().catch(() => { });
            setIsPlaying(true);
            return;
        }
        media.pause();
        setIsPlaying(false);
    };
    const handleClosePlayer = () => {
        playbackRequestSeqRef.current += 1;
        if (playbackResolveControllerRef.current) {
            playbackResolveControllerRef.current.abort();
            playbackResolveControllerRef.current = null;
        }
        isChangingTrackRef.current = false;
        setCurrentTrack(null);
        setCurrentTrackIndexWithRef(-1);
        setIsPlaying(false);
        setAudioLoadingDebounced(false);
        setMobileFullScreen(false);
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = "";
        }
    };

    const handleVolumeChange = (vol: number) => {
        if (!Number.isFinite(vol)) return;
        const normalized = Math.max(0, Math.min(1, Math.round(vol * 100) / 100));
        setVolume(normalized);
        if (audioRef.current) audioRef.current.volume = normalized;
    };
    const handlePlaybackRateChange = (rate: number) => {
        if (!Number.isFinite(rate)) return;
        const normalized = Math.max(0.5, Math.min(2.0, Math.round(rate * 100) / 100));
        setPlaybackRate(normalized);
        if (audioRef.current) {
            audioRef.current.playbackRate = normalized;
            if ((audioRef.current as any).mozPreservesPitch !== undefined) {
                (audioRef.current as any).mozPreservesPitch = false;
            } else {
                (audioRef.current as any).preservesPitch = false;
            }
        }
    };
    const toggleRepeatMode = useCallback(() => {
        setIsRepeatEnabled((prev) => {
            const next = !prev;
            if (typeof window !== 'undefined') {
                localStorage.setItem('playerRepeatEnabled', next ? '1' : '0');
            }
            return next;
        });
    }, []);
    const cyclePlayerMode = () => {
        const newMode = playerMode === 'standard' ? 'minimized' : 'standard';
        setPlayerMode(newMode);
        localStorage.setItem('playerMode', newMode);
    };

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.loop = isRepeatEnabled;
        }
    }, [isRepeatEnabled]);

    const handleAlbumClick = (url: string, fallbackUrls: string[] = [], albumName: string = 'Unknown', albumId: string = '') => {
        const urls = [albumId, url, ...fallbackUrls].map((u) => String(u || '').trim()).filter(Boolean);
        if (urls.length > 0) {
            const tempItem = {
                url: urls[0],
                urls,
                title: albumName || 'Unknown',
                albumName: albumName || 'Unknown',
                albumId: normalizeAlbumId(albumId || urls[0]) || null,
                icon: ''
            };
            setLikedExpandedKey(null);
            void selectAlbum(tempItem);
        }
    };

    const openTrackAlbumFromTrack = useCallback((track: any) => {
        const normalizedAlbumId = normalizeAlbumId(track?.albumId || track?.albumUrl || track?.url || track?.albumArt);
        const directAlbumUrl = String(track?.albumUrl || '').trim();
        const trackUrl = String(track?.url || '').trim();
        const albumName = String(track?.albumName || 'Unknown Album').trim() || 'Unknown Album';
        const primaryUrl = normalizedAlbumId || directAlbumUrl || trackUrl;
        if (!primaryUrl) return;

        const fallbackUrls = [directAlbumUrl, trackUrl].filter(Boolean);
        handleAlbumClick(primaryUrl, fallbackUrls, albumName, normalizedAlbumId || primaryUrl);
    }, [handleAlbumClick]);

    const exportLikes = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(likedTracks));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "khinsider_liked_songs.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const importLikes = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target?.result as string;
                const imported = JSON.parse(text);
                if (Array.isArray(imported)) {
                    const now = Date.now();
                    const normalizedImported = imported.map((rawTrack: any, index: number) => {
                        const addedAtNum = Number(rawTrack?.likedAt ?? rawTrack?.addedAt ?? 0);
                        const likedAt = Number.isFinite(addedAtNum) && addedAtNum > 0
                            ? Math.floor(addedAtNum)
                            : Math.max(1, now - index);
                        return normalizeLikedTrack({ ...(rawTrack || {}), likedAt });
                    });
                    setLikedTracks(prev => {
                        const currentUrls = new Set(prev.map(t => t.url));
                        const newTracks = normalizedImported.filter(t => !currentUrls.has(t.url));
                        return [...newTracks, ...prev];
                    });
                    showAppNotice(`Imported ${normalizedImported.length} songs.`, 'Likes Imported');
                } else {
                    showAppNotice('Invalid file format.', 'Import Failed');
                }
            } catch (err) {
                console.error(err);
                showAppNotice('Failed to parse file.', 'Import Failed');
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    };

    const normalizeLikedAlbumUrl = useCallback((albumUrl?: string) => {
        if (!albumUrl) return '';
        const path = extractPathFromUrl(String(albumUrl).trim());
        return String(path || '')
            .replace(/#.*$/, '')
            .replace(/[/?]+$/, '')
            .toLowerCase();
    }, []);

    const normalizeLikedAlbumName = useCallback((albumName?: string) => {
        return String(albumName || 'Unknown Album')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }, []);

    const deriveAlbumPathFromTrackUrl = useCallback((trackUrl?: string) => {
        if (!trackUrl) return '';
        return normalizeAlbumId(trackUrl);
    }, []);

    const deriveAlbumSlugFromAlbumPath = useCallback((albumPath?: string) => {
        if (!albumPath) return '';
        const match = String(albumPath).match(/\/game-soundtracks\/album\/([^/?#]+)/i);
        return match?.[1]?.toLowerCase() || '';
    }, []);

    const deriveAlbumSlugFromArtUrl = useCallback((albumArtUrl?: string) => {
        if (!albumArtUrl) return '';
        const albumId = normalizeAlbumId(albumArtUrl);
        return deriveAlbumSlugFromAlbumPath(albumId);
    }, []);

    const getPathDirectory = useCallback((pathLike?: string) => {
        const clean = String(pathLike || '').trim();
        if (!clean) return '';
        const idx = clean.lastIndexOf('/');
        if (idx <= 0) return clean;
        return clean.slice(0, idx);
    }, []);

    const getLikedGroupKey = useCallback((group: { albumName: string; albumUrl: string; albumId?: string; __groupKey?: string }) => {
        if (group.__groupKey) return group.__groupKey;
        const normalizedAlbumId = normalizeAlbumId(group.albumId || group.albumUrl);
        if (normalizedAlbumId) return `id:${normalizedAlbumId}`;
        const normalizedUrl = normalizeLikedAlbumUrl(group.albumUrl);
        if (normalizedUrl) return `url:${normalizedUrl}`;
        return `name:${normalizeLikedAlbumName(group.albumName)}`;
    }, [normalizeLikedAlbumName, normalizeLikedAlbumUrl]);

    const getLikedMetaCacheKey = useCallback((group: { albumName: string; albumUrl: string; albumId?: string; __groupKey?: string }) => {
        const normalizedAlbumId = normalizeAlbumId(group.albumId || group.albumUrl);
        if (normalizedAlbumId) return `id:${normalizedAlbumId}`;
        const normalizedUrl = normalizeLikedAlbumUrl(group.albumUrl);
        if (normalizedUrl) return `url:${normalizedUrl}`;
        if (group.__groupKey) return group.__groupKey;
        return `name:${normalizeLikedAlbumName(group.albumName)}`;
    }, [normalizeLikedAlbumName, normalizeLikedAlbumUrl]);

    const getLikedGroupAlbumFetchCandidates = useCallback((group: { albumId?: string; albumUrl: string; albumArt?: string; tracks: any[] }) => {
        const seen = new Set<string>();
        const candidates: string[] = [];
        const add = (raw?: string) => {
            const normalized = normalizeAlbumId(raw) || normalizeAlbumId(extractPathFromUrl(String(raw || '').trim()));
            if (!normalized) return;
            if (seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push(normalized);
        };

        add(group.albumId);
        add(group.albumUrl);
        add(group.albumArt);
        group.tracks?.forEach((track: any) => {
            add(track?.albumId);
            add(track?.albumUrl);
            add(track?.albumArt);
            add(deriveAlbumPathFromTrackUrl(track?.url));
        });

        return candidates;
    }, [deriveAlbumPathFromTrackUrl]);

    const getLikedArtistFallback = useCallback((group: { tracks: any[] }) => {
        const fields = ['primaryArtist', 'artist', 'artistName', 'albumArtist', 'composer', 'composers', 'publisher', 'label', 'developer', 'developers'];
        for (const track of group.tracks || []) {
            for (const field of fields) {
                const value = String(track?.[field] || '').trim();
                if (value) return value;
            }
        }
        return 'Unknown Artist';
    }, []);

    const likedGroups = useMemo(() => {
        const groups: Record<string, { albumName: string; albumId: string; albumUrl: string; albumArt?: string; tracks: LikedTrack[]; __groupKey: string }> = {};
        likedTracks.forEach((track, idx) => {
            const albumName = track.albumName || "Unknown Album";
            const normalizedName = normalizeLikedAlbumName(albumName);
            const inferredAlbumPathRaw = deriveAlbumPathFromTrackUrl(track.url);
            const normalizedAlbumId =
                normalizeAlbumId(track.albumId) ||
                normalizeAlbumId(track.albumUrl) ||
                normalizeAlbumId(inferredAlbumPathRaw) ||
                normalizeAlbumId(track.albumArt) ||
                normalizeAlbumId(track.url);
            const normalizedAlbumUrl = normalizeLikedAlbumUrl(track.albumUrl);
            const normalizedInferredAlbumUrl = normalizeLikedAlbumUrl(inferredAlbumPathRaw);
            const albumSlug =
                deriveAlbumSlugFromAlbumPath(normalizedAlbumId) ||
                deriveAlbumSlugFromAlbumPath(normalizedAlbumUrl) ||
                deriveAlbumSlugFromAlbumPath(normalizedInferredAlbumUrl) ||
                deriveAlbumSlugFromArtUrl(track.albumArt);
            const normalizedTrackPath = normalizeLikedAlbumUrl(track.url);
            const normalizedArtPath = normalizeLikedAlbumUrl(track.albumArt);
            const artDir = getPathDirectory(normalizedArtPath);
            const trackDir = getPathDirectory(normalizedTrackPath);
            const fallbackFingerprint = artDir || trackDir || normalizedTrackPath || normalizedArtPath || `idx:${idx}`;
            const key = normalizedAlbumId
                ? `id:${normalizedAlbumId}`
                : albumSlug
                    ? `slug:${albumSlug}`
                    : (normalizedAlbumUrl || normalizedInferredAlbumUrl)
                        ? `url:${normalizedAlbumUrl || normalizedInferredAlbumUrl}`
                        : `fallback:${normalizedName}|${fallbackFingerprint}`;

            if (!groups[key]) {
                groups[key] = {
                    albumName,
                    albumId: normalizedAlbumId || '',
                    albumUrl: track.albumUrl || (normalizedAlbumId ? `https://downloads.khinsider.com${normalizedAlbumId}` : '') || normalizedAlbumUrl || normalizedInferredAlbumUrl || inferredAlbumPathRaw || '',
                    albumArt: track.albumArt,
                    tracks: [],
                    __groupKey: key
                };
            } else {
                if (!groups[key].albumId && normalizedAlbumId) groups[key].albumId = normalizedAlbumId;
                if (!groups[key].albumUrl && (track.albumUrl || normalizedAlbumUrl || normalizedInferredAlbumUrl || inferredAlbumPathRaw)) {
                    groups[key].albumUrl = track.albumUrl || normalizedAlbumUrl || normalizedInferredAlbumUrl || inferredAlbumPathRaw;
                }
                if (!groups[key].albumArt && track.albumArt) groups[key].albumArt = track.albumArt;
                if (groups[key].albumName === 'Unknown Album' && albumName !== 'Unknown Album') {
                    groups[key].albumName = albumName;
                }
            }
            groups[key].tracks.push(track);
        });
        const grouped = Object.values(groups);
        grouped.forEach(g => {
            g.tracks.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
        });
        return grouped;
    }, [
        likedTracks,
        deriveAlbumPathFromTrackUrl,
        deriveAlbumSlugFromAlbumPath,
        deriveAlbumSlugFromArtUrl,
        getPathDirectory,
        normalizeLikedAlbumName,
        normalizeLikedAlbumUrl
    ]);

    useEffect(() => {
        const computeColumns = () => {
            const width = window.innerWidth;
            let cols = 1;
            if (width >= 1700) cols = 6;
            else if (width >= 1450) cols = 5;
            else if (width >= 1180) cols = 4;
            else if (width >= 900) cols = 3;
            else if (width >= 620) cols = 2;

            if (!isSidebarOpen && width >= 900) {
                cols += 1;
            }

            setLikedGridColumns(cols);
        };
        computeColumns();
        window.addEventListener('resize', computeColumns);
        return () => window.removeEventListener('resize', computeColumns);
    }, [isSidebarOpen]);

    useEffect(() => {
        if (!likedExpandedKey) return;
        const exists = likedGroups.some(group => getLikedGroupKey(group) === likedExpandedKey);
        if (!exists) setLikedExpandedKey(null);
    }, [likedExpandedKey, likedGroups, getLikedGroupKey]);

    const likedRows = useMemo(() => {
        const rows: Array<Array<{ albumName: string; albumId?: string; albumUrl: string; albumArt?: string; tracks: LikedTrack[]; __groupKey?: string }>> = [];
        if (likedGridColumns <= 0) return rows;
        for (let i = 0; i < likedGroups.length; i += likedGridColumns) {
            rows.push(likedGroups.slice(i, i + likedGridColumns));
        }
        return rows;
    }, [likedGroups, likedGridColumns]);

    const expandedLikedGroup = useMemo(() => {
        if (!likedExpandedKey) return null;
        return likedGroups.find((group) => getLikedGroupKey(group) === likedExpandedKey) || null;
    }, [getLikedGroupKey, likedExpandedKey, likedGroups]);

    const indexedExpandedLikedTracks = useMemo(() => {
        if (!expandedLikedGroup?.tracks?.length) return [] as Array<{ track: LikedTrack; originalIndex: number }>;
        return expandedLikedGroup.tracks.map((track: LikedTrack, originalIndex: number) => ({ track, originalIndex }));
    }, [expandedLikedGroup]);

    const logLikedExpandVirtual = useCallback((event: string, payload?: Record<string, unknown>) => {
        if (process.env.NODE_ENV !== 'development') return;
        console.debug('[liked-virtual]', event, payload || {});
    }, []);

    const scheduleDisableLikedExpandVirtualization = useCallback((reason: string) => {
        if (process.env.NODE_ENV !== 'development') return;
        if (likedExpandAutoDisableScheduledRef.current) return;
        likedExpandAutoDisableScheduledRef.current = true;
        console.warn('[liked-virtual] disabling virtualization due to instability', { reason });
        window.setTimeout(() => {
            setLikedExpandVirtualizationDisabled(true);
            likedExpandAutoDisableScheduledRef.current = false;
        }, 0);
    }, []);

    const likedExpandTargetRowHeight = isDesktopViewport
        ? LIKED_EXPAND_VIRTUALIZATION_ROW_HEIGHT_DESKTOP
        : LIKED_EXPAND_VIRTUALIZATION_ROW_HEIGHT_MOBILE;

    const shouldVirtualizeLikedExpand =
        LIKED_EXPAND_VIRTUALIZATION_ENABLED &&
        !likedExpandVirtualizationDisabled &&
        !!expandedLikedGroup &&
        indexedExpandedLikedTracks.length >= LIKED_EXPAND_VIRTUALIZATION_MIN_ITEMS;

    useEffect(() => {
        if (!likedExpandedKey) {
            likedExpandLastInitializedKeyRef.current = null;
            likedExpandRangeResetTimestampsRef.current = [];
            likedExpandAutoDisableScheduledRef.current = false;
            setLikedExpandVirtualizationDisabled(false);
            return;
        }
        likedExpandRangeResetTimestampsRef.current = [];
        likedExpandAutoDisableScheduledRef.current = false;
        setLikedExpandVirtualizationDisabled(false);
    }, [likedExpandedKey]);

    useEffect(() => {
        if (!shouldVirtualizeLikedExpand) return;
        const nextHeight = likedExpandTargetRowHeight;
        setLikedExpandVirtualRowHeight((prev) => {
            if (prev === nextHeight) return prev;
            const root = likedExpandTracklistRef.current;
            if (root) {
                const firstVisible = Math.max(0, Math.floor(root.scrollTop / Math.max(1, prev)));
                root.scrollTop = firstVisible * nextHeight;
            }
            logLikedExpandVirtual('row-height-change', { from: prev, to: nextHeight });
            return nextHeight;
        });
    }, [likedExpandTargetRowHeight, logLikedExpandVirtual, shouldVirtualizeLikedExpand]);

    useEffect(() => {
        if (!shouldVirtualizeLikedExpand) {
            likedExpandLastInitializedKeyRef.current = null;
            setLikedExpandVirtualRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }
        const key = String(likedExpandedKey || '');
        if (likedExpandLastInitializedKeyRef.current === key) return;
        likedExpandLastInitializedKeyRef.current = key;

        const totalItems = indexedExpandedLikedTracks.length;
        const initialWindow = Math.max(
            LIKED_EXPAND_VIRTUALIZATION_MIN_WINDOW,
            LIKED_EXPAND_VIRTUALIZATION_INITIAL_WINDOW
        );
        const initialEnd = totalItems > 0 ? Math.min(totalItems - 1, initialWindow - 1) : -1;
        setLikedExpandVirtualRange({ start: 0, end: initialEnd });
        if (likedExpandTracklistRef.current) {
            likedExpandTracklistRef.current.scrollTop = 0;
        }
        logLikedExpandVirtual('range-init', { key, totalItems, initialEnd });
    }, [indexedExpandedLikedTracks.length, likedExpandedKey, logLikedExpandVirtual, shouldVirtualizeLikedExpand]);

    useEffect(() => {
        if (!shouldVirtualizeLikedExpand) return;
        const totalItems = indexedExpandedLikedTracks.length;
        setLikedExpandVirtualRange((prev) => {
            if (totalItems === 0) {
                if (prev.start === 0 && prev.end === -1) return prev;
                return { start: 0, end: -1 };
            }
            let nextStart = Math.max(0, Math.min(totalItems - 1, prev.start));
            let nextEnd = Math.max(nextStart, Math.min(totalItems - 1, prev.end));
            const minWindow = Math.min(totalItems, LIKED_EXPAND_VIRTUALIZATION_MIN_WINDOW);
            const currentWindow = nextEnd - nextStart + 1;
            if (currentWindow < minWindow) {
                const deficit = minWindow - currentWindow;
                nextStart = Math.max(0, nextStart - Math.floor(deficit / 2));
                nextEnd = Math.min(totalItems - 1, nextStart + minWindow - 1);
                nextStart = Math.max(0, nextEnd - minWindow + 1);
            }
            if (prev.start === nextStart && prev.end === nextEnd) return prev;
            return { start: nextStart, end: nextEnd };
        });
    }, [indexedExpandedLikedTracks.length, shouldVirtualizeLikedExpand]);

    const updateLikedExpandVirtualRange = useCallback(() => {
        if (!shouldVirtualizeLikedExpand) return;
        const root = likedExpandTracklistRef.current;
        if (!root) return;
        const totalItems = indexedExpandedLikedTracks.length;
        if (totalItems === 0) {
            setLikedExpandVirtualRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }

        const rowHeight = Math.max(1, likedExpandVirtualRowHeight);
        const viewportStart = root.scrollTop;
        const viewportEnd = viewportStart + root.clientHeight;
        const visibleStart = Math.floor(viewportStart / rowHeight);
        const visibleEnd = Math.max(visibleStart, Math.ceil(viewportEnd / rowHeight) - 1);

        let nextStart = Math.max(0, visibleStart - LIKED_EXPAND_VIRTUALIZATION_OVERSCAN_ROWS);
        let nextEnd = Math.min(totalItems - 1, visibleEnd + LIKED_EXPAND_VIRTUALIZATION_OVERSCAN_ROWS);

        const minWindow = Math.min(totalItems, LIKED_EXPAND_VIRTUALIZATION_MIN_WINDOW);
        const nextWindow = nextEnd - nextStart + 1;
        if (nextWindow < minWindow) {
            const deficit = minWindow - nextWindow;
            nextStart = Math.max(0, nextStart - Math.floor(deficit / 2));
            nextEnd = Math.min(totalItems - 1, nextStart + minWindow - 1);
            nextStart = Math.max(0, nextEnd - minWindow + 1);
        }

        setLikedExpandVirtualRange((prev) => {
            const hasRange = prev.end >= prev.start;
            if (hasRange) {
                const minBufferedStart = Math.max(0, visibleStart - LIKED_EXPAND_VIRTUALIZATION_RETAIN_ROWS);
                const maxBufferedEnd = Math.min(totalItems - 1, visibleEnd + LIKED_EXPAND_VIRTUALIZATION_RETAIN_ROWS);
                const stillBuffered = prev.start <= minBufferedStart && prev.end >= maxBufferedEnd;
                if (stillBuffered) return prev;
            }

            if (process.env.NODE_ENV !== 'production') {
                const wasFar = prev.start >= LIKED_EXPAND_VIRTUALIZATION_INITIAL_WINDOW;
                const resetNearTop = nextStart <= 1;
                if (wasFar && resetNearTop) {
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    likedExpandRangeResetTimestampsRef.current = likedExpandRangeResetTimestampsRef.current
                        .filter((ts) => (now - ts) < 5000);
                    likedExpandRangeResetTimestampsRef.current.push(now);
                    logLikedExpandVirtual('range-reset-near-top', {
                        previousStart: prev.start,
                        nextStart,
                        eventsInWindow: likedExpandRangeResetTimestampsRef.current.length,
                    });
                    if (likedExpandRangeResetTimestampsRef.current.length >= 3) {
                        scheduleDisableLikedExpandVirtualization('repeated reset-to-top range oscillation');
                    }
                }
            }

            if (prev.start === nextStart && prev.end === nextEnd) return prev;
            return { start: nextStart, end: nextEnd };
        });
    }, [
        indexedExpandedLikedTracks.length,
        likedExpandVirtualRowHeight,
        logLikedExpandVirtual,
        scheduleDisableLikedExpandVirtualization,
        shouldVirtualizeLikedExpand,
    ]);

    useEffect(() => {
        if (!shouldVirtualizeLikedExpand) {
            if (likedExpandVirtualScrollRafRef.current != null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(likedExpandVirtualScrollRafRef.current);
                likedExpandVirtualScrollRafRef.current = null;
            }
            return;
        }
        if (typeof window === 'undefined') return;
        const root = likedExpandTracklistRef.current;
        if (!root) return;

        const schedule = () => {
            if (likedExpandVirtualScrollRafRef.current != null) return;
            likedExpandVirtualScrollRafRef.current = window.requestAnimationFrame(() => {
                likedExpandVirtualScrollRafRef.current = null;
                updateLikedExpandVirtualRange();
            });
        };

        schedule();
        root.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule, { passive: true });

        return () => {
            root.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            if (likedExpandVirtualScrollRafRef.current != null) {
                window.cancelAnimationFrame(likedExpandVirtualScrollRafRef.current);
                likedExpandVirtualScrollRafRef.current = null;
            }
        };
    }, [shouldVirtualizeLikedExpand, updateLikedExpandVirtualRange]);

    const visibleExpandedLikedTracks = useMemo(() => {
        if (!shouldVirtualizeLikedExpand) return indexedExpandedLikedTracks;
        if (indexedExpandedLikedTracks.length === 0) return [] as Array<{ track: any; originalIndex: number }>;
        const start = Math.max(0, Math.min(indexedExpandedLikedTracks.length - 1, likedExpandVirtualRange.start));
        const end = Math.max(start, Math.min(indexedExpandedLikedTracks.length - 1, likedExpandVirtualRange.end));
        return indexedExpandedLikedTracks.slice(start, end + 1);
    }, [indexedExpandedLikedTracks, likedExpandVirtualRange.end, likedExpandVirtualRange.start, shouldVirtualizeLikedExpand]);

    const likedExpandVirtualTopPadding = shouldVirtualizeLikedExpand
        ? Math.max(0, likedExpandVirtualRange.start) * likedExpandVirtualRowHeight
        : 0;
    const likedExpandVirtualBottomPadding = shouldVirtualizeLikedExpand
        ? Math.max(
            0,
            indexedExpandedLikedTracks.length - (Math.max(likedExpandVirtualRange.end, likedExpandVirtualRange.start) + 1)
        ) * likedExpandVirtualRowHeight
        : 0;

    useEffect(() => {
        if (!likedExpandedKey) return;
        const expandedGroup = likedGroups.find(group => getLikedGroupKey(group) === likedExpandedKey);
        if (!expandedGroup) return;

        const cacheKey = getLikedMetaCacheKey(expandedGroup);
        if (likedAlbumMetaCache[cacheKey]) return;
        if (likedAlbumMetaLoading[cacheKey]) return;

        const candidates = getLikedGroupAlbumFetchCandidates(expandedGroup);
        if (candidates.length === 0) return;

        let cancelled = false;
        const controller = new AbortController();
        let startTimerId: number | null = null;
        let idleRequestId: number | null = null;

        const runFetch = async () => {
            if (cancelled || controller.signal.aborted) return;
            setLikedAlbumMetaLoading(prev => ({ ...prev, [cacheKey]: true }));
            setLikedAlbumMetaError(prev => {
                const next = { ...prev };
                delete next[cacheKey];
                return next;
            });

            let loadedMeta: any = null;
            let lastError = '';
            try {
                for (const candidate of candidates) {
                    if (cancelled || controller.signal.aborted) break;
                    try {
                        loadedMeta = await api.getAlbum(candidate, controller.signal);
                        if (loadedMeta) break;
                    } catch (e: any) {
                        if (controller.signal.aborted) break;
                        lastError = e?.message || 'Metadata fetch failed';
                    }
                }

                if (cancelled || controller.signal.aborted) return;

                if (!loadedMeta) {
                    const lookupName = String(expandedGroup.albumName || '').trim();
                    if (lookupName) {
                        try {
                            const searchResults = await api.search(lookupName);
                            const normalizedLookup = lookupName.toLowerCase();
                            const lookupCandidates = (searchResults || [])
                                .filter((res: any) => !!res?.url)
                                .sort((a: any, b: any) => {
                                    const aTitle = String(a?.title || '').toLowerCase();
                                    const bTitle = String(b?.title || '').toLowerCase();
                                    const aExact = aTitle === normalizedLookup ? 0 : 1;
                                    const bExact = bTitle === normalizedLookup ? 0 : 1;
                                    return aExact - bExact;
                                })
                                .slice(0, 5);

                            for (const res of lookupCandidates) {
                                if (cancelled || controller.signal.aborted) break;
                                try {
                                    loadedMeta = await api.getAlbum(res.albumId || res.url, controller.signal);
                                    if (loadedMeta) break;
                                } catch (e: any) {
                                    if (controller.signal.aborted) break;
                                    lastError = e?.message || 'Metadata fetch failed';
                                }
                            }
                        } catch {
                        }
                    }
                }

                if (cancelled || controller.signal.aborted) return;

                if (loadedMeta) {
                    const resolvedMetaAlbumId = normalizeAlbumId(
                        loadedMeta?.albumId || candidates[0] || expandedGroup.albumId || expandedGroup.albumUrl
                    );
                    const normalizedMeta = resolvedMetaAlbumId
                        ? { ...loadedMeta, albumId: resolvedMetaAlbumId }
                        : loadedMeta;
                    const stampedMeta = withLikedMetaCacheTimestamp(normalizedMeta, Date.now());
                    setLikedAlbumMetaCache(prev => {
                        const next = { ...prev, [cacheKey]: stampedMeta };
                        if (resolvedMetaAlbumId) {
                            next[`id:${resolvedMetaAlbumId}`] = stampedMeta;
                        }
                        return pruneLikedAlbumMetaCache(next, LIKED_META_CACHE_MAX_ENTRIES);
                    });
                    setLikedAlbumMetaError(prev => {
                        const next = { ...prev };
                        delete next[cacheKey];
                        return next;
                    });
                } else if (lastError) {
                    setLikedAlbumMetaError(prev => ({ ...prev, [cacheKey]: lastError }));
                }
            } finally {
                setLikedAlbumMetaLoading(prev => ({ ...prev, [cacheKey]: false }));
            }
        };

        if (typeof window !== 'undefined') {
            const requestIdle = (window as any).requestIdleCallback as
                | ((cb: () => void, opts?: { timeout?: number }) => number)
                | undefined;
            if (typeof requestIdle === 'function') {
                idleRequestId = requestIdle(() => {
                    void runFetch();
                }, { timeout: 350 });
            } else {
                startTimerId = window.setTimeout(() => {
                    void runFetch();
                }, 0);
            }
        } else {
            void runFetch();
        }

        return () => {
            cancelled = true;
            controller.abort();
            if (startTimerId !== null) {
                window.clearTimeout(startTimerId);
            }
            const cancelIdle = (window as any).cancelIdleCallback as
                | ((id: number) => void)
                | undefined;
            if (idleRequestId !== null && typeof cancelIdle === 'function') {
                cancelIdle(idleRequestId);
            }
        };
    }, [
        likedExpandedKey,
        likedGroups,
        getLikedGroupKey,
        getLikedMetaCacheKey,
        getLikedGroupAlbumFetchCandidates
    ]);

    const hasPlayer = !!currentTrack;
    const isSearchMode = !!activeSearchTerm.trim();
    const isAlbumLoading = loading && !!selectedUrl && !selectedAlbum;
    const browseQuickYears = useMemo(() => {
        const seed = ['2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017'];
        const currentYear = String(new Date().getFullYear());
        return seed.includes(currentYear) ? seed : [currentYear, ...seed];
    }, []);
    const browseAllYears = useMemo(() => {
        const current = new Date().getFullYear();
        const years: string[] = [];
        for (let year = current; year >= 1975; year -= 1) {
            years.push(String(year));
        }
        return years;
    }, []);
    const browseVisibleYears = showAllBrowseYears ? browseAllYears : browseQuickYears;
    const browseYearValue = useMemo(() => {
        if (browseSection !== 'year') return '';
        const fromSlug = String(browseSlug || '').trim();
        if (/^\d{4}$/.test(fromSlug)) return fromSlug;
        const fromLabel = String(browseLabel || '').match(/\b(\d{4})\b/);
        return fromLabel?.[1] || '';
    }, [browseLabel, browseSection, browseSlug]);
    const hasBrowseYearTopSection =
        browseSection === 'year' &&
        browsePagination.currentPage === 1 &&
        browseTopItems.length > 0;
    const browseTopSectionTitle = useMemo(() => {
        if (!hasBrowseYearTopSection) return '';
        const explicit = String(browseTopItemsLabel || '').trim();
        if (explicit) return explicit;
        if (browseYearValue) return `Top ${browseTopItems.length} Albums From ${browseYearValue}`;
        return 'Top Albums';
    }, [browseTopItems.length, browseTopItemsLabel, browseYearValue, hasBrowseYearTopSection]);
    const browseMainSectionTitle = useMemo(() => {
        if (browseSection !== 'year') return '';
        if (browseYearValue) return `Albums From ${browseYearValue}`;
        return 'Albums';
    }, [browseSection, browseYearValue]);
    const shouldShowBrowseToolbar = isDesktopViewport || isBrowseToolbarOpenMobile;
    const shouldShowSearchFilters = isSearchMode && (isDesktopViewport || isSearchFiltersOpenMobile);
    const shouldShowAlbumComments = isDesktopViewport || isAlbumCommentsOpenMobile;
    const withCurrentFilterOption = useCallback((options: SearchFilterOption[], currentValue: string) => {
        const normalizedCurrent = String(currentValue || '').trim();
        const base = options.length > 0 ? options : [{ value: '', label: 'Any' }];
        if (!normalizedCurrent) return base;
        if (base.some((option) => option.value === normalizedCurrent)) return base;
        return [...base, { value: normalizedCurrent, label: normalizedCurrent }];
    }, []);

    const sortFilterOptions = useMemo(() => {
        const options = searchOptions.sort.length > 0 ? searchOptions.sort : FALLBACK_SORT_OPTIONS;
        return withCurrentFilterOption(options, searchFilters.sort || 'relevance');
    }, [searchOptions.sort, searchFilters.sort, withCurrentFilterOption]);

    const albumTypeFilterOptions = useMemo(() => {
        return withCurrentFilterOption(searchOptions.albumType, searchFilters.album_type);
    }, [searchOptions.albumType, searchFilters.album_type, withCurrentFilterOption]);

    const albumYearFilterOptions = useMemo(() => {
        return withCurrentFilterOption(searchOptions.albumYear, searchFilters.album_year);
    }, [searchOptions.albumYear, searchFilters.album_year, withCurrentFilterOption]);

    const albumCategoryFilterOptions = useMemo(() => {
        return withCurrentFilterOption(searchOptions.albumCategory, searchFilters.album_category);
    }, [searchOptions.albumCategory, searchFilters.album_category, withCurrentFilterOption]);

    const searchSummaryText = useMemo(() => {
        if (!isSearchMode) return '';
        if (searchTotalMatches !== null) {
            if (results.length >= searchTotalMatches) {
                return `Showing all ${searchTotalMatches.toLocaleString()} matching albums.`;
            }
            return `Showing ${results.length.toLocaleString()} of ${searchTotalMatches.toLocaleString()} matching albums.`;
        }
        if (loading) return 'Searching albums...';
        if (results.length === 1) return 'Found 1 matching album.';
        return `Found ${results.length.toLocaleString()} matching albums.`;
    }, [isSearchMode, loading, results.length, searchTotalMatches]);
    const homeFeedItems = view === 'browse'
        ? browseItems
        : (isSearchMode ? results : latestUpdates);
    const homeFeedLightweightThreshold = isDesktopViewport
        ? HOME_FEED_LIGHTWEIGHT_TEXT_MIN_ITEMS
        : HOME_FEED_LIGHTWEIGHT_TEXT_MIN_ITEMS_MOBILE;
    const homeFeedVirtualizationThreshold = isDesktopViewport
        ? HOME_FEED_VIRTUALIZATION_MIN_ITEMS
        : HOME_FEED_VIRTUALIZATION_MIN_ITEMS_MOBILE;
    const shouldUseLightweightHomeCardText =
        homeFeedItems.length >= homeFeedLightweightThreshold;
    const isCardGridVisible = (view === 'home' && !selectedAlbum) || view === 'browse';
    const shouldVirtualizeHomeGrid =
        isCardGridVisible &&
        homeFeedItems.length >= homeFeedVirtualizationThreshold;
    const virtualizedHomeFeedItems = useMemo(() => {
        const indexed = homeFeedItems.map((item, originalIndex) => ({ item, originalIndex }));
        if (!shouldVirtualizeHomeGrid) return indexed;
        if (indexed.length === 0) return [];
        const start = Math.max(0, Math.min(indexed.length - 1, virtualHomeGridRange.start));
        const end = Math.max(start, Math.min(indexed.length - 1, virtualHomeGridRange.end));
        return indexed.slice(start, end + 1);
    }, [homeFeedItems, shouldVirtualizeHomeGrid, virtualHomeGridRange.end, virtualHomeGridRange.start]);
    const virtualHomeGridTopPadding = useMemo(() => {
        if (!shouldVirtualizeHomeGrid) return 0;
        if (homeFeedItems.length === 0) return 0;
        const columns = Math.max(1, virtualHomeGridColumns);
        const rowHeight = Math.max(1, virtualHomeGridRowHeight);
        const start = Math.max(0, Math.min(homeFeedItems.length - 1, virtualHomeGridRange.start));
        const startRow = Math.floor(start / columns);
        return startRow * rowHeight;
    }, [homeFeedItems.length, shouldVirtualizeHomeGrid, virtualHomeGridColumns, virtualHomeGridRange.start, virtualHomeGridRowHeight]);
    const virtualHomeGridBottomPadding = useMemo(() => {
        if (!shouldVirtualizeHomeGrid) return 0;
        if (homeFeedItems.length === 0) return 0;
        const columns = Math.max(1, virtualHomeGridColumns);
        const rowHeight = Math.max(1, virtualHomeGridRowHeight);
        const totalRows = Math.ceil(homeFeedItems.length / columns);
        const safeEnd = Math.max(
            0,
            Math.min(homeFeedItems.length - 1, Math.max(virtualHomeGridRange.end, virtualHomeGridRange.start))
        );
        const endRow = Math.floor(safeEnd / columns);
        const rowsAfter = Math.max(0, totalRows - (endRow + 1));
        return rowsAfter * rowHeight;
    }, [homeFeedItems.length, shouldVirtualizeHomeGrid, virtualHomeGridColumns, virtualHomeGridRange.end, virtualHomeGridRange.start, virtualHomeGridRowHeight]);

    const updateVirtualHomeGridRange = useCallback(() => {
        if (!shouldVirtualizeHomeGrid) return;
        const root = panelContentRef.current;
        const totalItems = homeFeedItems.length;
        if (!root || totalItems === 0) {
            setVirtualHomeGridRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }

        const columns = Math.max(1, virtualHomeGridColumns);
        const totalRows = Math.max(1, Math.ceil(totalItems / columns));
        const rowHeight = Math.max(1, virtualHomeGridRowHeight);
        const overscanRows = HOME_FEED_VIRTUALIZATION_OVERSCAN_ROWS;
        const retainRows = Math.max(2, Math.floor(overscanRows / 2));
        const viewportStart = Math.max(0, root.scrollTop - virtualHomeGridTopRef.current);
        const viewportEnd = viewportStart + root.clientHeight;
        const visibleStartRow = Math.floor(viewportStart / rowHeight);
        const visibleEndRow = Math.max(visibleStartRow, Math.ceil(viewportEnd / rowHeight) - 1);
        const startRow = Math.max(0, visibleStartRow - overscanRows);
        const endRow = Math.max(startRow, Math.min(totalRows - 1, visibleEndRow + overscanRows));
        const start = startRow * columns;
        const end = Math.max(start, Math.min(totalItems - 1, ((endRow + 1) * columns) - 1));

        setVirtualHomeGridRange((prev) => {
            const hasRange = prev.end >= prev.start;
            if (hasRange) {
                const minBufferedStartRow = Math.max(0, visibleStartRow - retainRows);
                const maxBufferedEndRow = Math.min(totalRows - 1, visibleEndRow + retainRows);
                const prevStartRow = Math.floor(prev.start / columns);
                const prevEndRow = Math.floor(Math.max(prev.end, prev.start) / columns);
                const stillBuffered = prevStartRow <= minBufferedStartRow && prevEndRow >= maxBufferedEndRow;
                if (stillBuffered) return prev;
            }
            if (prev.start === start && prev.end === end) return prev;
            return { start, end };
        });
    }, [homeFeedItems.length, shouldVirtualizeHomeGrid, virtualHomeGridColumns, virtualHomeGridRowHeight]);
    const measureVirtualHomeGrid = useCallback(() => {
        if (!shouldVirtualizeHomeGrid) return;
        const root = panelContentRef.current;
        const grid = homeCardGridRef.current;
        if (!root || !grid) return;

        const rootRect = root.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        virtualHomeGridTopRef.current = root.scrollTop + (gridRect.top - rootRect.top);

        const cards = Array.from(grid.querySelectorAll('.home-album-card')) as HTMLElement[];
        if (cards.length === 0) return;

        const firstCard = cards[0];
        const firstTop = firstCard.offsetTop;
        let columns = 0;
        for (const card of cards) {
            if (Math.abs(card.offsetTop - firstTop) > 1) break;
            columns += 1;
        }
        const measuredColumns = Math.max(1, columns);
        if (measuredColumns !== virtualHomeGridColumns) {
            setVirtualHomeGridColumns(measuredColumns);
        }

        const gridStyles = window.getComputedStyle(grid);
        const rowGap = Number.parseFloat(gridStyles.rowGap || gridStyles.gap || '0') || 0;
        let measuredRowHeight = Math.round(firstCard.getBoundingClientRect().height + rowGap);
        const nextRowCard = cards.find((card) => card.offsetTop > firstTop + 1);
        if (nextRowCard) {
            measuredRowHeight = Math.round(nextRowCard.offsetTop - firstTop);
        }
        if (measuredRowHeight > 80 && Math.abs(measuredRowHeight - virtualHomeGridRowHeight) > 1) {
            setVirtualHomeGridRowHeight(measuredRowHeight);
        }
    }, [shouldVirtualizeHomeGrid, virtualHomeGridColumns, virtualHomeGridRowHeight]);

    useEffect(() => {
        if (!shouldVirtualizeHomeGrid) {
            setVirtualHomeGridRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }
        const totalItems = homeFeedItems.length;
        const initialEnd = totalItems > 0
            ? Math.min(
                totalItems - 1,
                Math.max((virtualHomeGridColumns * HOME_FEED_VIRTUALIZATION_INITIAL_ROWS) - 1, 120)
            )
            : -1;
        setVirtualHomeGridRange((prev) => (prev.start === 0 && prev.end === initialEnd ? prev : { start: 0, end: initialEnd }));
    }, [homeFeedItems.length, isSearchMode, shouldVirtualizeHomeGrid, virtualHomeGridColumns]);

    useEffect(() => {
        if (!shouldVirtualizeHomeGrid) {
            if (virtualHomeGridScrollRafRef.current != null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(virtualHomeGridScrollRafRef.current);
                virtualHomeGridScrollRafRef.current = null;
            }
            return;
        }
        if (typeof window === 'undefined') return;
        const root = panelContentRef.current;
        if (!root) return;

        const scheduleRangeUpdate = () => {
            if (virtualHomeGridScrollRafRef.current != null) return;
            virtualHomeGridScrollRafRef.current = window.requestAnimationFrame(() => {
                virtualHomeGridScrollRafRef.current = null;
                updateVirtualHomeGridRange();
            });
        };
        const refreshLayout = () => {
            measureVirtualHomeGrid();
            scheduleRangeUpdate();
        };

        refreshLayout();
        root.addEventListener('scroll', scheduleRangeUpdate, { passive: true });
        window.addEventListener('resize', refreshLayout, { passive: true });

        const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshLayout) : null;
        resizeObserver?.observe(root);
        if (homeCardGridRef.current) resizeObserver?.observe(homeCardGridRef.current);
        const contentStack = root.querySelector('.content-stack');
        if (contentStack instanceof HTMLElement) resizeObserver?.observe(contentStack);

        return () => {
            root.removeEventListener('scroll', scheduleRangeUpdate);
            window.removeEventListener('resize', refreshLayout);
            resizeObserver?.disconnect();
            if (virtualHomeGridScrollRafRef.current != null) {
                window.cancelAnimationFrame(virtualHomeGridScrollRafRef.current);
                virtualHomeGridScrollRafRef.current = null;
            }
        };
    }, [measureVirtualHomeGrid, shouldVirtualizeHomeGrid, updateVirtualHomeGridRange]);

    const handleSearchFilterChange = (key: 'sort' | 'album_type' | 'album_year' | 'album_category', rawValue: string) => {
        if (!activeSearchTerm.trim()) return;
        const overrides: Partial<SearchFilters> = { result: '' };
        if (key === 'sort') {
            overrides.sort = String(rawValue || '').trim() || 'relevance';
        } else if (key === 'album_type') {
            overrides.album_type = normalizeSearchFilterValue(rawValue);
        } else if (key === 'album_year') {
            overrides.album_year = normalizeSearchFilterValue(rawValue);
        } else if (key === 'album_category') {
            overrides.album_category = normalizeSearchFilterValue(rawValue);
        }
        void handleSearch(activeSearchTerm, overrides, { preservePage: true });
    };

    const loadMoreSearchResults = useCallback(() => {
        if (!isSearchMode || !activeSearchTerm.trim()) return;
        if (loading || isSearchAppending) return;
        const nextToken = searchPagination.nextResult;
        if (!nextToken) return;
        void handleSearch(
            activeSearchTerm,
            { result: nextToken },
            { preservePage: true, append: true, skipUrlSync: true }
        );
    }, [activeSearchTerm, handleSearch, isSearchAppending, isSearchMode, loading, searchPagination.nextResult]);

    const clearSearchFilters = () => {
        if (!activeSearchTerm.trim()) return;
        void handleSearch(
            activeSearchTerm,
            {
                sort: 'relevance',
                album_type: '',
                album_year: '',
                album_category: '',
                result: '',
            },
            { preservePage: true }
        );
    };

    const loadBrowseSection = useCallback(async (
        section: BrowseSectionKey,
        options?: {
            slug?: string;
            page?: number;
            historyMode?: 'replace' | 'push' | 'none';
            skipUrlSync?: boolean;
        }
    ) => {
        const slug = String(options?.slug || '').trim().toLowerCase();
        const page = coerceBrowsePage(String(options?.page || 1));
        const historyMode = options?.historyMode || 'replace';
        const skipUrlSync = !!options?.skipUrlSync;
        const requestId = browseRequestSeqRef.current + 1;
        browseRequestSeqRef.current = requestId;

        const panelRoot = panelContentRef.current;
        if (panelRoot) {
            panelRoot.scrollTop = 0;
        }

        setBrowseSection(section);
        setBrowseSlug(slug);
        setBrowseLoading(true);
        setBrowseNotice('');

        try {
            const payload = await api.browse({
                section,
                ...(slug ? { slug } : {}),
                page,
            });
            if (requestId !== browseRequestSeqRef.current) return;

            setBrowseSection(payload.section || section);
            setBrowseSlug(String(payload.slug || slug).trim().toLowerCase());
            setBrowseLabel(String(payload.sectionLabel || 'Browse').trim() || 'Browse');
            setBrowseItems(Array.isArray(payload.items) ? payload.items : []);
            setBrowseTopItems(Array.isArray(payload.topItems) ? payload.topItems : []);
            setBrowseTopItemsLabel(String(payload.topItemsLabel || '').trim());
            setBrowsePagination(payload.pagination || { ...DEFAULT_BROWSE_PAGINATION, currentPage: page });
            setBrowseTotalItems(
                Number.isFinite(payload?.totalItems) && Number(payload.totalItems) > 0
                    ? Number(payload.totalItems)
                    : null
            );
            setBrowseNotice(String(payload.notice || '').trim());

            const resolvedSection = (payload.section || section) as BrowseSectionKey;
            const resolvedSlug = String(payload.slug || slug).trim().toLowerCase();
            const resolvedPage = coerceBrowsePage(String(payload?.pagination?.currentPage || page));
            browseRouteRequestKeyRef.current = `${resolvedSection}|${resolvedSlug || ''}|${resolvedPage}`;

            if (!skipUrlSync) {
                replaceBrowseUrl(resolvedSection, {
                    ...(resolvedSlug ? { slug: resolvedSlug } : {}),
                    page: resolvedPage,
                    historyMode,
                });
            }

            if (payload.action?.kind === 'open_external') {
                const externalUrl = String(payload.action.externalUrl || '').trim();
                if (externalUrl && typeof window !== 'undefined') {
                    window.open(externalUrl, '_blank', 'noopener,noreferrer');
                }
                if (payload.action.message) {
                    showInlineToast(payload.action.message, 'error');
                }
                return;
            }

            if (payload.action?.kind === 'open_album') {
                const albumUrl = String(payload.action.albumUrl || '').trim();
                if (!albumUrl) {
                    showInlineToast('Could not open random album.', 'error');
                    return;
                }
                setView('home');
                await selectAlbumRef.current?.(
                    {
                        url: albumUrl,
                        albumId: payload.action.albumId || normalizeAlbumId(albumUrl) || null,
                        title: payload.action.label || 'Random Album',
                    },
                    { historyMode: 'push' }
                );
                return;
            }

            if (payload.action?.kind === 'open_track') {
                const albumUrl = String(payload.action.albumUrl || '').trim();
                const trackToken = String(payload.action.trackToken || '').trim();
                if (!albumUrl || !trackToken) {
                    showInlineToast('Could not open random song in app.', 'error');
                    return;
                }
                pendingSharedTrackTargetRef.current = parseTrackShareTarget(trackToken);
                pendingSharedTrackAlbumIdRef.current = normalizeAlbumId(payload.action.albumId || albumUrl || '');
                setPendingSharedTrackSignal((prev) => prev + 1);
                setView('home');
                await selectAlbumRef.current?.(
                    {
                        url: albumUrl,
                        albumId: payload.action.albumId || normalizeAlbumId(albumUrl) || null,
                        title: payload.action.label || 'Random Song',
                    },
                    { historyMode: 'push' }
                );
            }
        } catch (error) {
            if (requestId !== browseRequestSeqRef.current) return;
            const message = String((error as Error)?.message || 'Failed to load browse section.').trim();
            setBrowseItems([]);
            setBrowseTopItems([]);
            setBrowseTopItemsLabel('');
            setBrowsePagination({ ...DEFAULT_BROWSE_PAGINATION, currentPage: page });
            setBrowseTotalItems(null);
            setBrowseNotice(message);
            showInlineToast(message, 'error');
        } finally {
            if (requestId === browseRequestSeqRef.current) {
                setBrowseLoading(false);
            }
        }
    }, [replaceBrowseUrl, showInlineToast]);

    loadBrowseSectionRef.current = loadBrowseSection;

    const openBrowseSection = useCallback((section: BrowseSectionKey) => {
        setShowAllBrowseYears(false);
        void loadBrowseSection(section, { page: 1, historyMode: 'push' });
    }, [loadBrowseSection]);

    const openBrowseType = useCallback((slug: string) => {
        setShowAllBrowseYears(false);
        void loadBrowseSection('type', { slug, page: 1, historyMode: 'push' });
    }, [loadBrowseSection]);

    const openBrowseYear = useCallback((year: string) => {
        void loadBrowseSection('year', { slug: year, page: 1, historyMode: 'push' });
    }, [loadBrowseSection]);

    const loadBrowsePage = useCallback((page: number) => {
        if (page < 1) return;
        void loadBrowseSection(browseSection, {
            ...(browseSlug ? { slug: browseSlug } : {}),
            page,
            historyMode: 'push',
        });
    }, [browseSection, browseSlug, loadBrowseSection]);

    useEffect(() => {
        if (view !== 'browse') return;
        if (browseInitializedRef.current) return;
        browseInitializedRef.current = true;
        const browseRoute = typeof window !== 'undefined'
            ? parseBrowseRouteFromSearch(window.location.search)
            : { section: 'browse_all' as BrowseSectionKey, slug: '', page: 1 };
        browseRouteRequestKeyRef.current = `${browseRoute.section}|${browseRoute.slug || ''}|${browseRoute.page}`;
        void loadBrowseSection(browseRoute.section, {
            ...(browseRoute.slug ? { slug: browseRoute.slug } : {}),
            page: browseRoute.page,
            historyMode: 'none',
            skipUrlSync: true,
        });
    }, [loadBrowseSection, view]);

    useEffect(() => {
        if (!isSearchMode) return;
        if (view !== 'home') return;
        if (selectedAlbum) return;
        if (!searchPagination.nextResult) return;
        const sentinel = searchLoadMoreRef.current;
        if (!sentinel || !sentinel.isConnected) return;
        const root = panelContentRef.current;
        if (!root) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry?.isIntersecting) return;
                loadMoreSearchResults();
            },
            {
                root,
                rootMargin: '260px 0px',
                threshold: 0.01,
            }
        );

        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [isSearchMode, loadMoreSearchResults, searchPagination.nextResult, selectedAlbum, view]);

    const getAlbumHeroMeta = (album: any) => {
        const parts: string[] = [];
        if (album.albumType) parts.push(String(album.albumType));
        if (album.year) parts.push(String(album.year));
        return parts.join(' · ');
    };

    const getAlbumDurationText = (tracks: any[]) => {
        if (!Array.isArray(tracks) || tracks.length === 0) return null;
        let totalSeconds = 0;
        for (const track of tracks) {
            const raw = String(track?.duration || '').trim();
            if (!raw) continue;
            const parts = raw.split(':').map((p) => Number.parseInt(p, 10));
            if (parts.some((p) => Number.isNaN(p))) continue;
            if (parts.length === 2) {
                totalSeconds += (parts[0] * 60) + parts[1];
            } else if (parts.length === 3) {
                totalSeconds += (parts[0] * 3600) + (parts[1] * 60) + parts[2];
            }
        }
        if (totalSeconds <= 0) return null;
        const totalMinutes = Math.max(1, Math.floor(totalSeconds / 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (hours > 0) {
            return `${hours} hr${hours > 1 ? 's' : ''}${minutes > 0 ? ` ${minutes} min` : ''}`;
        }
        return `${totalMinutes} min`;
    };

    const albumHeroMeta = selectedAlbum ? getAlbumHeroMeta(selectedAlbum) : '';
    const albumHeaderArtist = selectedAlbum
        ? ([
            selectedAlbum.composers,
            selectedAlbum.primaryArtist,
            selectedAlbum.albumArtist,
            selectedAlbum.label,
            selectedAlbum.publisher,
            selectedAlbum.copyright,
            selectedAlbum.developers,
        ]
            .map((value) => String(value || '').trim())
            .find((value) => !!value) || '')
        : '';
    const albumDurationText = selectedAlbum ? getAlbumDurationText(selectedAlbum.tracks || []) : null;
    const albumFormats = selectedAlbum?.availableFormats
        ? selectedAlbum.availableFormats.filter((fmt: string) => fmt !== 'CD')
        : [];
    const measureAlbumDescriptionOverflow = useCallback(() => {
        const rawDescription = String(selectedAlbum?.description || '');
        const descriptionEl = albumDescRef.current;
        const descriptionTextEl = albumDescTextRef.current;

        if (!rawDescription || !descriptionEl || !descriptionTextEl || typeof window === 'undefined') {
            setIsAlbumDescOverflowing(false);
            setAlbumDescCollapsedText('');
            return;
        }

        const normalizedDescription = rawDescription.replace(/\r\n/g, '\n');

        if (window.innerWidth <= 768) {
            setIsAlbumDescOverflowing(false);
            setAlbumDescCollapsedText(normalizedDescription);
            return;
        }

        const textComputed = window.getComputedStyle(descriptionTextEl);
        const containerComputed = window.getComputedStyle(descriptionEl);
        const parsedLineHeight = Number.parseFloat(textComputed.lineHeight);
        const parsedFontSize = Number.parseFloat(textComputed.fontSize);
        const lineHeight = Number.isFinite(parsedLineHeight)
            ? parsedLineHeight
            : (Number.isFinite(parsedFontSize) ? parsedFontSize * 1.5 : 24);
        const maxCollapsedHeight = lineHeight * 4;
        const paddingLeft = Number.parseFloat(containerComputed.paddingLeft || '0');
        const paddingRight = Number.parseFloat(containerComputed.paddingRight || '0');
        const availableWidth = Math.max(1, descriptionEl.clientWidth - paddingLeft - paddingRight);

        const measurer = document.createElement('div');
        measurer.style.position = 'fixed';
        measurer.style.visibility = 'hidden';
        measurer.style.pointerEvents = 'none';
        measurer.style.left = '-9999px';
        measurer.style.top = '0';
        measurer.style.width = `${availableWidth}px`;
        measurer.style.padding = '0';
        measurer.style.margin = '0';
        measurer.style.border = '0';
        measurer.style.fontFamily = textComputed.fontFamily;
        measurer.style.fontSize = textComputed.fontSize;
        measurer.style.fontStyle = textComputed.fontStyle;
        measurer.style.fontWeight = textComputed.fontWeight;
        measurer.style.letterSpacing = textComputed.letterSpacing;
        measurer.style.lineHeight = textComputed.lineHeight;
        measurer.style.whiteSpace = 'pre-line';
        measurer.style.wordBreak = 'break-word';
        measurer.style.overflowWrap = 'anywhere';

        document.body.appendChild(measurer);

        try {
            measurer.textContent = normalizedDescription;
            const fullTextHeight = measurer.scrollHeight;
            const hasOverflow = fullTextHeight > (maxCollapsedHeight + 1);

            if (!hasOverflow) {
                setIsAlbumDescOverflowing(false);
                setAlbumDescCollapsedText(normalizedDescription);
                return;
            }

            const tailToken = '...MORE';
            let low = 1;
            let high = normalizedDescription.length;
            let best = 1;

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const candidate = normalizedDescription.slice(0, mid).trimEnd();
                measurer.textContent = `${candidate}${tailToken}`;

                if (measurer.scrollHeight <= (maxCollapsedHeight + 1)) {
                    best = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            let collapsedText = normalizedDescription.slice(0, best).trimEnd();
            const wordSafe = collapsedText.replace(/\s+\S*$/, '').trimEnd();
            if (wordSafe.length >= Math.max(12, collapsedText.length - 14)) {
                collapsedText = wordSafe;
            }
            if (!collapsedText) {
                collapsedText = normalizedDescription.slice(0, Math.min(24, normalizedDescription.length)).trimEnd();
            }

            setIsAlbumDescOverflowing(true);
            setAlbumDescCollapsedText(collapsedText);
        } finally {
            document.body.removeChild(measurer);
        }
    }, [selectedAlbum?.description]);
    const scheduleAlbumDescriptionMeasure = useCallback(() => {
        if (typeof window === 'undefined') return;
        if (albumDescMeasureRafRef.current != null) {
            window.cancelAnimationFrame(albumDescMeasureRafRef.current);
        }
        albumDescMeasureRafRef.current = window.requestAnimationFrame(() => {
            albumDescMeasureRafRef.current = null;
            measureAlbumDescriptionOverflow();
        });
    }, [measureAlbumDescriptionOverflow]);
    const handleAlbumDescriptionToggle = useCallback(() => {
        setIsAlbumDescExpanded((prev) => {
            const next = !prev;
            if (!next && albumDescRef.current) {
                albumDescRef.current.scrollTop = 0;
            }
            return next;
        });
    }, []);
    const albumFormatWithSizes = (() => {
        const sizeByFormat = new Map<string, string>();
        const rawTotalSize = String(selectedAlbum?.totalFilesize || '');
        const sizePattern = /\b\d+(\.\d+)?\s*(KB|MB|GB|TB)\b/i;

        if (rawTotalSize) {
            rawTotalSize.split(/\s*,\s*/).forEach((entry: string) => {
                const pair = entry.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
                if (!pair) return;

                const left = String(pair[1] || '').trim();
                const right = String(pair[2] || '').trim();
                if (!left || !right) return;

                const leftIsSize = sizePattern.test(left);
                const rightIsSize = sizePattern.test(right);

                if (leftIsSize && !rightIsSize) {
                    sizeByFormat.set(right.toUpperCase(), left);
                } else if (rightIsSize && !leftIsSize) {
                    sizeByFormat.set(left.toUpperCase(), right);
                }
            });
        }

        return albumFormats.map((fmt: string) => {
            const formatName = String(fmt).toUpperCase();
            const size = sizeByFormat.get(formatName);
            return size ? `${formatName} (${size})` : formatName;
        });
    })();
    const albumComments = useMemo(() => {
        const comments = Array.isArray(selectedAlbum?.comments) ? selectedAlbum.comments : [];
        return comments.filter((comment: any) => String(comment?.message || '').trim().length > 0);
    }, [selectedAlbum?.comments]);
    const visibleAlbumComments = useMemo(() => {
        if (isAllCommentsVisible) return albumComments;
        return albumComments.slice(0, ALBUM_COMMENTS_COLLAPSED_COUNT);
    }, [albumComments, isAllCommentsVisible]);
    const hiddenAlbumCommentsCount = Math.max(0, albumComments.length - visibleAlbumComments.length);
    const albumCommentCountLabel = albumComments.length === 1
        ? '1 Comment'
        : `${albumComments.length} Comments`;
    const deferredTrackFilterQuery = useDeferredValue(trackFilterQuery);
    const normalizedTrackFilter = useMemo(() => deferredTrackFilterQuery.trim().toLowerCase(), [deferredTrackFilterQuery]);
    const filteredAlbumTracks = useMemo(() => {
        const albumTracks = Array.isArray(selectedAlbum?.tracks) ? selectedAlbum.tracks : [];
        if (albumTracks.length === 0) return [];
        return albumTracks
            .map((t: any, index: number) => ({ track: t, originalIndex: index }))
            .filter(({ track }: any) => {
                if (!normalizedTrackFilter) return true;
                return String(track.title || '').toLowerCase().includes(normalizedTrackFilter);
            });
    }, [selectedAlbum?.tracks, normalizedTrackFilter]);
    const trackListVirtualizationThreshold = isDesktopViewport
        ? TRACKLIST_VIRTUALIZATION_MIN_ITEMS
        : TRACKLIST_VIRTUALIZATION_MIN_ITEMS_MOBILE;
    const shouldVirtualizeTrackList = filteredAlbumTracks.length >= trackListVirtualizationThreshold;
    const trackRowLightweightThreshold = TRACKLIST_LIGHTWEIGHT_TITLE_MIN_ITEMS;
    const shouldUseLightweightTrackRows = shouldVirtualizeTrackList && filteredAlbumTracks.length >= trackRowLightweightThreshold;
    const virtualizedFilteredAlbumTracks = useMemo(() => {
        if (!shouldVirtualizeTrackList) return filteredAlbumTracks;
        if (filteredAlbumTracks.length === 0) return [];
        const start = Math.max(0, Math.min(filteredAlbumTracks.length - 1, virtualTrackRange.start));
        const end = Math.max(start, Math.min(filteredAlbumTracks.length - 1, virtualTrackRange.end));
        return filteredAlbumTracks.slice(start, end + 1);
    }, [filteredAlbumTracks, shouldVirtualizeTrackList, virtualTrackRange.end, virtualTrackRange.start]);
    const virtualTrackTopPadding = shouldVirtualizeTrackList
        ? Math.max(0, virtualTrackRange.start) * virtualTrackRowHeight
        : 0;
    const virtualTrackBottomPadding = shouldVirtualizeTrackList
        ? Math.max(0, filteredAlbumTracks.length - (Math.max(virtualTrackRange.end, virtualTrackRange.start) + 1)) * virtualTrackRowHeight
        : 0;
    const updateVirtualTrackRange = useCallback(() => {
        if (!shouldVirtualizeTrackList) return;
        const root = panelContentRef.current;
        const totalItems = filteredAlbumTracks.length;

        if (!root || totalItems === 0) {
            setVirtualTrackRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }

        const rowHeight = Math.max(1, virtualTrackRowHeight);
        const overscanRows = TRACKLIST_VIRTUALIZATION_OVERSCAN_ROWS;
        const retainRows = Math.max(4, Math.floor(overscanRows / 2));
        const viewportStart = Math.max(0, root.scrollTop - virtualTrackListTopRef.current);
        const viewportEnd = viewportStart + root.clientHeight;
        const visibleStart = Math.floor(viewportStart / rowHeight);
        const visibleEnd = Math.max(visibleStart, Math.ceil(viewportEnd / rowHeight) - 1);

        const start = Math.max(0, visibleStart - overscanRows);
        const end = Math.max(start, Math.min(totalItems - 1, visibleEnd + overscanRows));

        setVirtualTrackRange((prev) => {
            const hasRange = prev.end >= prev.start;
            if (hasRange) {
                const minBufferedStart = Math.max(0, visibleStart - retainRows);
                const maxBufferedEnd = Math.min(totalItems - 1, visibleEnd + retainRows);
                const stillBuffered = prev.start <= minBufferedStart && prev.end >= maxBufferedEnd;
                if (stillBuffered) return prev;
            }
            if (prev.start === start && prev.end === end) return prev;
            return { start, end };
        });
    }, [filteredAlbumTracks.length, shouldVirtualizeTrackList, virtualTrackRowHeight]);
    const measureVirtualTrackList = useCallback(() => {
        if (!shouldVirtualizeTrackList) return;
        const root = panelContentRef.current;
        const list = trackListRef.current;
        if (!root || !list) return;

        const rootRect = root.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        virtualTrackListTopRef.current = root.scrollTop + (listRect.top - rootRect.top);

        const sampleRow = list.querySelector('.track-row') as HTMLElement | null;
        if (!sampleRow) return;
        const measuredHeight = Math.round(sampleRow.getBoundingClientRect().height);
        if (measuredHeight > 20 && Math.abs(measuredHeight - virtualTrackRowHeight) > 1) {
            setVirtualTrackRowHeight(measuredHeight);
        }
    }, [shouldVirtualizeTrackList, virtualTrackRowHeight]);

    useEffect(() => {
        if (!shouldVirtualizeTrackList) {
            setVirtualTrackRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }
        const totalItems = filteredAlbumTracks.length;
        const initialEnd = totalItems > 0 ? Math.min(totalItems - 1, 56) : -1;
        setVirtualTrackRange((prev) => (prev.start === 0 && prev.end === initialEnd ? prev : { start: 0, end: initialEnd }));
    }, [filteredAlbumTracks.length, normalizedTrackFilter, selectedUrl, shouldVirtualizeTrackList]);

    useEffect(() => {
        if (!shouldVirtualizeTrackList) {
            if (virtualTrackScrollRafRef.current != null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(virtualTrackScrollRafRef.current);
                virtualTrackScrollRafRef.current = null;
            }
            return;
        }
        if (typeof window === 'undefined') return;
        const root = panelContentRef.current;
        if (!root) return;

        const scheduleRangeUpdate = () => {
            if (virtualTrackScrollRafRef.current != null) return;
            virtualTrackScrollRafRef.current = window.requestAnimationFrame(() => {
                virtualTrackScrollRafRef.current = null;
                updateVirtualTrackRange();
            });
        };
        const refreshLayout = () => {
            measureVirtualTrackList();
            scheduleRangeUpdate();
        };

        refreshLayout();
        root.addEventListener('scroll', scheduleRangeUpdate, { passive: true });
        window.addEventListener('resize', refreshLayout, { passive: true });

        const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshLayout) : null;
        resizeObserver?.observe(root);
        if (trackListRef.current) resizeObserver?.observe(trackListRef.current);
        const contentStack = root.querySelector('.content-stack');
        if (contentStack instanceof HTMLElement) resizeObserver?.observe(contentStack);

        return () => {
            root.removeEventListener('scroll', scheduleRangeUpdate);
            window.removeEventListener('resize', refreshLayout);
            resizeObserver?.disconnect();
            if (virtualTrackScrollRafRef.current != null) {
                window.cancelAnimationFrame(virtualTrackScrollRafRef.current);
                virtualTrackScrollRafRef.current = null;
            }
        };
    }, [measureVirtualTrackList, shouldVirtualizeTrackList, updateVirtualTrackRange]);

    const albumDescriptionClassName = [
        'f-body',
        'description-box',
        'medieval-scroll',
        isAlbumDescExpanded ? 'is-expanded' : 'is-collapsed',
        isAlbumDescOverflowing ? 'is-overflowing' : '',
    ].filter(Boolean).join(' ');

    useEffect(() => {
        setIsAlbumDescExpanded(false);
        setIsAlbumDescOverflowing(false);
        setAlbumDescCollapsedText('');
    }, [selectedUrl]);

    useEffect(() => {
        if (!selectedAlbum?.description) {
            setIsAlbumDescOverflowing(false);
            setAlbumDescCollapsedText('');
            return;
        }
        if (isAlbumDescExpanded) return;
        scheduleAlbumDescriptionMeasure();
    }, [selectedAlbum?.description, scheduleAlbumDescriptionMeasure, isAlbumDescExpanded]);

    useEffect(() => {
        if (typeof window === 'undefined' || !selectedAlbum?.description) return;
        const descriptionEl = albumDescRef.current;
        if (!descriptionEl) return;

        if (!isAlbumDescExpanded) {
            scheduleAlbumDescriptionMeasure();
        }

        const resizeObserver = new ResizeObserver(() => {
            if (isAlbumDescExpanded) return;
            scheduleAlbumDescriptionMeasure();
        });

        resizeObserver.observe(descriptionEl);
        const headerInfoEl = descriptionEl.closest('.header-info');
        if (headerInfoEl instanceof HTMLElement) {
            resizeObserver.observe(headerInfoEl);
        }

        const handleWindowResize = () => {
            if (isAlbumDescExpanded) return;
            scheduleAlbumDescriptionMeasure();
        };
        window.addEventListener('resize', handleWindowResize);

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleWindowResize);
            if (albumDescMeasureRafRef.current != null) {
                window.cancelAnimationFrame(albumDescMeasureRafRef.current);
                albumDescMeasureRafRef.current = null;
            }
        };
    }, [selectedAlbum?.description, scheduleAlbumDescriptionMeasure, isAlbumDescExpanded]);

    const getHomeCardKey = useCallback((item: any) => {
        const normalizedAlbumId = normalizeAlbumId(item?.albumId || item?.url || item?.albumUrl);
        if (normalizedAlbumId) return `id:${normalizedAlbumId}`;
        const normalizedPath = String(extractPathFromUrl(String(item?.url || item?.albumUrl || '').trim()) || '')
            .replace(/[/?]+$/, '')
            .toLowerCase();
        if (normalizedPath) return `path:${normalizedPath}`;
        const normalizedTitle = String(item?.title || '').trim().toLowerCase();
        if (normalizedTitle) return `title:${normalizedTitle}`;
        return '';
    }, []);
    const getHomeCardCandidates = useCallback((item: any) => {
        const seen = new Set<string>();
        const candidates: string[] = [];
        const add = (raw?: string) => {
            const normalized = normalizeAlbumId(raw) || normalizeAlbumId(extractPathFromUrl(String(raw || '').trim()));
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push(normalized);
        };

        add(item?.albumId);
        add(item?.url);
        add(item?.albumUrl);
        return candidates;
    }, []);
    const getLargeThumbUrl = useCallback((rawUrl: string) => {
        const value = String(rawUrl || '').trim();
        if (!value) return '';
        return value.includes('/thumbs_small/') ? value.replace('/thumbs_small/', '/thumbs_large/') : value;
    }, []);
    const normalizeHomeCardArtist = useCallback((raw: any) => {
        const value = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!value) return '';
        const lowered = value.toLowerCase();
        if (
            lowered === 'unknown' ||
            lowered === 'unknown artist' ||
            lowered === 'n/a' ||
            lowered === 'na' ||
            lowered === 'none' ||
            lowered === 'null' ||
            lowered === 'undefined' ||
            lowered === '-' ||
            lowered === '--' ||
            lowered === '?'
        ) {
            return '';
        }
        return value;
    }, []);
    const getHomeCardImage = useCallback((item: any, fallbackImage: string) => {
        const key = getHomeCardKey(item);
        const cached = key ? homeCardArt[key] : undefined;
        const source = String(cached?.image || fallbackImage || '').trim();
        return getLargeThumbUrl(source);
    }, [getHomeCardKey, homeCardArt, getLargeThumbUrl]);
    const getHomeCardArtistLine = (item: any) => {
        const key = getHomeCardKey(item);
        const cached = key ? homeCardArt[key] : undefined;
        const candidates = [
            cached?.artist,
            item?.primaryArtist,
            item?.artist,
            item?.artistName,
            item?.albumArtist,
            item?.composers,
            item?.developers,
            item?.publisher,
        ];

        for (const candidate of candidates) {
            const normalized = normalizeHomeCardArtist(candidate);
            if (normalized) return normalized;
        }
        return '';
    };
    const getHomeCardTypeYearLine = (item: any) => {
        const key = getHomeCardKey(item);
        const cached = key ? homeCardArt[key] : undefined;
        const albumType = String(item?.albumType || cached?.albumType || '').trim();
        const year = String(item?.year || cached?.year || '').trim();
        const parts = [albumType, year].filter(Boolean);
        if (parts.length > 0) return parts.join(' · ');
        return '';
    };
    useEffect(() => {
        homeCardArtRef.current = homeCardArt;
    }, [homeCardArt]);

    const ensureHomeCardMeta = useCallback((item: any) => {
        const key = getHomeCardKey(item);
        if (!key) return;

        const cached = homeCardArtRef.current[key];
        if (cached?.metadataResolved) return;
        if (homeCardMetaInFlightRef.current.has(key)) return;

        const candidates = getHomeCardCandidates(item);
        if (candidates.length === 0) {
            setHomeCardArt((prev) => {
                const existing = prev[key];
                if (existing?.metadataResolved) return prev;
                return {
                    ...prev,
                    [key]: {
                        ...(existing || {}),
                        metadataResolved: true,
                    },
                };
            });
            return;
        }

        const request = (async () => {
            const controller = new AbortController();
            let meta: any = null;

            for (const candidate of candidates) {
                try {
                    meta = await api.getAlbum(candidate, controller.signal);
                    if (meta) break;
                } catch {
                }
            }

            setHomeCardArt((prev) => {
                const existing = prev[key];
                if (existing?.metadataResolved) return prev;

                const nextCardData: HomeCardData = {
                    ...(existing || {}),
                    metadataResolved: true,
                };

                if (meta) {
                    const preferredCover = String(meta?.albumImages?.[0] || meta?.imagesThumbs?.[0] || '').trim();
                    if (preferredCover) nextCardData.image = preferredCover;

                    const artist = normalizeHomeCardArtist(
                        meta?.primaryArtist || meta?.albumArtist || meta?.composers || meta?.developers || meta?.publisher
                    );
                    if (artist) nextCardData.artist = artist;

                    const albumType = String(meta?.albumType || '').trim();
                    if (albumType) nextCardData.albumType = albumType;

                    const year = String(meta?.year || '').trim();
                    if (year) nextCardData.year = year;
                }

                const unchanged =
                    existing &&
                    existing.metadataResolved === nextCardData.metadataResolved &&
                    existing.image === nextCardData.image &&
                    existing.artist === nextCardData.artist &&
                    existing.albumType === nextCardData.albumType &&
                    existing.year === nextCardData.year;

                if (unchanged) return prev;

                return { ...prev, [key]: nextCardData };
            });
        })().finally(() => {
            homeCardMetaInFlightRef.current.delete(key);
        });

        homeCardMetaInFlightRef.current.set(key, request);
    }, [getHomeCardKey, getHomeCardCandidates, normalizeHomeCardArtist]);

    const syncViewUrl = useCallback((nextView: AppView, options?: { historyMode?: 'replace' | 'push' }) => {
        if (typeof window === 'undefined') return;
        const targetPath = nextView === 'browse'
            ? getBrowseRouteUrl(browseSection, { slug: browseSlug, page: browsePagination.currentPage })
            : getPathForView(nextView);
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (currentUrl === targetPath) return;
        const currentState = (window.history.state && typeof window.history.state === 'object')
            ? window.history.state
            : {};
        if (options?.historyMode === 'push') {
            window.history.pushState({ ...currentState }, '', targetPath);
            return;
        }
        window.history.replaceState({ ...currentState }, '', targetPath);
    }, [browsePagination.currentPage, browseSection, browseSlug]);

    const syncPlaylistUrl = useCallback((playlistIdentifier: string | null, options?: { historyMode?: 'replace' | 'push' }) => {
        if (typeof window === 'undefined') return;
        const targetPath = playlistIdentifier
            ? getPlaylistPathForIdentifier(playlistIdentifier)
            : getPathForView('playlists');
        const currentUrl = `${window.location.pathname}${window.location.search}`;
        if (currentUrl === targetPath) return;
        const currentState = (window.history.state && typeof window.history.state === 'object')
            ? window.history.state
            : {};
        if (options?.historyMode === 'push') {
            window.history.pushState({ ...currentState }, '', targetPath);
            return;
        }
        window.history.replaceState({ ...currentState }, '', targetPath);
    }, []);

    const importSharedPlaylist = useCallback((options?: { historyMode?: 'replace' | 'push' }) => {
        if (!sharedPlaylistData?.playlist) {
            showAppNotice('No shared playlist loaded.', 'Import Failed');
            return;
        }
        const uniqueName = getUniquePlaylistName(sharedPlaylistData.playlist.name || 'Shared Playlist', playlists);
        const created = createPlaylistRecord(uniqueName, sharedPlaylistData.playlist.byline);
        const appended = appendTracksToPlaylist(created, sharedPlaylistData.playlist.tracks || []);
        const nextIdentifier = toPlaylistRouteIdentifier(appended.playlist);

        setPlaylists((prev) => [appended.playlist, ...prev]);
        setSelectedPlaylistId(appended.playlist.id);
        setPlaylistRouteIdentifier(nextIdentifier);
        resetSharedPlaylistState();
        setView('playlists');
        syncPlaylistUrl(nextIdentifier, options || { historyMode: 'push' });
        showAppNotice(`Imported shared playlist "${appended.playlist.name}".`, 'Playlist Imported');
    }, [getUniquePlaylistName, playlists, resetSharedPlaylistState, sharedPlaylistData, showAppNotice, syncPlaylistUrl]);

    const navigateHomeView = useCallback((options?: { historyMode?: 'replace' | 'push' }) => {
        resetSearchState();
        setQuery('');
        setSelectedAlbum(null);
        setSelectedUrl(null);
        setPlaylistRouteIdentifier(null);
        resetSharedPlaylistState();
        setView('home');
        syncViewUrl('home', options);
    }, [resetSearchState, resetSharedPlaylistState, syncViewUrl]);

    const navigatePlaylistsHome = useCallback((options?: { historyMode?: 'replace' | 'push' }) => {
        setSelectedAlbum(null);
        setSelectedUrl(null);
        setPlaylistRouteIdentifier(null);
        resetSharedPlaylistState();
        setView('playlists');
        syncPlaylistUrl(null, options);
    }, [resetSharedPlaylistState, syncPlaylistUrl]);

    const navigateBackOrHome = useCallback(() => {
        if (typeof window !== 'undefined' && window.history.length > 1) {
            window.history.back();
            return;
        }
        navigateHomeView({ historyMode: 'replace' });
    }, [navigateHomeView]);

    const openPlaylistIdentifierView = useCallback((playlistId: string, options?: { historyMode?: 'replace' | 'push' }) => {
        const sourcePlaylist = playlists.find((playlist) => playlist.id === playlistId);
        if (!sourcePlaylist) return;
        const identifier = toPlaylistRouteIdentifier(sourcePlaylist);
        setSelectedAlbum(null);
        setSelectedUrl(null);
        setSelectedPlaylistId(sourcePlaylist.id);
        setPlaylistRouteIdentifier(identifier);
        resetSharedPlaylistState();
        setView('playlists');
        syncPlaylistUrl(identifier, options);
    }, [playlists, resetSharedPlaylistState, syncPlaylistUrl]);

    const setViewAndCloseSidebar = useCallback((nextView: AppView) => {
        const shouldCloseSidebar = !isDesktopViewport && isSidebarVisible;
        if (!isDesktopViewport && nextView === 'queue' && view === 'queue') {
            navigateBackOrHome();
            if (shouldCloseSidebar) closeSidebar();
            return;
        }
        if (nextView === 'home') {
            navigateHomeView({ historyMode: 'push' });
            if (shouldCloseSidebar) closeSidebar();
            return;
        }
        if (nextView === 'playlists') {
            navigatePlaylistsHome({ historyMode: 'push' });
            if (shouldCloseSidebar) closeSidebar();
            return;
        }
        setSelectedAlbum(null);
        setSelectedUrl(null);
        setPlaylistRouteIdentifier(null);
        resetSharedPlaylistState();
        setView(nextView);
        syncViewUrl(nextView, { historyMode: 'push' });
        if (shouldCloseSidebar) closeSidebar();
    }, [closeSidebar, isDesktopViewport, isSidebarVisible, navigateBackOrHome, navigateHomeView, navigatePlaylistsHome, resetSharedPlaylistState, syncViewUrl, view]);

    const handlePlayerQueueAction = useCallback(() => {
        const isMobileViewport = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
        if (isMobileViewport) {
            queueOverlayHostRef.current?.open();
            return;
        }
        toggleQueueOverlay();
    }, [toggleQueueOverlay]);

    useEffect(() => {
        if (view !== 'playlists') return;
        if (sharedPlaylistMode !== 'none') return;
        if (!playlistRouteIdentifier || !selectedPlaylistId) return;
        const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId);
        if (!selectedPlaylist) return;
        const canonicalIdentifier = toPlaylistRouteIdentifier(selectedPlaylist);
        if (canonicalIdentifier === playlistRouteIdentifier) return;
        setPlaylistRouteIdentifier(canonicalIdentifier);
        syncPlaylistUrl(canonicalIdentifier, { historyMode: 'replace' });
    }, [playlists, playlistRouteIdentifier, selectedPlaylistId, sharedPlaylistMode, syncPlaylistUrl, view]);

    const handleHomeCardSelect = useCallback((payload?: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const item = payload as any;
        if (!item?.icon && item?.image) {
            selectAlbum({ ...item, icon: item.image });
            return;
        }
        selectAlbum(item);
    }, [selectAlbum]);

    const isSharedPlaylistIdentifierPage = view === 'playlists' && sharedPlaylistMode !== 'none';
    const isPlaylistIdentifierPage = view === 'playlists' && (!!playlistRouteIdentifier || isSharedPlaylistIdentifierPage);
    const shouldShowTopHeader = true;
    const perfSamplerMetrics = useMemo<PerfSamplerMetrics>(() => {
        const apiCache = api.getCacheStats();
        const dlCache = dlManager.getCacheStats();
        return {
            renderedCardCount: isCardGridVisible ? virtualizedHomeFeedItems.length : 0,
            searchResultCount: results.length,
            browseItemCount: browseItems.length,
            albumCacheSize: apiCache.albumCacheSize,
            resolveCacheSize: dlCache.resolveCacheSize,
            view,
            isSearchMode,
        };
    }, [
        browseItems.length,
        isCardGridVisible,
        isSearchMode,
        results.length,
        view,
        virtualizedHomeFeedItems.length,
    ]);

    if (!isClient || !hasInitialRouteSync) {
        return (
            <div className="app-root">
                <div className="grimoire-container">
                    <div className="panel-content" style={{ gridColumn: '1 / -1' }}>
                        <LoadingIndicator />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <>
            <audio
                ref={audioRef}
                preload="metadata"
                loop={isRepeatEnabled}
                onLoadedMetadata={() => {
                    if (audioRef.current) {
                        audioRef.current.playbackRate = playbackRate;
                        setAudioDuration(audioRef.current.duration);
                    }
                }}
                onEnded={() => {
                    if (isRepeatEnabled) return;
                    setIsPlaying(false);
                    playNext();
                }}
                onPause={() => { setIsPlaying(false); setAudioLoadingDebounced(false); }}
                onPlay={() => { setIsPlaying(true); setAudioLoadingDebounced(false); }}
                onWaiting={() => setAudioLoadingDebounced(true)}
                onCanPlay={() => setAudioLoadingDebounced(false)}
                onLoadStart={() => setAudioLoadingDebounced(true)}
                {...({ referrerPolicy: "no-referrer" } as any)}
            />
            <ClientPerfVitals samplerMetrics={perfSamplerMetrics} />
            <React.Profiler id="QueueOverlayHost" onRender={handleQueueProfilerRender}>
                <QueueOverlayHost
                    ref={queueOverlayHostRef}
                    queue={queue}
                    currentTrack={currentTrack}
                    onPlay={handleQueueTrackPlay}
                    onRemove={removeFromPlaybackQueue}
                    onClearManual={clearManualQueue}
                    onClearAlbum={clearAlbumQueue}
                    sourceLabel={playbackSourceLabel}
                    onAddToPlaylist={handleAddQueueTrackToPlaylist}
                    onAddManualQueueToPlaylist={handleAddManualQueueToPlaylist}
                    isPlaylistRecentlyAdded={trackHasRecentPlaylistAdd}
                    onOpenRequest={handleQueueOverlayOpenRequest}
                    onCloseRequest={handleQueueOverlayCloseRequest}
                    onVisibilityApplied={handleQueueOverlayVisibilityApplied}
                    onFirstRowPainted={handleQueueOverlayFirstRowPainted}
                />
            </React.Profiler>
            <PlaylistPickerOverlay
                isOpen={playlistPickerState.open}
                mode={playlistPickerState.mode}
                tracks={playlistPickerState.tracks}
                playlists={playlists}
                onClose={closePlaylistPicker}
                onCreateAndAddToPlaylist={createPlaylistAndAddTracks}
                onAddToPlaylist={addTracksToPlaylist}
                onRemoveFromPlaylist={removeTracksFromPlaylist}
                onPlaylistAddSuccess={handlePlaylistAddSuccess}
            />
            {appNotice ? (
                <div className="app-notice-overlay" role="presentation">
                    <div className="app-notice-backdrop" onClick={closeAppNotice}></div>
                    <div
                        className="app-notice-shell"
                        role="dialog"
                        aria-modal="true"
                        aria-label={appNotice.title}
                    >
                        <div className="app-notice-header">
                            <h3 className="f-header app-notice-title">{appNotice.title}</h3>
                            <button
                                type="button"
                                className="q-close-btn"
                                onClick={closeAppNotice}
                                aria-label="Close notice"
                            >
                                <Icon name="close" size={18} />
                            </button>
                        </div>
                        <div className="app-notice-body">
                            <p className="app-notice-message">{appNotice.message}</p>
                            {appNotice.suppressKey ? (
                                <label className="app-notice-suppress-toggle">
                                    <input
                                        type="checkbox"
                                        checked={appNoticeSuppressChecked}
                                        onChange={(event) => setAppNoticeSuppressChecked(event.target.checked)}
                                    />
                                    <span>{appNotice.suppressLabel || "Don't show this again"}</span>
                                </label>
                            ) : null}
                            <div className="app-notice-actions">
                                <button
                                    type="button"
                                    className="btn-main album-hero-action-btn"
                                    onClick={closeAppNotice}
                                >
                                    OK
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
            {playlistAddToastMessage ? (
                <div
                    className={`playlist-add-toast ${playlistAddToastTone === 'error' ? 'is-error' : 'is-success'}`}
                    role="status"
                    aria-live="polite"
                >
                    <span>{playlistAddToastMessage}</span>
                </div>
            ) : null}
            <div className={`app-root ${hasPlayer ? 'has-player' : ''}`}>
                <div className={`grimoire-container ${isSidebarOpen ? 'with-sidebar' : ''} ${isSidebarShifted ? 'is-sidebar-shifted' : ''} ${isSidebarHandoff ? 'is-sidebar-handoff' : ''}`}>
                    <button
                        type="button"
                        className={`panel-nav-backdrop ${isSidebarVisible ? 'is-visible' : ''}`}
                        onClick={closeSidebar}
                        aria-label="Close sidebar"
                    />
                    <div className={`panel-nav ${isSidebarVisible ? 'is-open' : ''} ${isSidebarOpen ? 'is-layout-ready' : ''}`}>
                        <div className="panel-nav-head">
                            <button
                                type="button"
                                className="f-header panel-nav-logo panel-nav-logo-btn"
                                onClick={() => navigateHomeView({ historyMode: 'push' })}
                            >
                                KHI-DL
                            </button>
                            <button
                                type="button"
                                className="panel-nav-close-btn"
                                onClick={closeSidebar}
                                aria-label="Close sidebar"
                            >
                                <Icon name="close" size={18} />
                            </button>
                        </div>
                        <div className="panel-nav-separator"></div>
                        <div className="panel-nav-links">
                            <button className={`nav-item ${view === 'home' ? 'active' : ''}`} onClick={() => setViewAndCloseSidebar('home')}>
                                <Icon name="search" size={24} />
                                <span className="f-ui nav-text">Search</span>
                            </button>
                            <button className={`nav-item ${view === 'browse' ? 'active' : ''}`} onClick={() => setViewAndCloseSidebar('browse')}>
                                <Icon name="book" size={24} />
                                <span className="f-ui nav-text">Browse</span>
                            </button>
                            <button className={`nav-item ${view === 'liked' ? 'active' : ''}`} onClick={() => setViewAndCloseSidebar('liked')}>
                                <Icon name="heartFilled" size={24} />
                                <span className="f-ui nav-text">Liked</span>
                            </button>
                            <button className={`nav-item ${view === 'playlists' ? 'active' : ''}`} onClick={() => setViewAndCloseSidebar('playlists')}>
                                <Icon name="listMusic" size={24} />
                                <span className="f-ui nav-text">Playlists</span>
                            </button>
                            <button className={`nav-item nav-item-mobile-secondary ${view === 'queue' ? 'active' : ''}`} onClick={() => setViewAndCloseSidebar('queue')}>
                                <div className="nav-icon-wrap">
                                    <Icon name="download" size={24} />
                                    {queueCount > 0 && <span className="nav-badge">{queueCount}</span>}
                                </div>
                                <span className="f-ui nav-text">Queue</span>
                            </button>
                            <button className={`nav-item nav-item-mobile-secondary ${view === 'settings' ? 'active' : ''}`} onClick={() => setViewAndCloseSidebar('settings')}>
                                <Icon name="settings" size={24} />
                                <span className="f-ui nav-text">Settings</span>
                            </button>
                            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="nav-item nav-item-mobile-secondary">
                                <Icon name="discord" size={24} />
                                <span className="f-ui nav-text">Discord</span>
                            </a>
                        </div>
                    </div>
                    {shouldShowTopHeader ? (
                        <>
                            <div className="top-header">
                                <div className="top-header-left">
                                    <button
                                        type="button"
                                        className="menu-toggle-btn"
                                        onClick={toggleSidebar}
                                        aria-label="Toggle sidebar"
                                        aria-expanded={isSidebarVisible}
                                    >
                                        <Icon name="menu" size={20} />
                                    </button>
                                </div>
                                <div className="top-header-search">
                                    <div className="search-input-wrapper">
                                        <input
                                            ref={searchInputRef}
                                            type="text"
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                            onKeyDown={handleInputKey}
                                            onPaste={handleInputPaste}
                                            onFocus={() => setIsSearchInputFocused(true)}
                                            onBlur={() => setIsSearchInputFocused(false)}
                                            placeholder="Search the library or paste a URL..."
                                            className="search-input"
                                        />
                                        <div className="search-icon"><Icon name="search" size={16} /></div>
                                    </div>
                                </div>
                                <div className="top-header-right">
                                    {view !== 'queue' && (
                                        <button
                                            type="button"
                                            className="top-header-queue-btn mobile-only"
                                            onClick={() => setViewAndCloseSidebar('queue')}
                                            aria-label="Open download queue"
                                            title="Download Queue"
                                        >
                                            <Icon name="download" size={18} />
                                        </button>
                                    )}
                                    <div className="top-header-right-spacer desktop-only" aria-hidden="true"></div>
                                </div>
                            </div>
                            <div className="top-header-separator"></div>
                        </>
                    ) : null}
                    <div className="app-shell-main">
                        <div ref={panelContentRef} className="panel-content medieval-scroll">

                            <div className="content-stack">
                                {view === 'home' && (
                                    <ViewPanel>
                                        {selectedAlbum ? (
                                            <div className="content-inner">
                                                <div className="album-back-floating-wrap">
                                                    <button className="btn-back-floating" onClick={handleBack}>
                                                        <Icon name="arrowLeft" size={16} />
                                                        Back
                                                    </button>
                                                </div>
                                                <div className="meta-header">
                                                    <div
                                                        className="album-hero-art-wrap"
                                                        onClick={openSelectedAlbumGallery}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                e.preventDefault();
                                                                openSelectedAlbumGallery();
                                                            }
                                                        }}
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-label="Open album art gallery"
                                                    >
                                                        <AlbumArtStack
                                                            images={(selectedAlbum.albumImages && selectedAlbum.albumImages.length > 0)
                                                                ? selectedAlbum.albumImages
                                                                : (selectedAlbum.imagesThumbs || [])}
                                                            onClick={openSelectedAlbumGallery}
                                                            heroPriority={true}
                                                        />
                                                    </div>
                                                    <div className="header-info">
                                                        <h1 className="f-header album-title">{selectedAlbum.name}</h1>
                                                        {albumHeaderArtist && <div className="f-ui album-artist">{albumHeaderArtist}</div>}
                                                        {albumHeroMeta && <div className="album-hero-meta">{albumHeroMeta}</div>}
                                                        {selectedAlbum.description && (
                                                            <div
                                                                ref={albumDescRef}
                                                                className={albumDescriptionClassName}
                                                            >
                                                                {!isAlbumDescExpanded ? (
                                                                    <span ref={albumDescTextRef} className="album-desc-text">
                                                                        {isAlbumDescOverflowing ? albumDescCollapsedText : selectedAlbum.description}
                                                                        {isAlbumDescOverflowing && (
                                                                            <span className="album-desc-inline-tail">
                                                                                <span className="album-desc-ellipsis">...</span>
                                                                                <button
                                                                                    type="button"
                                                                                    className="album-desc-toggle is-inline"
                                                                                    onClick={handleAlbumDescriptionToggle}
                                                                                    aria-expanded={false}
                                                                                    aria-label="Expand album description"
                                                                                >
                                                                                    MORE
                                                                                </button>
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                ) : (
                                                                    <>
                                                                        <span ref={albumDescTextRef} className="album-desc-text">
                                                                            {selectedAlbum.description}
                                                                        </span>
                                                                        {isAlbumDescOverflowing && (
                                                                            <button
                                                                                type="button"
                                                                                className="album-desc-toggle is-expanded"
                                                                                onClick={handleAlbumDescriptionToggle}
                                                                                aria-expanded={true}
                                                                                aria-label="Collapse album description"
                                                                            >
                                                                                SHOW LESS
                                                                            </button>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        )}
                                                        <div className="album-actions">
                                                            <div className="album-primary-actions">
                                                                <button
                                                                    className="btn-main album-hero-action-btn album-hero-play-btn"
                                                                    onClick={playCurrentAlbumAll}
                                                                    disabled={!selectedAlbum?.tracks?.length}
                                                                    title="Play all tracks from this album"
                                                                >
                                                                    <Icon name="play" size={16} />
                                                                    Play
                                                                </button>
                                                                <button
                                                                    className="btn-main album-hero-action-btn album-hero-download-btn"
                                                                    onClick={downloadFullAlbum}
                                                                    disabled={!!albumProgress || albumIsQueued}
                                                                    title="Download album"
                                                                >
                                                                    <Icon name={albumIsQueued ? "list" : "download"} size={15} />
                                                                    {albumProgress ? `${Math.round(albumProgress.progress)}%` : albumIsQueued ? "Queued" : "Download"}
                                                                </button>
                                                                <button
                                                                    className={`btn-icon-only album-hero-icon-btn album-hero-like-icon-btn${isSelectedAlbumLiked ? ' is-active' : ''}`}
                                                                    onClick={toggleSelectedAlbumLike}
                                                                    disabled={!selectedAlbum?.tracks?.length}
                                                                    aria-label={isSelectedAlbumLiked ? "Unlike album" : "Like album"}
                                                                    aria-pressed={isSelectedAlbumLiked}
                                                                    title={isSelectedAlbumLiked ? "Unlike album" : "Like album"}
                                                                >
                                                                    <Icon name={isSelectedAlbumLiked ? "heartFilled" : "heart"} size={20} />
                                                                </button>
                                                                <button
                                                                    className={`btn-icon-only album-hero-icon-btn album-hero-add-icon-btn${isAlbumPlaylistFeedbackActive ? ' is-feedback' : ''}`}
                                                                    onClick={handleAddCurrentAlbumToPlaylist}
                                                                    disabled={!selectedAlbum?.tracks?.length}
                                                                    title="Add album tracks to playlist"
                                                                    aria-label="Add album tracks to playlist"
                                                                >
                                                                    <Icon name={isAlbumPlaylistFeedbackActive ? "doubleCheck" : "plus"} size={21} />
                                                                </button>
                                                                <button
                                                                    className="btn-icon-only album-hero-icon-btn album-hero-share-icon-btn"
                                                                    onClick={handleShareAlbumLink}
                                                                    disabled={!selectedAlbum?.tracks?.length}
                                                                    title="Share album link"
                                                                    aria-label="Share album link"
                                                                >
                                                                    <Icon name="link" size={20} />
                                                                </button>
                                                                {(albumProgress || albumIsQueued) && albumQueueItemId && (
                                                                    <button
                                                                        className="btn-mini album-hero-cancel-btn"
                                                                        onClick={cancelSelectedAlbumDownload}
                                                                        title="Cancel album download"
                                                                        aria-label="Cancel album download"
                                                                    >
                                                                        <Icon name="close" size={14} />
                                                                    </button>
                                                                )}
                                                            </div>
                                                            <span className="album-track-count">
                                                                {selectedAlbum.tracks.length} Tracks
                                                                {albumDurationText ? ` · ${albumDurationText}` : ''}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="track-filter-bar desktop-only">
                                                    <div className="track-filter-input-wrap">
                                                        <Icon name="search" size={14} />
                                                        <input
                                                            type="text"
                                                            value={trackFilterQuery}
                                                            onChange={(e) => setTrackFilterQuery(e.target.value)}
                                                            placeholder="Search tracks..."
                                                            className="track-filter-input"
                                                        />
                                                    </div>
                                                </div>
                                                <div
                                                    ref={trackListRef}
                                                    className={`track-list medieval-scroll ${shouldVirtualizeTrackList ? 'is-virtualized' : ''}`}
                                                >
                                                    {filteredAlbumTracks.length === 0 ? (
                                                        <div className="track-filter-empty desktop-only">No tracks match this search.</div>
                                                    ) : (
                                                        <div
                                                            className={shouldVirtualizeTrackList ? 'track-list-virtual-window' : undefined}
                                                            style={shouldVirtualizeTrackList
                                                                ? { paddingTop: `${virtualTrackTopPadding}px`, paddingBottom: `${virtualTrackBottomPadding}px` }
                                                                : undefined}
                                                        >
                                                            {(shouldVirtualizeTrackList ? virtualizedFilteredAlbumTracks : filteredAlbumTracks).map(({ track: t, originalIndex: i }: any) => {
                                                                const isCurrent = currentTrack && currentTrack.title === t.title && currentTrack.albumName === selectedAlbum.name;
                                                                return (
                                                                    <div
                                                                        className={shouldVirtualizeTrackList ? 'virtual-track-row' : undefined}
                                                                        data-track-index={i}
                                                                        key={t.url || `${i}-${t.title}`}
                                                                    >
                                                                        <TrackRow
                                                                            t={t}
                                                                            i={i}
                                                                            isCurrent={isCurrent}
                                                                            isPlaying={isPlaying}
                                                                            trackProgress={getTrackDownloadProgress(t)}
                                                                            playTrack={playTrack}
                                                                            addToQueue={addToQueue}
                                                                            addToPlaybackQueue={addTrackToPlaybackQueue}
                                                                            selectedAlbumTracks={selectedAlbum.tracks}
                                                                            isLiked={likedTrackUrlSet.has(String(t?.url || '').trim())}
                                                                            onLike={handleTrackLike}
                                                                            onAddToPlaylist={handleAddTrackToPlaylist}
                                                                            onShareTrack={handleShareTrackLink}
                                                                            isPlaylistRecentlyAdded={trackHasRecentPlaylistAdd(t)}
                                                                            thumbnail={selectedAlbum.imagesThumbs?.[0] || selectedAlbum.albumImages?.[0]}
                                                                            lightweightTitleMode={shouldUseLightweightTrackRows}
                                                                        />
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="album-tracklist-footer">
                                                    {selectedAlbum.dateAdded && (
                                                        <div className="album-tracklist-date">{selectedAlbum.dateAdded} (Added)</div>
                                                    )}
                                                    <div className="album-tracklist-summary">
                                                        <span>{selectedAlbum.tracks.length} songs</span>
                                                        {albumDurationText ? <span className="album-tracklist-duration"> · {albumDurationText}</span> : null}
                                                    </div>
                                                    {selectedAlbum.publisher && (
                                                        <div className="album-tracklist-copyright">(c) {selectedAlbum.publisher}</div>
                                                    )}
                                                    {albumFormatWithSizes.length > 0 && (
                                                        <div className="album-tracklist-meta-inline formats-only">
                                                            <span className="album-tracklist-meta-inline-value">
                                                                {albumFormatWithSizes.join(' · ')}
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                                {albumComments.length > 0 && (
                                                    <>
                                                        <div className="mobile-section-toggle-wrap">
                                                            <button
                                                                type="button"
                                                                className="mobile-section-toggle"
                                                                onClick={() => setIsAlbumCommentsOpenMobile((prev) => !prev)}
                                                                aria-expanded={shouldShowAlbumComments}
                                                                aria-controls="album-comments-section"
                                                            >
                                                                <span>{shouldShowAlbumComments ? 'Hide Comments' : `Show Comments (${albumCommentCountLabel})`}</span>
                                                                <Icon name={shouldShowAlbumComments ? "chevronUp" : "chevronDown"} size={16} />
                                                            </button>
                                                        </div>
                                                        {shouldShowAlbumComments ? (
                                                            <section className="album-comments" id="album-comments-section" aria-label="Album comments">
                                                                <div className="album-comments-head">
                                                                    <h2 className="f-header album-comments-title">Comments</h2>
                                                                    <div className="album-comments-meta">
                                                                        <span>{albumCommentCountLabel}</span>
                                                                        {selectedAlbum.commentsThreadUrl && (
                                                                            <a
                                                                                className="album-comments-thread-link"
                                                                                href={selectedAlbum.commentsThreadUrl}
                                                                                target="_blank"
                                                                                rel="noopener noreferrer"
                                                                            >
                                                                                Open Thread
                                                                            </a>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <div className="album-comments-list">
                                                                    {visibleAlbumComments.map((comment: any, commentIndex: number) => {
                                                                        const username = String(comment?.username || `User ${commentIndex + 1}`).trim() || `User ${commentIndex + 1}`;
                                                                        const postedAt = String(comment?.postedAt || '').trim();
                                                                        const status = String(comment?.status || '').trim();
                                                                        const message = String(comment?.message || '').trim();
                                                                        const avatarUrl = String(comment?.avatarUrl || '').trim();
                                                                        const userUrl = String(comment?.userUrl || '').trim();
                                                                        const avatarInitial = username.charAt(0).toUpperCase() || '?';

                                                                        return (
                                                                            <article className="album-comment-item" key={`${username}-${postedAt}-${commentIndex}`}>
                                                                                <div className="album-comment-avatar-wrap" aria-hidden="true">
                                                                                    {avatarUrl ? (
                                                                                        <img
                                                                                            src={avatarUrl}
                                                                                            alt=""
                                                                                            className="album-comment-avatar"
                                                                                            loading="lazy"
                                                                                            referrerPolicy="no-referrer"
                                                                                        />
                                                                                    ) : (
                                                                                        <span className="album-comment-avatar-fallback">{avatarInitial}</span>
                                                                                    )}
                                                                                </div>
                                                                                <div className="album-comment-main">
                                                                                    <div className="album-comment-top">
                                                                                        {userUrl ? (
                                                                                            <a
                                                                                                className="album-comment-user"
                                                                                                href={userUrl}
                                                                                                target="_blank"
                                                                                                rel="noopener noreferrer"
                                                                                            >
                                                                                                {username}
                                                                                            </a>
                                                                                        ) : (
                                                                                            <span className="album-comment-user">{username}</span>
                                                                                        )}
                                                                                        <div className="album-comment-meta">
                                                                                            {postedAt && (
                                                                                                <span className="album-comment-time">{postedAt}</span>
                                                                                            )}
                                                                                            {status && (
                                                                                                <span className="album-comment-status">{status}</span>
                                                                                            )}
                                                                                        </div>
                                                                                    </div>
                                                                                    <p className="album-comment-message">{message}</p>
                                                                                </div>
                                                                            </article>
                                                                        );
                                                                    })}
                                                                </div>
                                                                {albumComments.length > ALBUM_COMMENTS_COLLAPSED_COUNT && (
                                                                    <div className="album-comments-footer">
                                                                        <button
                                                                            type="button"
                                                                            className="album-comments-more-btn"
                                                                            onClick={() => setIsAllCommentsVisible((prev) => !prev)}
                                                                        >
                                                                            {isAllCommentsVisible
                                                                                ? 'Show Less'
                                                                                : `Show ${hiddenAlbumCommentsCount} More`}
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </section>
                                                        ) : null}
                                                    </>
                                                )}
                                                {selectedAlbum.relatedAlbums && selectedAlbum.relatedAlbums.length > 0 ? (
                                                    <div id="related-albums-section">
                                                        <SimilarAlbums
                                                            albums={selectedAlbum.relatedAlbums}
                                                            onSelect={selectAlbum}
                                                            deferLoading={isAudioLoading}
                                                            pageShowSignal={pageShowSignal}
                                                        />
                                                    </div>
                                                ) : null}
                                            </div>
                                        ) : isAlbumLoading ? (
                                            <LoadingIndicator />
                                        ) : (
                                            <div className="home-feed-view content-inner">
                                                <div className="latest-arrivals-head">
                                                    <div className="latest-arrivals-copy">
                                                        <h1 className={`f-header ${isSearchMode ? 'search-results-title' : 'latest-arrivals-title'}`}>
                                                            {isSearchMode ? 'Search Results' : 'Latest Arrivals'}
                                                        </h1>
                                                        <div className="home-feed-status">
                                                            {isSearchMode
                                                                ? (`For ${activeSearchTerm || 'your query'} · ${((loading && results.length === 0) ? 'Searching albums...' : searchSummaryText)}`)
                                                                : 'Browse latest KHInsider updates'}
                                                        </div>
                                                    </div>
                                                </div>
                                                {isSearchMode && (
                                                    <>
                                                        <div className="mobile-collapse-wrap">
                                                            <button
                                                                type="button"
                                                                className="mobile-collapse-toggle"
                                                                onClick={() => setIsSearchFiltersOpenMobile((prev) => !prev)}
                                                                aria-expanded={shouldShowSearchFilters}
                                                                aria-controls="search-filter-toolbar"
                                                            >
                                                                <span>Filters</span>
                                                                <Icon name={shouldShowSearchFilters ? "chevronUp" : "chevronDown"} size={16} />
                                                            </button>
                                                        </div>
                                                        {shouldShowSearchFilters ? (
                                                            <div className="search-filter-toolbar" id="search-filter-toolbar">
                                                                <label className="search-filter-group">
                                                                    <span className="search-filter-label">Sort</span>
                                                                    <select
                                                                        className="search-filter-select"
                                                                        value={searchFilters.sort || 'relevance'}
                                                                        onChange={(e) => handleSearchFilterChange('sort', e.target.value)}
                                                                        disabled={loading}
                                                                    >
                                                                        {sortFilterOptions.map((option) => (
                                                                            <option key={`sort-${option.value || 'default'}`} value={option.value}>
                                                                                {option.label}
                                                                            </option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                                <label className="search-filter-group">
                                                                    <span className="search-filter-label">Album Type</span>
                                                                    <select
                                                                        className="search-filter-select"
                                                                        value={searchFilters.album_type}
                                                                        onChange={(e) => handleSearchFilterChange('album_type', e.target.value)}
                                                                        disabled={loading}
                                                                    >
                                                                        {albumTypeFilterOptions.map((option) => (
                                                                            <option key={`type-${option.value || 'any'}`} value={option.value}>
                                                                                {option.label}
                                                                            </option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                                <label className="search-filter-group">
                                                                    <span className="search-filter-label">Year</span>
                                                                    <select
                                                                        className="search-filter-select"
                                                                        value={searchFilters.album_year}
                                                                        onChange={(e) => handleSearchFilterChange('album_year', e.target.value)}
                                                                        disabled={loading}
                                                                    >
                                                                        {albumYearFilterOptions.map((option) => (
                                                                            <option key={`year-${option.value || 'any'}`} value={option.value}>
                                                                                {option.label}
                                                                            </option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                                <label className="search-filter-group">
                                                                    <span className="search-filter-label">Platform</span>
                                                                    <select
                                                                        className="search-filter-select"
                                                                        value={searchFilters.album_category}
                                                                        onChange={(e) => handleSearchFilterChange('album_category', e.target.value)}
                                                                        disabled={loading}
                                                                    >
                                                                        {albumCategoryFilterOptions.map((option) => (
                                                                            <option key={`platform-${option.value || 'any'}`} value={option.value}>
                                                                                {option.label}
                                                                            </option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                                <button
                                                                    type="button"
                                                                    className="search-filter-clear"
                                                                    onClick={clearSearchFilters}
                                                                    disabled={loading}
                                                                >
                                                                    Clear Filters
                                                                </button>
                                                            </div>
                                                        ) : null}
                                                    </>
                                                )}
                                                <div ref={homeCardGridRef} className="home-card-grid">
                                                    {isSearchMode ? (
                                                        (loading && results.length === 0) ? (
                                                            <div className="home-feed-loading">
                                                                <LoadingIndicator />
                                                            </div>
                                                        ) : results.length === 0 ? (
                                                            <div className="home-feed-empty">No entries found.</div>
                                                        ) : (
                                                            <>
                                                                {shouldVirtualizeHomeGrid && virtualHomeGridTopPadding > 0 ? (
                                                                    <div
                                                                        className="home-grid-virtual-spacer"
                                                                        aria-hidden="true"
                                                                        style={{ gridColumn: '1 / -1', height: `${virtualHomeGridTopPadding}px` }}
                                                                    />
                                                                ) : null}
                                                                {virtualizedHomeFeedItems.map(({ item, originalIndex }: { item: any; originalIndex: number }) => {
                                                                    const fallbackImage = String(item?.icon || '').trim();
                                                                    const cardImage = getLargeThumbUrl(fallbackImage);
                                                                    return (
                                                                        <HomeAlbumCard
                                                                            key={`search-${originalIndex}-${item?.url || ''}`}
                                                                            title={String(item?.title || 'Unknown Title')}
                                                                            imageUrl={cardImage}
                                                                            artist={String(item?.albumType || '').trim()}
                                                                            metaLine={String(item?.year || '').trim()}
                                                                            lightweightTextMode={shouldUseLightweightHomeCardText}
                                                                            pageShowSignal={pageShowSignal}
                                                                            selectPayload={item}
                                                                            onSelect={handleHomeCardSelect}
                                                                        />
                                                                    );
                                                                })}
                                                                {shouldVirtualizeHomeGrid && virtualHomeGridBottomPadding > 0 ? (
                                                                    <div
                                                                        className="home-grid-virtual-spacer"
                                                                        aria-hidden="true"
                                                                        style={{ gridColumn: '1 / -1', height: `${virtualHomeGridBottomPadding}px` }}
                                                                    />
                                                                ) : null}
                                                            </>
                                                        )
                                                    ) : (
                                                        latestUpdates.length === 0 ? (
                                                            <div className="home-feed-empty">Loading latest releases...</div>
                                                        ) : (
                                                            <>
                                                                {shouldVirtualizeHomeGrid && virtualHomeGridTopPadding > 0 ? (
                                                                    <div
                                                                        className="home-grid-virtual-spacer"
                                                                        aria-hidden="true"
                                                                        style={{ gridColumn: '1 / -1', height: `${virtualHomeGridTopPadding}px` }}
                                                                    />
                                                                ) : null}
                                                                {virtualizedHomeFeedItems.map(({ item, originalIndex }: { item: any; originalIndex: number }) => {
                                                                    const fallbackImage = String(item?.image || '').trim();
                                                                    const cardImage = getLargeThumbUrl(fallbackImage);
                                                                    return (
                                                                        <HomeAlbumCard
                                                                            key={`latest-${originalIndex}-${item?.url || ''}`}
                                                                            title={String(item?.title || 'Unknown Title')}
                                                                            imageUrl={cardImage}
                                                                            artist={String(item?.albumType || '').trim()}
                                                                            metaLine={String(item?.year || '').trim()}
                                                                            lightweightTextMode={shouldUseLightweightHomeCardText}
                                                                            pageShowSignal={pageShowSignal}
                                                                            selectPayload={item}
                                                                            onSelect={handleHomeCardSelect}
                                                                        />
                                                                    );
                                                                })}
                                                                {shouldVirtualizeHomeGrid && virtualHomeGridBottomPadding > 0 ? (
                                                                    <div
                                                                        className="home-grid-virtual-spacer"
                                                                        aria-hidden="true"
                                                                        style={{ gridColumn: '1 / -1', height: `${virtualHomeGridBottomPadding}px` }}
                                                                    />
                                                                ) : null}
                                                            </>
                                                        )
                                                    )}
                                                </div>
                                                {isSearchMode && (
                                                    <div className="search-infinite-footer">
                                                        {isSearchAppending && (
                                                            <div className="search-infinite-status">Loading more albums...</div>
                                                        )}
                                                        {!isSearchAppending && searchPagination.nextResult && (
                                                            <div className="search-infinite-status">Scroll to load more</div>
                                                        )}
                                                        {!searchPagination.nextResult && results.length > 0 && (
                                                            <div className="search-infinite-status">End of results</div>
                                                        )}
                                                        <div ref={searchLoadMoreRef} className="search-load-sentinel" aria-hidden="true" />
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </ViewPanel>
                                )}

                                {view === 'browse' && (
                                    <ViewPanel>
                                        <div className="content-inner">
                                            <TabHeader
                                                title="Browse"
                                                subtitle={`${(browseTotalItems ?? browseItems.length).toLocaleString()} albums · ${browseLabel}`}
                                                density="compact"
                                            />
                                            <div className="browse-view">
                                                <div className="browse-current-strip" aria-live="polite">
                                                    <span className="browse-current-kicker">Now Viewing</span>
                                                    <span className="browse-current-title">{browseLabel}</span>
                                                    {browseLoading ? (
                                                        <span className="browse-current-loading" role="status" aria-label="Refreshing browse results">
                                                            <MedievalSpinner className="spinner-svg small" />
                                                            <span className="browse-current-loading-text">Refreshing</span>
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <div className="mobile-collapse-wrap">
                                                    <button
                                                        type="button"
                                                        className="mobile-collapse-toggle"
                                                        onClick={() => setIsBrowseToolbarOpenMobile((prev) => !prev)}
                                                        aria-expanded={shouldShowBrowseToolbar}
                                                        aria-controls="browse-shortcuts"
                                                    >
                                                        <span>Browse Filters</span>
                                                        <Icon name={shouldShowBrowseToolbar ? "chevronUp" : "chevronDown"} size={16} />
                                                    </button>
                                                </div>
                                                {shouldShowBrowseToolbar ? (
                                                    <section className="browse-toolbar" id="browse-shortcuts" aria-label="Browse shortcuts">
                                                        <div className="browse-group">
                                                            <div className="browse-group-head">
                                                                <div className="browse-group-label">Albums</div>
                                                                <div className="browse-group-hint">Charts and discovery lists</div>
                                                            </div>
                                                            <div className="browse-chip-list browse-chip-list-major">
                                                                {BROWSE_ALBUM_SHORTCUTS.map((option) => {
                                                                    const isActive = browseSection === option.key;
                                                                    return (
                                                                        <button
                                                                            key={`browse-albums-${option.key}`}
                                                                            type="button"
                                                                            className={`browse-chip ${isActive ? 'is-active' : ''}`}
                                                                            onClick={() => openBrowseSection(option.key)}
                                                                        >
                                                                            {option.label}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                        <div className="browse-group">
                                                            <div className="browse-group-head">
                                                                <div className="browse-group-label">By Type</div>
                                                                <div className="browse-group-hint">Filter by release format</div>
                                                            </div>
                                                            <div className="browse-chip-list">
                                                                {BROWSE_TYPE_OPTIONS.map((option) => {
                                                                    const isActive = browseSection === 'type' && browseSlug === option.slug;
                                                                    return (
                                                                        <button
                                                                            key={`browse-type-${option.slug}`}
                                                                            type="button"
                                                                            className={`browse-chip ${isActive ? 'is-active' : ''}`}
                                                                            onClick={() => openBrowseType(option.slug)}
                                                                        >
                                                                            {option.label}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                        <div className="browse-group">
                                                            <div className="browse-group-head">
                                                                <div className="browse-group-label">By Year</div>
                                                                <div className="browse-group-hint">Jump to any release year</div>
                                                            </div>
                                                            <div className="browse-year-row">
                                                                <label className="browse-year-select-label" htmlFor="browse-year-select">
                                                                    Jump
                                                                </label>
                                                                <select
                                                                    id="browse-year-select"
                                                                    className="browse-year-select"
                                                                    value={browseSection === 'year' ? browseSlug : ''}
                                                                    onChange={(event) => {
                                                                        const nextYear = String(event.target.value || '').trim();
                                                                        if (!nextYear) return;
                                                                        openBrowseYear(nextYear);
                                                                    }}
                                                                >
                                                                    <option value="">Select year</option>
                                                                    {browseAllYears.map((year) => (
                                                                        <option key={`browse-year-option-${year}`} value={year}>
                                                                            {year}
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                                <button
                                                                    type="button"
                                                                    className={`browse-chip browse-chip-toggle ${showAllBrowseYears ? 'is-active' : ''}`}
                                                                    onClick={() => setShowAllBrowseYears((prev) => !prev)}
                                                                >
                                                                    {showAllBrowseYears ? 'Show Recent Years' : 'View All Years'}
                                                                </button>
                                                            </div>
                                                            <div className="browse-chip-list browse-chip-list-years">
                                                                {browseVisibleYears.map((year) => {
                                                                    const isActive = browseSection === 'year' && browseSlug === year;
                                                                    return (
                                                                        <button
                                                                            key={`browse-year-${year}`}
                                                                            type="button"
                                                                            className={`browse-chip ${isActive ? 'is-active' : ''}`}
                                                                            onClick={() => openBrowseYear(year)}
                                                                        >
                                                                            {year}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    </section>
                                                ) : null}

                                                {browseLoading ? (
                                                    <div className="home-feed-loading browse-view-loading">
                                                        <LoadingIndicator />
                                                    </div>
                                                ) : (
                                                    <>
                                                        {browseNotice ? (
                                                            <div className="browse-note">{browseNotice}</div>
                                                        ) : null}

                                                        {hasBrowseYearTopSection ? (
                                                            <section className="browse-top-section" aria-label="Top albums">
                                                                <div className="browse-section-title">{browseTopSectionTitle}</div>
                                                                <div className="home-card-grid browse-top-grid">
                                                                    {browseTopItems.map((item) => {
                                                                        const fallbackImage = String(item?.icon || '').trim();
                                                                        const cardImage = getLargeThumbUrl(fallbackImage);
                                                                        return (
                                                                            <HomeAlbumCard
                                                                                key={`browse-top-${item?.id || item?.url || item?.title || ''}`}
                                                                                title={String(item?.title || 'Unknown Title')}
                                                                                imageUrl={cardImage}
                                                                                artist={String(item?.albumType || '').trim()}
                                                                                metaLine={String(item?.year || '').trim()}
                                                                                lightweightTextMode={shouldUseLightweightHomeCardText}
                                                                                pageShowSignal={pageShowSignal}
                                                                                selectPayload={item}
                                                                                onSelect={handleHomeCardSelect}
                                                                            />
                                                                        );
                                                                    })}
                                                                </div>
                                                            </section>
                                                        ) : null}

                                                        {browseMainSectionTitle ? (
                                                            <div className="browse-section-title">{browseMainSectionTitle}</div>
                                                        ) : null}

                                                        <div ref={homeCardGridRef} className="home-card-grid">
                                                            {browseItems.length === 0 ? (
                                                                <div className="home-feed-empty">No albums available in this section.</div>
                                                            ) : (
                                                                <>
                                                                    {shouldVirtualizeHomeGrid && virtualHomeGridTopPadding > 0 ? (
                                                                        <div
                                                                            className="home-grid-virtual-spacer"
                                                                            aria-hidden="true"
                                                                            style={{ gridColumn: '1 / -1', height: `${virtualHomeGridTopPadding}px` }}
                                                                        />
                                                                    ) : null}
                                                                    {virtualizedHomeFeedItems.map(({ item, originalIndex }: { item: any; originalIndex: number }) => {
                                                                        const fallbackImage = String(item?.icon || item?.image || '').trim();
                                                                        const cardImage = getLargeThumbUrl(fallbackImage);
                                                                        return (
                                                                            <HomeAlbumCard
                                                                                key={`browse-${originalIndex}-${item?.url || ''}`}
                                                                                title={String(item?.title || 'Unknown Title')}
                                                                                imageUrl={cardImage}
                                                                                artist={String(item?.albumType || '').trim()}
                                                                                metaLine={String(item?.year || '').trim()}
                                                                                lightweightTextMode={shouldUseLightweightHomeCardText}
                                                                                pageShowSignal={pageShowSignal}
                                                                                selectPayload={item}
                                                                                onSelect={handleHomeCardSelect}
                                                                            />
                                                                        );
                                                                    })}
                                                                    {shouldVirtualizeHomeGrid && virtualHomeGridBottomPadding > 0 ? (
                                                                        <div
                                                                            className="home-grid-virtual-spacer"
                                                                            aria-hidden="true"
                                                                            style={{ gridColumn: '1 / -1', height: `${virtualHomeGridBottomPadding}px` }}
                                                                        />
                                                                    ) : null}
                                                                </>
                                                            )}
                                                        </div>

                                                        <div className="browse-footer">
                                                            <div className="browse-page-status">
                                                                Page {browsePagination.currentPage} of {browsePagination.totalPages}
                                                            </div>
                                                            <div className="browse-page-actions">
                                                                <button
                                                                    type="button"
                                                                    className="btn-main album-hero-action-btn"
                                                                    disabled={!browsePagination.prevPage || browseLoading}
                                                                    onClick={() => browsePagination.prevPage && loadBrowsePage(browsePagination.prevPage)}
                                                                >
                                                                    <Icon name="chevronLeft" size={16} />
                                                                    Prev
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className="btn-main album-hero-action-btn"
                                                                    disabled={!browsePagination.nextPage || browseLoading}
                                                                    onClick={() => browsePagination.nextPage && loadBrowsePage(browsePagination.nextPage)}
                                                                >
                                                                    Next
                                                                    <Icon name="chevronRight" size={16} />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </ViewPanel>
                                )}

                                {view === 'settings' && (
                                    <ViewPanel>
                                        <div className="content-inner">
                                            <TabHeader
                                                title="Settings"
                                                subtitle="Tune app behavior and download defaults"
                                                density="compact"
                                            />
                                            <SettingsView currentQ={qualityPref} onSetQ={updateQuality} />
                                        </div>
                                    </ViewPanel>
                                )}

                                {view === 'queue' && (
                                    <ViewPanel>
                                        <div className="content-inner">
                                            <button
                                                type="button"
                                                className="queue-page-mobile-back mobile-only"
                                                onClick={navigateBackOrHome}
                                                aria-label="Go back"
                                            >
                                                <Icon name="arrowLeft" size={14} />
                                                Back
                                            </button>
                                            <TabHeader
                                                title="Download Queue"
                                                subtitle="Track active, pending, and completed downloads"
                                                density="compact"
                                            />
                                            <QueueView />
                                        </div>
                                    </ViewPanel>
                                )}

                                {view === 'playlists' && (
                                    <ViewPanel>
                                        <PlaylistsView
                                            playlists={playlists}
                                            selectedPlaylistId={selectedPlaylistId}
                                            onSelectPlaylist={(playlistId) => setSelectedPlaylistId(playlistId)}
                                            isIdentifierView={isPlaylistIdentifierPage}
                                            routeIdentifier={playlistRouteIdentifier}
                                            onOpenPlaylistIdentifier={(playlistId) => openPlaylistIdentifierView(playlistId, { historyMode: 'push' })}
                                            onBackToPlaylists={() => navigatePlaylistsHome({ historyMode: 'push' })}
                                            onCreatePlaylist={createPlaylist}
                                            onRenamePlaylist={renamePlaylist}
                                            onDeletePlaylist={deletePlaylist}
                                            onPlayPlaylist={playPlaylist}
                                            onPlayTrackFromPlaylist={playPlaylistTrack}
                                            isSharedIdentifierView={isSharedPlaylistIdentifierPage}
                                            sharedPlaylistStatus={sharedPlaylistStatus}
                                            sharedPlaylistRecord={sharedPlaylistData}
                                            onPlaySharedPlaylist={playSharedPlaylist}
                                            onPlayTrackFromSharedPlaylist={playTrackFromSharedPlaylist}
                                            onImportSharedPlaylist={() => importSharedPlaylist({ historyMode: 'push' })}
                                            onRemoveTrack={removePlaylistTrack}
                                            onMoveTrack={movePlaylistTrack}
                                            onExportPlaylists={exportPlaylists}
                                            onExportPlaylist={exportSinglePlaylist}
                                            onSharePlaylist={createPlaylistShareLink}
                                            onDownloadPlaylistZip={downloadPlaylistAsZip}
                                            onImportPlaylists={() => playlistImportInputRef.current?.click()}
                                            onAddTrackToPlaylist={handleAddTrackToPlaylist}
                                            onShareTrack={handleShareTrackLink}
                                            onDownloadTrack={addToQueue}
                                            onAddTrackToQueue={addTrackToPlaybackQueue}
                                            getTrackDownloadProgress={getTrackDownloadProgress}
                                            trackHasRecentPlaylistAdd={trackHasRecentPlaylistAdd}
                                            onOpenTrackAlbum={openTrackAlbumFromTrack}
                                        />
                                        <input
                                            type="file"
                                            ref={playlistImportInputRef}
                                            style={{ display: 'none' }}
                                            accept=".json"
                                            onChange={importPlaylists}
                                        />
                                        {playlistStorageWarning ? (
                                            <div className="playlists-storage-warning">{playlistStorageWarning}</div>
                                        ) : null}
                                    </ViewPanel>
                                )}

                                {view === 'liked' && (
                                    <div style={{ height: '100%' }}>
                                        <div className="content-inner">
                                            <TabHeader
                                                title="Liked Songs"
                                                subtitle={`${likedTracks.length} Saved Tracks - Stored Locally`}
                                                actions={(
                                                    <div className="btn-action-group">
                                                        <button className="btn-main album-hero-action-btn album-hero-pill-btn" onClick={exportLikes}>
                                                            <Icon name="download" size={16} /> Export Likes
                                                        </button>
                                                        <button className="btn-main album-hero-action-btn album-hero-pill-btn" onClick={() => fileInputRef.current?.click()}>
                                                            <Icon name="upload" size={16} /> Import Likes
                                                        </button>
                                                        <input
                                                            type="file"
                                                            ref={fileInputRef}
                                                            style={{ display: 'none' }}
                                                            accept=".json"
                                                            onChange={importLikes}
                                                        />
                                                    </div>
                                                )}
                                            />
                                            <div className="liked-list">
                                                {likedTracks.length === 0 ? (
                                                    <div className="empty-state">
                                                        <Icon name="heart" size={48} />
                                                        <p style={{ marginTop: '1rem', fontFamily: 'Mate SC' }}>No liked songs yet.</p>
                                                    </div>
                                                ) : (
                                                    likedRows.map((row, rowIdx) => {
                                                        const expandedIndex = row.findIndex((group) => getLikedGroupKey(group) === likedExpandedKey);
                                                        const expandedGroup = expandedIndex !== -1 ? row[expandedIndex] : null;
                                                        const expandedMetaCacheKey = expandedGroup ? getLikedMetaCacheKey(expandedGroup) : null;
                                                        const expandedMeta = expandedMetaCacheKey ? likedAlbumMetaCache[expandedMetaCacheKey] : null;
                                                        const expandedLoading = expandedMetaCacheKey ? !!likedAlbumMetaLoading[expandedMetaCacheKey] : false;
                                                        const expandedMetaError = expandedMetaCacheKey ? likedAlbumMetaError[expandedMetaCacheKey] : '';
                                                        const expandedAlbumCandidates = expandedGroup ? getLikedGroupAlbumFetchCandidates(expandedGroup) : [];
                                                        const expandedOpenAlbumUrl = expandedAlbumCandidates[0] || '';
                                                        const arrowLeft = expandedIndex === -1
                                                            ? '50%'
                                                            : `${((expandedIndex + 0.5) / likedGridColumns) * 100}%`;
                                                        const expandedArtist =
                                                            expandedMeta?.primaryArtist ||
                                                            expandedMeta?.albumArtist ||
                                                            expandedMeta?.composers ||
                                                            expandedMeta?.developers ||
                                                            expandedMeta?.publisher ||
                                                            (expandedGroup ? getLikedArtistFallback(expandedGroup) : 'Unknown Artist');
                                                        const expandedTypeYear = [expandedMeta?.albumType, expandedMeta?.year]
                                                            .filter(Boolean)
                                                            .map((part) => String(part))
                                                            .join(' · ');

                                                        return (
                                                            <React.Fragment key={`liked-row-${rowIdx}`}>
                                                                <div
                                                                    className="liked-album-grid-row"
                                                                    style={{ gridTemplateColumns: `repeat(${likedGridColumns}, minmax(0, 1fr))` }}
                                                                >
                                                                    {row.map((group) => {
                                                                        const groupKey = getLikedGroupKey(group);
                                                                        const isOpen = groupKey === likedExpandedKey;
                                                                        return (
                                                                            <button
                                                                                key={groupKey}
                                                                                type="button"
                                                                                className={`liked-album-card ${isOpen ? 'is-open' : ''}`}
                                                                                onClick={() => setLikedExpandedKey((prev) => (prev === groupKey ? null : groupKey))}
                                                                            >
                                                                                <div className="liked-album-card-art">
                                                                                    {group.albumArt ? (
                                                                                        <img
                                                                                            src={group.albumArt}
                                                                                            referrerPolicy="no-referrer"
                                                                                            loading="lazy"
                                                                                            fetchPriority="low"
                                                                                            alt=""
                                                                                            onError={(e: any) => {
                                                                                                e.target.style.display = 'none';
                                                                                            }}
                                                                                        />
                                                                                    ) : (
                                                                                        <div className="liked-album-card-art-fallback">
                                                                                            <Icon name="headphones" size={26} />
                                                                                        </div>
                                                                                    )}
                                                                                    <span
                                                                                        className="liked-album-card-play"
                                                                                        title="Play all tracks from this album"
                                                                                        aria-label={`Play all tracks from ${group.albumName}`}
                                                                                        onClick={(e) => {
                                                                                            e.preventDefault();
                                                                                            e.stopPropagation();
                                                                                            playLikedAlbumAll(group);
                                                                                        }}
                                                                                    >
                                                                                        <Icon name="play" size={14} />
                                                                                    </span>
                                                                                </div>
                                                                                <div className="liked-album-card-copy">
                                                                                    <div className="liked-album-card-title">{group.albumName}</div>
                                                                                    <div className="liked-album-card-sub">{group.tracks.length} tracks</div>
                                                                                </div>
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>

                                                                {expandedGroup && (
                                                                    <div className="liked-expand-panel" style={{ ['--liked-arrow-left' as any]: arrowLeft }}>
                                                                        <div className="liked-expand-arrow" aria-hidden="true"></div>
                                                                        <div className="liked-expand-shell">
                                                                            <div className="liked-expand-cover">
                                                                                {expandedGroup.albumArt ? (
                                                                                    <img
                                                                                        src={expandedGroup.albumArt}
                                                                                        referrerPolicy="no-referrer"
                                                                                        loading="lazy"
                                                                                        fetchPriority="low"
                                                                                        alt=""
                                                                                        onError={(e: any) => {
                                                                                            e.target.style.display = 'none';
                                                                                        }}
                                                                                    />
                                                                                ) : (
                                                                                    <div className="liked-expand-cover-fallback">
                                                                                        <Icon name="headphones" size={32} />
                                                                                    </div>
                                                                                )}
                                                                            </div>

                                                                            <div className="liked-expand-divider"></div>

                                                                            <div className="liked-expand-content">
                                                                                <div className="liked-expand-header">
                                                                                    <div className="liked-expand-title-row">
                                                                                        <h2 className="liked-expand-title">{expandedMeta?.name || expandedGroup.albumName}</h2>
                                                                                        {expandedOpenAlbumUrl && (
                                                                                            <button
                                                                                                type="button"
                                                                                                className="liked-open-album-btn"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    handleAlbumClick(
                                                                                                        expandedOpenAlbumUrl,
                                                                                                        expandedAlbumCandidates,
                                                                                                        expandedGroup.albumName,
                                                                                                        expandedMeta?.albumId || expandedGroup.albumId || ''
                                                                                                    );
                                                                                                }}
                                                                                            >
                                                                                                Open Album
                                                                                            </button>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className="liked-expand-artist">{expandedArtist}</div>
                                                                                    <div className="liked-expand-meta">
                                                                                        {expandedLoading
                                                                                            ? 'Loading album details...'
                                                                                            : (expandedTypeYear || (expandedMetaError ? 'Metadata unavailable' : `${expandedGroup.tracks.length} tracks`))}
                                                                                    </div>
                                                                                </div>

                                                                                <div
                                                                                    className={`liked-expand-tracklist ${shouldVirtualizeLikedExpand ? 'is-virtualized' : ''}`}
                                                                                    ref={likedExpandTracklistRef}
                                                                                >
                                                                                    {shouldVirtualizeLikedExpand && likedExpandVirtualTopPadding > 0 ? (
                                                                                        <div
                                                                                            className="liked-expand-virtual-spacer"
                                                                                            aria-hidden="true"
                                                                                            style={{ height: `${likedExpandVirtualTopPadding}px` }}
                                                                                        />
                                                                                    ) : null}
                                                                                    {(shouldVirtualizeLikedExpand
                                                                                        ? visibleExpandedLikedTracks
                                                                                        : expandedGroup.tracks.map((track: any, originalIndex: number) => ({ track, originalIndex }))
                                                                                    ).map(({ track: t, originalIndex }: { track: any; originalIndex: number }) => {
                                                                                        const isCurrent =
                                                                                            !!currentTrack && (
                                                                                                (currentTrack.url && t.url && currentTrack.url === t.url) ||
                                                                                                (currentTrack.title === t.title && currentTrack.albumName === expandedGroup.albumName)
                                                                                            );
                                                                                        const trackDownloadProgress = getTrackDownloadProgress(t);
                                                                                        const isPlaylistAdded = trackHasRecentPlaylistAdd(t);
                                                                                        return (
                                                                                            <div
                                                                                                key={t.url || `${originalIndex}-${t.title}`}
                                                                                                className={`liked-expand-track-row ${isCurrent ? 'is-current' : ''}`}
                                                                                                onClick={() => {
                                                                                                    const playbackTracks = prepareLikedTracksForPlayback(expandedGroup);
                                                                                                    const nextTrack =
                                                                                                        playbackTracks.find((pt: any) => pt.url && pt.url === t.url) ||
                                                                                                        playbackTracks[originalIndex] ||
                                                                                                        normalizeLikedTrack(t);
                                                                                                    playTrack(nextTrack, playbackTracks);
                                                                                                }}
                                                                                            >
                                                                                                {trackDownloadProgress !== undefined && (
                                                                                                    <div className="track-progress-fill" style={{ width: `${trackDownloadProgress}%` }} />
                                                                                                )}
                                                                                                <div className="liked-expand-track-num">
                                                                                                    {isCurrent && isPlaying ? (
                                                                                                        <span className="liked-track-eq now-playing-bars playing" aria-hidden="true">
                                                                                                            <span></span>
                                                                                                            <span></span>
                                                                                                            <span></span>
                                                                                                        </span>
                                                                                                    ) : (
                                                                                                        t.number || originalIndex + 1
                                                                                                    )}
                                                                                                </div>
                                                                                                <div className="liked-expand-track-text">
                                                                                                    <div className="liked-expand-track-title">{t.title}</div>
                                                                                                    <div className="liked-expand-track-sub">{expandedArtist}</div>
                                                                                                </div>
                                                                                                <div className="liked-expand-track-dur">{t.duration || '--:--'}</div>
                                                                                                <div className="t-act liked-expand-track-actions">
                                                                                                    <button
                                                                                                        type="button"
                                                                                                        className={`btn-mini btn-playlist ${isPlaylistAdded ? 'is-feedback' : ''}`}
                                                                                                        onClick={(event) => {
                                                                                                            event.preventDefault();
                                                                                                            event.stopPropagation();
                                                                                                            handleAddTrackToPlaylist(t);
                                                                                                        }}
                                                                                                        title={isPlaylistAdded ? "Added to Playlist" : "Add to Playlist"}
                                                                                                        aria-label={isPlaylistAdded ? "Added to playlist" : "Add to playlist"}
                                                                                                    >
                                                                                                        <Icon name={isPlaylistAdded ? "doubleCheck" : "plus"} size={15} />
                                                                                                    </button>
                                                                                                    <button
                                                                                                        type="button"
                                                                                                        className="btn-mini btn-share"
                                                                                                        onClick={(event) => {
                                                                                                            event.preventDefault();
                                                                                                            event.stopPropagation();
                                                                                                            handleShareTrackLink(t);
                                                                                                        }}
                                                                                                        title="Share track link"
                                                                                                        aria-label="Share track link"
                                                                                                    >
                                                                                                        <Icon name="link" size={14} />
                                                                                                    </button>
                                                                                                    <button
                                                                                                        type="button"
                                                                                                        className="btn-mini btn-queue"
                                                                                                        onClick={(event) => {
                                                                                                            event.preventDefault();
                                                                                                            event.stopPropagation();
                                                                                                            addTrackToPlaybackQueue(t);
                                                                                                        }}
                                                                                                        title="Add to Manual Queue"
                                                                                                        aria-label="Add to manual queue"
                                                                                                    >
                                                                                                        <Icon name="list" size={14} />
                                                                                                    </button>
                                                                                                    <button
                                                                                                        type="button"
                                                                                                        className="btn-mini btn-download"
                                                                                                        onClick={(event) => {
                                                                                                            event.preventDefault();
                                                                                                            event.stopPropagation();
                                                                                                            addToQueue(t);
                                                                                                        }}
                                                                                                        title="Download Track"
                                                                                                        aria-label="Download track"
                                                                                                    >
                                                                                                        <Icon name="download" size={14} />
                                                                                                    </button>
                                                                                                </div>
                                                                                            </div>
                                                                                        );
                                                                                    })}
                                                                                    {shouldVirtualizeLikedExpand && likedExpandVirtualBottomPadding > 0 ? (
                                                                                        <div
                                                                                            className="liked-expand-virtual-spacer"
                                                                                            aria-hidden="true"
                                                                                            style={{ height: `${likedExpandVirtualBottomPadding}px` }}
                                                                                        />
                                                                                    ) : null}
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </React.Fragment>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                <Player
                    track={currentTrack}
                    isPlaying={isPlaying}
                    duration={audioDuration}
                    onPlayPause={togglePlayPause}
                    onToggleMode={cyclePlayerMode}
                    mode={playerMode}
                    volume={volume}
                    onVolumeChange={handleVolumeChange}
                    playbackRate={playbackRate}
                    onPlaybackRateChange={handlePlaybackRateChange}
                    onNext={playNext}
                    onPrev={playPrev}
                    albumArt={currentTrack?.albumArt}
                    thumbnail={currentTrack?.thumbnail}
                    albumTitle={currentTrack?.albumName}
                    onClose={handleClosePlayer}
                    isLoading={isAudioLoading}
                    onDownload={() => currentTrack && addToQueue(currentTrack)}
                    onAlbumClick={() => {
                        if (!currentTrack) return;
                        const openUrl = currentTrack.albumUrl || currentTrack.albumId || '';
                        if (!openUrl) return;
                        handleAlbumClick(
                            openUrl,
                            [],
                            currentTrack?.albumName || 'Unknown',
                            currentTrack?.albumId || ''
                        );
                    }}
                    isRepeatEnabled={isRepeatEnabled}
                    onToggleRepeat={toggleRepeatMode}
                    onShareTrack={currentTrack ? () => { void handleShareTrackLink(currentTrack); } : undefined}
                    onAddToPlaylist={currentTrack ? () => handleAddTrackToPlaylist(currentTrack) : undefined}
                    isPlaylistRecentlyAdded={currentTrack ? trackHasRecentPlaylistAdd(currentTrack) : false}
                    audioRef={audioRef}
                    isMobileFullScreen={isMobileFullScreen}
                    setMobileFullScreen={setMobileFullScreen}
                    isLiked={currentTrack ? isLiked(currentTrack.url) : false}
                    onLike={currentTrack ? () => toggleLike(currentTrack) : undefined}
                    onToggleQueue={handlePlayerQueueAction}
                />
                <GalleryPortalHost
                    ref={galleryHostRef}
                    onVisibilityApplied={handleGalleryVisibilityApplied}
                    onFirstImageLoaded={handleGalleryFirstImageLoaded}
                />
            </div>
        </>
    );
}


