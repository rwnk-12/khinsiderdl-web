import type { AlbumMeta, AudioQualityPreference, DownloadManagerState, QueueItem, QueueItemStatus, Track } from './app-types';
import { readQualityPreference, writeQualityPreference } from './client-storage';
import { LruCache } from './lru-cache';

type ResolveResponse = Record<string, string>;

type DownloadWorkerProgressMessage = {
    id: string;
    status: 'progress';
    progress: number;
    text?: string;
    trackProgressMap?: Record<string, number>;
};

type DownloadWorkerCompleteMessage = {
    id: string;
    status: 'complete';
    blob: Blob;
    fileName: string;
};

type DownloadWorkerErrorMessage = {
    id: string;
    status: 'error';
    error?: string;
};

type DownloadWorkerMessage = DownloadWorkerProgressMessage | DownloadWorkerCompleteMessage | DownloadWorkerErrorMessage;

type DownloadManagerEvents = {
    update: DownloadManagerState;
    itemUpdate: QueueItem;
};

class EventBus {
    private listeners: Record<keyof DownloadManagerEvents, Array<(payload: unknown) => void>> = {
        update: [],
        itemUpdate: [],
    };

    on<K extends keyof DownloadManagerEvents>(event: K, callback: (payload: DownloadManagerEvents[K]) => void) {
        this.listeners[event].push(callback as (payload: unknown) => void);
    }

    off<K extends keyof DownloadManagerEvents>(event: K, callback: (payload: DownloadManagerEvents[K]) => void) {
        this.listeners[event] = this.listeners[event].filter((cb) => cb !== (callback as (payload: unknown) => void));
    }

    protected emit<K extends keyof DownloadManagerEvents>(event: K, payload: DownloadManagerEvents[K]) {
        this.listeners[event].forEach((cb) => cb(payload));
    }
}

const createQueueId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const toSafeTrack = (value: unknown): Track => {
    if (!value || typeof value !== 'object') return {};
    return value as Track;
};

const toSafeAlbumMeta = (value: unknown): AlbumMeta => {
    if (!value || typeof value !== 'object') return {};
    return value as AlbumMeta;
};

const getFallbackAlbumName = (track: Track, meta: AlbumMeta) => {
    return String(track.albumName || track.album || meta.name || 'Unknown Album');
};

const toStatusText = (raw: unknown, fallback: string) => {
    const value = String(raw || '').trim();
    return value || fallback;
};

const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 80;

export class DownloadManager extends EventBus {
    queue: QueueItem[] = [];
    active: QueueItem[] = [];
    completed: QueueItem[] = [];
    errors: QueueItem[] = [];
    concurrency = 1;
    qualityPref: AudioQualityPreference = 'best';
    resolveCache = new LruCache<string, ResolveResponse>(400);
    worker: Worker | null = null;
    lastEmit = 0;

    constructor() {
        super();
        if (typeof window !== 'undefined') {
            this.worker = new Worker('/worker.js');
            this.worker.onmessage = (event: MessageEvent<DownloadWorkerMessage>) => this.handleMessage(event);
        }
    }

    initializeQuality() {
        if (typeof window === 'undefined') return;
        this.qualityPref = readQualityPreference(window.localStorage, 'best');
    }

    setQuality(nextQuality: AudioQualityPreference) {
        this.qualityPref = nextQuality;
        if (typeof window !== 'undefined') {
            writeQualityPreference(window.localStorage, nextQuality);
        }
    }

    async resolveTrackFormats(url: string, signal?: AbortSignal) {
        const normalizedUrl = String(url || '').trim();
        if (!normalizedUrl) {
            throw new Error('Resolve failed: missing URL');
        }
        const cached = this.resolveCache.get(normalizedUrl);
        if (cached) {
            return cached;
        }
        const response = await fetch(`/api/resolve?url=${encodeURIComponent(normalizedUrl)}`, signal ? { signal } : undefined);
        if (!response.ok) throw new Error(`Resolve failed: ${response.status}`);
        const data = (await response.json()) as ResolveResponse;
        this.resolveCache.set(normalizedUrl, data);
        return data;
    }

    pickDirectUrl(formats: ResolveResponse) {
        const pref = this.qualityPref || 'best';
        const pick = (key: string) => formats?.[key] || null;
        if (pref === 'flac') return pick('flac');
        if (pref === 'mp3') return pick('mp3');
        if (pref === 'm4a') return pick('m4a') || pick('aac');
        return pick('flac') || pick('m4a') || pick('mp3') || pick('ogg') || formats?.directUrl || null;
    }

