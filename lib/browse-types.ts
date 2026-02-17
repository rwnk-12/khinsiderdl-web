export type BrowseSectionKey =
    | 'browse_all'
    | 'top40'
    | 'top1000_all_time'
    | 'top100_last_6_months'
    | 'top100_newly_added'
    | 'currently_viewed'
    | 'most_favorites'
    | 'requests'
    | 'type'
    | 'year'
    | 'random_album'
    | 'random_album_advanced'
    | 'random_song';

export type BrowseAlbumItem = {
    title: string;
    id: string;
    icon: string | null;
    url: string;
    albumId: string | null;
    albumType: string | null;
    year: string | null;
};

export type BrowsePagination = {
    currentPage: number;
    totalPages: number;
    prevPage: number | null;
    nextPage: number | null;
};

export type BrowseAction =
    | {
        kind: 'open_album';
        section: BrowseSectionKey;
        label: string;
        albumUrl: string;
        albumId: string | null;
        sourceUrl: string;
    }
    | {
        kind: 'open_track';
        section: BrowseSectionKey;
        label: string;
        albumUrl: string;
        albumId: string | null;
        trackUrl: string;
        trackToken: string;
        sourceUrl: string;
    }
    | {
        kind: 'open_external';
        section: BrowseSectionKey;
        label: string;
        externalUrl: string;
        sourceUrl: string;
        message?: string;
    };

export type BrowseResponse = {
    section: BrowseSectionKey;
    sectionLabel: string;
    slug: string;
    page: number;
    sourceUrl: string;
    items: BrowseAlbumItem[];
    totalItems?: number | null;
    topItems?: BrowseAlbumItem[];
    topItemsLabel?: string | null;
    pagination: BrowsePagination;
    notice?: string;
    requiresLogin?: boolean;
    action?: BrowseAction;
};
