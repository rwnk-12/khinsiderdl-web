export type AudioQualityPreference = 'best' | 'flac' | 'm4a' | 'mp3';

export type Track = {
    trackKey?: string;
    url?: string;
    title?: string;
    number?: number | string;
    duration?: string;
    bitrate?: string;
    fileSize?: string;
    albumName?: string;
    album?: string;
    albumUrl?: string;
    albumId?: string;
    albumArt?: string;
    thumbnail?: string;
    likedAt?: number;
    addedAt?: number;
    queueSource?: string;
};

export type AlbumMeta = {
    name?: string;
    tracks?: Track[];
    albumImages?: string[];
    [key: string]: unknown;
};

export type QueueItemStatus = 'pending' | 'downloading' | 'completed' | 'error';
export type QueueItemType = 'track' | 'album';

export type QueueItem = {
    id: string;
    type: QueueItemType;
    status: QueueItemStatus;
    progress: number;
    statusText: string;
    addedAt: number;
    qualityPref: AudioQualityPreference;
    track?: Track;
    tracks?: Track[];
    meta?: AlbumMeta;
    error?: string | null;
    trackProgressMap?: Record<string, number>;
    currentTrackIndex?: number;
};

export type DownloadManagerState = {
    queue: QueueItem[];
    active: QueueItem[];
    completed: QueueItem[];
    errors: QueueItem[];
};

export type LikedTrack = Track & {
    likedAt: number;
};
