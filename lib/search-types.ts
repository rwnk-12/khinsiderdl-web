export type SearchResultAlbum = {
    title: string | null;
    id: string;
    icon: string | null;
    url: string;
    albumId: string | null;
    albumType: string | null;
    year: string | null;
};

export type SearchFilters = {
    q: string;
    sort: string;
    album_type: string;
    album_year: string;
    album_category: string;
    result: string;
};

export type SearchFilterOption = {
    value: string;
    label: string;
};

export type SearchFilterOptions = {
    sort: SearchFilterOption[];
    albumType: SearchFilterOption[];
    albumYear: SearchFilterOption[];
    albumCategory: SearchFilterOption[];
};

export type SearchPagination = {
    currentPage: number;
    totalPages: number;
    prevResult: string | null;
    nextResult: string | null;
};

export type SearchAlbumsResponse = {
    items: SearchResultAlbum[];
    applied: SearchFilters;
    filterOptions: SearchFilterOptions;
    pagination: SearchPagination;
    totalMatches: number | null;
    sourceUrl: string;
};
