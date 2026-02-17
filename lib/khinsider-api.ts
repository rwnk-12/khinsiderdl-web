import type { SearchAlbumsResponse, SearchFilters } from './search-types';
import { isTimeoutLikeError } from './utils';
import type { SharedPlaylistRecordV1, SharedPlaylistSnapshot } from './playlist-share';
import { normalizeSharedPlaylistRecord } from './playlist-share';
import type { BrowseResponse, BrowseSectionKey } from './browse-types';
import { LruCache } from './lru-cache';

export class KhinsiderAPI {
    private readonly albumCache = new LruCache<string, any>(180);

    private extractAlbumPath(input: string) {
        const raw = (input || '').trim();
        if (!raw) return '';

        let path = raw;
        if (/^https?:\/\//i.test(raw)) {
            try {
                path = new URL(raw).pathname;
            } catch {
                path = raw;
            }
        }
        const match = path.match(/(\/game-soundtracks\/album\/[^/?#]+)/i);
        if (!match?.[1]) return '';
        return match[1].replace(/[/?]+$/, '').toLowerCase();
    }

    private extractShortAlbumPath(input: string) {
        const raw = (input || '').trim();
        if (!raw) return '';

        let path = raw;
        if (/^https?:\/\//i.test(raw)) {
            try {
                path = new URL(raw).pathname;
            } catch {
                path = raw;
            }
        }

        const shortMatch = path.match(/\/album\/([^/?#]+)/i);
        if (!shortMatch?.[1]) return '';
        return `/game-soundtracks/album/${shortMatch[1]}`.replace(/[/?]+$/, '').toLowerCase();
    }

    private normalizeAlbumUrl(input: string) {
        const raw = (input || '').trim();
        if (!raw) return raw;
        const albumPath = this.extractAlbumPath(raw);
        if (albumPath) return `https://downloads.khinsider.com${albumPath}`;
        const shortAlbumPath = this.extractShortAlbumPath(raw);
        if (shortAlbumPath) return `https://downloads.khinsider.com${shortAlbumPath}`;
        if (/^https?:\/\//i.test(raw)) return raw;
        const path = raw.startsWith('/') ? raw : `/${raw}`;
        return `https://downloads.khinsider.com${path}`;
    }

    async searchAlbums(params: Partial<SearchFilters> & { q: string }): Promise<SearchAlbumsResponse> {
        const term = String(params?.q || '').trim();
        if (!term) {
            throw new Error("Search Failed: empty query");
        }

        const query = new URLSearchParams();
        query.set('q', term);

        const sort = String(params?.sort || '').trim();
        if (sort) query.set('sort', sort);

        const albumType = String(params?.album_type || '').trim();
        if (albumType) query.set('album_type', albumType);

        const albumYear = String(params?.album_year || '').trim();
        if (albumYear) query.set('album_year', albumYear);

        const albumCategory = String(params?.album_category || '').trim();
        if (albumCategory) query.set('album_category', albumCategory);

        const result = String(params?.result || '').trim();
        if (result) query.set('result', result);

        const res = await fetch(`/api/search?${query.toString()}`);
        if (!res.ok) throw new Error("Search Failed");
        return await res.json();
    }

    async search(query: string) {
        const payload = await this.searchAlbums({ q: query });
        return payload.items;
    }

    async getAlbum(url: string, signal: AbortSignal) {
        const normalizedUrl = this.normalizeAlbumUrl(url);
        const cached = this.albumCache.get(normalizedUrl);
        if (cached) {
            return cached;
        }

        let res: Response;
        try {
            res = await fetch(`/api/album?url=${encodeURIComponent(normalizedUrl)}`, { signal });
        } catch (error) {
            if (isTimeoutLikeError(error)) {
                throw new Error('Metadata request timed out. Please retry.');
            }
            throw error;
        }
        if (!res.ok) {
            let reason = `HTTP ${res.status}`;
            try {
                const payload = await res.json();
                reason = payload?.error || reason;
            } catch {
            }
            throw new Error(`Metadata Failed: ${reason}`);
        }
        const data = await res.json();
        this.albumCache.set(normalizedUrl, data);
        return data;
    }

    getCacheStats() {
        return {
            albumCacheSize: this.albumCache.size,
        };
    }

    async createPlaylistShare(
        snapshot: SharedPlaylistSnapshot,
        options?: { reuseShareId?: string }
    ): Promise<{ mode: 'server'; url: string; shareId: string; reused: boolean; contentHash?: string }> {
        const reuseShareId = String(options?.reuseShareId || '').trim();
        const res = await fetch('/api/playlist-share', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                playlist: snapshot,
                ...(reuseShareId ? { reuseShareId } : {}),
            }),
        });

        let payload: any = null;
        try {
            payload = await res.json();
        } catch {
            payload = null;
        }

        if (!res.ok) {
            const reason = String(payload?.error || `HTTP ${res.status}`).trim();
            throw new Error(`Share Failed: ${reason}`);
        }

        const mode = String(payload?.mode || '').trim();
        const url = String(payload?.url || '').trim();
        const shareId = String(payload?.shareId || '').trim();
        if (mode !== 'server' || !url || !shareId) {
            throw new Error('Share Failed: invalid server response.');
        }

        const contentHash = String(payload?.contentHash || '').trim();
        return {
            mode: 'server',
            url,
            shareId,
            reused: Boolean(payload?.reused),
            ...(contentHash ? { contentHash } : {}),
        };
    }

    async revokePlaylistShare(shareId: string, editToken: string): Promise<boolean> {
        const normalizedShareId = String(shareId || '').trim();
        const normalizedEditToken = String(editToken || '').trim();
        if (!normalizedShareId || !normalizedEditToken) {
            throw new Error('shareId and editToken are required.');
        }

        const res = await fetch('/api/playlist-share/revoke', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                shareId: normalizedShareId,
                editToken: normalizedEditToken,
            }),
        });

        let payload: any = null;
        try {
            payload = await res.json();
        } catch {
            payload = null;
        }

        if (!res.ok) {
            const reason = String(payload?.error || `HTTP ${res.status}`).trim();
            throw new Error(`Share Revoke Failed: ${reason}`);
        }

        return true;
    }

    async getPlaylistShare(shareId: string): Promise<SharedPlaylistRecordV1> {
        const normalizedShareId = String(shareId || '').trim();
        if (!normalizedShareId) {
            throw new Error('Shared playlist id is required.');
        }

        const res = await fetch(`/api/playlist-share/${encodeURIComponent(normalizedShareId)}`);
        let payload: any = null;
        try {
            payload = await res.json();
        } catch {
            payload = null;
        }

        if (res.status === 404) {
            throw new Error('Shared playlist not found.');
        }
        if (!res.ok) {
            const reason = String(payload?.error || `HTTP ${res.status}`).trim();
            throw new Error(`Share Lookup Failed: ${reason}`);
        }

        const normalized = normalizeSharedPlaylistRecord(payload);
        if (!normalized) {
            throw new Error('Share Lookup Failed: invalid payload.');
        }
        return normalized;
    }

    async browse(params: { section: BrowseSectionKey; slug?: string; page?: number }): Promise<BrowseResponse> {
        const section = String(params?.section || '').trim() as BrowseSectionKey;
        if (!section) {
            throw new Error('Browse Failed: section is required.');
        }

        const query = new URLSearchParams();
        query.set('section', section);

        const slug = String(params?.slug || '').trim();
        if (slug) query.set('slug', slug);

        const page = Number(params?.page || 1);
        if (Number.isFinite(page) && page > 1) {
            query.set('page', String(Math.floor(page)));
        }

        const res = await fetch(`/api/browse?${query.toString()}`);
        let payload: any = null;
        try {
            payload = await res.json();
        } catch {
            payload = null;
        }

        if (!res.ok) {
            const reason = String(payload?.error || `HTTP ${res.status}`).trim();
            throw new Error(`Browse Failed: ${reason}`);
        }

        return payload as BrowseResponse;
    }

    async getLatest() {
        try {
            const latestRes = await fetch('/api/latest-home');
            if (latestRes.ok) {
                const latestData = await latestRes.json();
                if (Array.isArray(latestData) && latestData.length > 0) {
                    return latestData;
                }
            }
        } catch {
        }

        const parseFeed = (text: string) => {
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, "text/xml");
            const items = Array.from(xml.querySelectorAll("item"));
            return items.map(item => ({
                title: item.querySelector("title")?.textContent || "Unknown",
                url: item.querySelector("Link")?.textContent || item.querySelector("link")?.textContent || "",
                date: item.querySelector("pubDate")?.textContent || "",
                image: null,
                rawDate: ""
            }));
        };

        const proxyCandidates = [
            '/api/download?url=' + encodeURIComponent('https://downloads.khinsider.com/rss'),
            '/api/download?url=' + encodeURIComponent('https://khinsider.com/rss'),
        ];

        for (const candidate of proxyCandidates) {
            try {
                const res = await fetch(candidate);
                if (!res.ok) continue;
                const text = await res.text();
                if (text.includes('<rss') || text.includes('<feed')) {
                    return parseFeed(text);
                }
            } catch {
            }
        }

        const directCandidates = [
            'https://downloads.khinsider.com/rss',
            'https://khinsider.com/rss',
        ];

        for (const candidate of directCandidates) {
            try {
                const res = await fetch(candidate);
                if (!res.ok) continue;
                const text = await res.text();
                if (text.includes('<rss') || text.includes('<feed')) {
                    return parseFeed(text);
                }
            } catch {
            }
        }

        console.warn("RSS Fetch Error: all feed candidates failed");
        return [];
    }
}

export const api = new KhinsiderAPI();