    addTrackToQueue(track: unknown, meta: unknown) {
        const safeTrack = toSafeTrack(track);
        const safeMeta = toSafeAlbumMeta(meta);

        const normalizedMeta: AlbumMeta = {
            ...safeMeta,
            name: String(safeMeta.name || getFallbackAlbumName(safeTrack, safeMeta)),
            tracks: Array.isArray(safeMeta.tracks) && safeMeta.tracks.length > 0 ? safeMeta.tracks : [safeTrack],
            albumImages: Array.isArray(safeMeta.albumImages) ? safeMeta.albumImages : [],
        };

        const item: QueueItem = {
            id: createQueueId(),
            type: 'track',
            track: safeTrack,
            meta: normalizedMeta,
            status: 'pending',
            progress: 0,
            statusText: 'Waiting...',
            addedAt: Date.now(),
            qualityPref: this.qualityPref,
        };

        this.queue.push(item);
        this.emit('update', this.getState());
        this.processQueue();
    }

    addAlbumToQueue(meta: unknown) {
        const safeMeta = toSafeAlbumMeta(meta);
        const safeTracks = Array.isArray(safeMeta.tracks) ? safeMeta.tracks : [];

        const normalizedMeta: AlbumMeta = {
            ...safeMeta,
            name: String(safeMeta.name || 'Unknown Album'),
            tracks: safeTracks,
            albumImages: Array.isArray(safeMeta.albumImages) ? safeMeta.albumImages : [],
        };

        const item: QueueItem = {
            id: createQueueId(),
            type: 'album',
            meta: normalizedMeta,
            tracks: safeTracks,
            status: 'pending',
            progress: 0,
            statusText: 'Waiting...',
            addedAt: Date.now(),
            trackProgressMap: {},
            currentTrackIndex: -1,
            qualityPref: this.qualityPref,
        };

        this.queue.push(item);
        this.emit('update', this.getState());
        this.processQueue();
    }

    cancel(id: string) {
        const queueIndex = this.queue.findIndex((item) => item.id === id);
        if (queueIndex > -1) {
            this.queue.splice(queueIndex, 1);
            this.emit('update', this.getState());
            return;
        }

        const activeExists = this.active.some((item) => item.id === id);
        if (!activeExists) return;

        this.active = this.active.filter((item) => item.id !== id);
        this.emit('update', this.getState());
        this.processQueue();
    }

    processQueue() {
        if (this.active.length >= this.concurrency || this.queue.length === 0) return;
        const nextItem = this.queue.shift();
        if (!nextItem) return;

        nextItem.status = 'downloading';
        this.active.push(nextItem);
        this.emit('update', this.getState());
        this.worker?.postMessage(nextItem);
    }

    handleMessage(event: MessageEvent<DownloadWorkerMessage>) {
        const payload = event.data;
        const activeItem = this.active.find((item) => item.id === payload.id);
        if (!activeItem) return;

        if (payload.status === 'progress') {
            activeItem.progress = Number(payload.progress || 0);
            activeItem.statusText = toStatusText(payload.text, 'Working...');
            if (payload.trackProgressMap) {
                activeItem.trackProgressMap = payload.trackProgressMap;
            }

            const now = Date.now();
            if (now - this.lastEmit > DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
                this.emit('itemUpdate', activeItem);
                this.lastEmit = now;
            }
            return;
        }

        this.active = this.active.filter((item) => item.id !== payload.id);

        if (payload.status === 'complete') {
            activeItem.status = 'completed';
            activeItem.progress = 100;
            activeItem.statusText = 'Completed';
            this.completed.unshift(activeItem);
            if (this.completed.length > 50) {
                this.completed.pop();
            }
            this.emit('update', this.getState());

            const objectUrl = URL.createObjectURL(payload.blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = payload.fileName;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            this.processQueue();
            return;
        }

        activeItem.status = 'error' as QueueItemStatus;
        activeItem.error = toStatusText(payload.error, 'Download failed');
        this.errors.unshift(activeItem);
        this.emit('update', this.getState());
        this.processQueue();
    }

    getState(): DownloadManagerState {
        return {
            queue: [...this.queue],
            active: [...this.active],
            completed: [...this.completed],
            errors: [...this.errors],
        };
    }

    retry(id: string) {
        const errorIndex = this.errors.findIndex((item) => item.id === id);
        if (errorIndex < 0) return;

        const item = this.errors.splice(errorIndex, 1)[0];
        if (!item) return;
        item.status = 'pending';
        item.progress = 0;
        item.error = null;
        item.statusText = 'Waiting...';
        this.queue.push(item);
        this.emit('update', this.getState());
        this.processQueue();
    }

    clearCompleted() {
        this.completed = [];
        this.errors = [];
        this.emit('update', this.getState());
    }

    getCacheStats() {
        return {
            resolveCacheSize: this.resolveCache.size,
        };
    }
}

export const dlManager = new DownloadManager();
