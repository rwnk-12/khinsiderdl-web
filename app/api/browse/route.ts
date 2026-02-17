import type { BrowseAction, BrowseAlbumItem, BrowsePagination, BrowseResponse, BrowseSectionKey } from '../../../lib/browse-types';
import { BASE_URL, cleanText, cheerioLoad, getKhHeaders, isAbortError, isTimeoutError, json } from '../_shared/khinsider';

export const runtime = 'nodejs';

const FETCH_TIMEOUT_MS = 25_000;
const LIST_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=900';

const STATIC_SECTION_CONFIG: Record<string, { key: BrowseSectionKey; label: string; path: string }> = {
    browse_all: { key: 'browse_all', label: 'Browse All', path: '/game-soundtracks' },
    top40: { key: 'top40', label: 'Top 40', path: '/top40' },
    top1000_all_time: { key: 'top1000_all_time', label: 'Top 1000 All Time', path: '/all-time-top-100' },
    top100_last_6_months: { key: 'top100_last_6_months', label: 'Top 100 Last 6 Months', path: '/last-6-months-top-100' },
    top100_newly_added: { key: 'top100_newly_added', label: 'Top 100 Newly Added', path: '/top-100-newly-added' },
    currently_viewed: { key: 'currently_viewed', label: 'Currently Viewed', path: '/currently-viewed' },
    most_favorites: { key: 'most_favorites', label: 'Most Favorites', path: '/most-favorites' },
    requests: { key: 'requests', label: 'Requests', path: '/request/list' },
};

const TYPE_SLUG_ALLOWLIST = new Set([
    'gamerips',
    'ost',
    'singles',
    'arrangements',
    'remixes',
    'compilations',
    'inspired-by',
]);

const TYPE_SECTION_LABELS: Record<string, string> = {
    gamerips: 'Gamerips',
    ost: 'Soundtracks',
    singles: 'Singles',
    arrangements: 'Arrangements',
    remixes: 'Remixes',
    compilations: 'Compilations',
    'inspired-by': 'Inspired By',
};

const toAbsoluteUrl = (raw: string | null | undefined) => {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return `https:${value}`;
    return `${BASE_URL}${value.startsWith('/') ? value : `/${value}`}`;
};

const normalizeAlbumId = (raw?: string | null) => {
    const input = String(raw || '').trim();
    if (!input) return '';
    let path = input;
    if (input.startsWith('http')) {
        try {
            path = new URL(input).pathname;
        } catch {
            path = input;
        }
    }
    const match = path.match(/(\/game-soundtracks\/album\/[^/?#]+)/i);
    if (!match?.[1]) return '';
    return match[1].replace(/[/?]+$/, '').toLowerCase();
};

const coercePage = (raw: string | null, fallback = 1) => {
    const parsed = Number.parseInt(String(raw || ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, 500);
};

const toSectionLabel = (section: BrowseSectionKey, slug: string) => {
    if (section === 'type') {
        if (TYPE_SECTION_LABELS[slug]) return `Type: ${TYPE_SECTION_LABELS[slug]}`;
        const pretty = slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
        return pretty ? `Type: ${pretty}` : 'By Type';
    }
    if (section === 'year') return `Year: ${slug}`;
    if (section === 'random_album') return 'Random Album';
    if (section === 'random_album_advanced') return 'Random Album [A]';
    if (section === 'random_song') return 'Random Song';
    return STATIC_SECTION_CONFIG[section]?.label || 'Browse';
};

const extractAlbumTitleFromHref = (href: string) => {
    const normalizedAlbumId = normalizeAlbumId(href);
    if (!normalizedAlbumId) return 'Unknown Album';
    const slug = normalizedAlbumId.split('/').pop() || normalizedAlbumId;
    const decoded = slug
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!decoded) return 'Unknown Album';
    return decoded;
};

const extractTrackToken = (trackUrl: string) => {
    const pathname = (() => {
        try {
            return new URL(trackUrl).pathname || '';
        } catch {
            return trackUrl;
        }
    })();
    const cleanedPath = String(pathname || '')
        .replace(/\?.*$/, '')
        .replace(/#.*$/, '')
        .replace(/\/+/g, '/')
        .trim();
    if (!cleanedPath) return '';
    const withSlash = cleanedPath.startsWith('/') ? cleanedPath : `/${cleanedPath}`;
    const lastPart = decodeURIComponent(withSlash.split('/').pop() || '');
    const numberMatch = lastPart.match(/^(\d{1,3})\s*[\-._)]/);
    if (numberMatch?.[1]) {
        const trackNo = Number.parseInt(numberMatch[1], 10);
        if (Number.isFinite(trackNo) && trackNo > 0) {
            return `n:${trackNo}|${withSlash}`;
        }
    }
    return withSlash;
};

const fetchWithTimeout = async (targetUrl: string, init?: RequestInit) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, FETCH_TIMEOUT_MS);
    try {
        return await fetch(targetUrl, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
};

const addBrowseItem = (
    collection: Map<string, BrowseAlbumItem>,
    candidate: {
        href: string;
        title: string;
        icon?: string | null;
        albumType?: string | null;
        year?: string | null;
    }
) => {
    const absoluteUrl = toAbsoluteUrl(candidate.href);
    const albumId = normalizeAlbumId(absoluteUrl);
    if (!albumId) return;
    const key = albumId;
    const existing = collection.get(key);

    const next: BrowseAlbumItem = {
        title: cleanText(candidate.title) || (existing?.title || extractAlbumTitleFromHref(absoluteUrl)),
        id: albumId,
        icon: candidate.icon ? toAbsoluteUrl(candidate.icon) : (existing?.icon || null),
        url: `${BASE_URL}${albumId}`,
        albumId,
        albumType: cleanText(candidate.albumType || '') || existing?.albumType || null,
        year: cleanText(candidate.year || '') || existing?.year || null,
    };

    collection.set(key, next);
};

const parseBrowseItems = (html: string) => {
    const $ = cheerioLoad(html);
    const root = $('#pageContent').length ? $('#pageContent') : $('body');
    const itemMap = new Map<string, BrowseAlbumItem>();

    root.find('table.albumList tr').each((_, rowEl) => {
        const row = $(rowEl);
        const cells = row.find('td');
        if (cells.length < 2) return;

        const titleLink = row.find('td').eq(1).find('a[href*="/game-soundtracks/album/"]').first();
        const fallbackLink = row.find('a[href*="/game-soundtracks/album/"]').first();
        const link = titleLink.length ? titleLink : fallbackLink;
        if (!link.length) return;

        const href = String(link.attr('href') || '').trim();
        if (!href) return;

        const title =
            cleanText(link.text()) ||
            cleanText(row.find('td').eq(1).text()) ||
            extractAlbumTitleFromHref(href);
        const icon = String(row.find('td').eq(0).find('img').first().attr('src') || '').trim();
        const albumType = cleanText(row.find('td').eq(3).text());
        const year = cleanText(row.find('td').eq(4).text());

        addBrowseItem(itemMap, {
            href,
            title,
            icon,
            albumType,
            year,
        });
    });

    if (itemMap.size === 0) {
        root.find('td.albumIconLarge').each((_, cellEl) => {
            const cell = $(cellEl);
            const link = cell.find('a[href*="/game-soundtracks/album/"]').first();
            if (!link.length) return;

            const href = String(link.attr('href') || '').trim();
            if (!href) return;

            const title =
                cleanText(cell.find('p').first().text()) ||
                cleanText(link.text()) ||
                extractAlbumTitleFromHref(href);
            const icon = String(cell.find('img').first().attr('src') || '').trim();

            addBrowseItem(itemMap, {
                href,
                title,
                icon,
            });
        });
    }

    if (itemMap.size === 0) {
        root.find('td.albumIcon').each((_, cellEl) => {
            const cell = $(cellEl);
            const row = cell.closest('tr');
            const rowCells = row.find('td');
            if (!rowCells.length) return;

            const titleLink = rowCells.eq(1).find('a[href*="/game-soundtracks/album/"]').first();
            const iconLink = cell.find('a[href*="/game-soundtracks/album/"]').first();
            const link = titleLink.length ? titleLink : iconLink;
            if (!link.length) return;

            const href = String(link.attr('href') || '').trim();
            if (!href) return;

            const title =
                cleanText(titleLink.text()) ||
                cleanText(link.text()) ||
                cleanText(rowCells.eq(1).text()) ||
                extractAlbumTitleFromHref(href);
            const icon = String(cell.find('img').first().attr('src') || '').trim();
            const albumType = rowCells.length >= 4 ? cleanText(rowCells.eq(3).text()) : '';
            const year = rowCells.length >= 5 ? cleanText(rowCells.eq(4).text()) : '';

            addBrowseItem(itemMap, {
                href,
                title,
                icon,
                albumType,
                year,
            });
        });
    }

    if (itemMap.size === 0) {
        root.find('a[href*="/game-soundtracks/album/"]').each((_, linkEl) => {
            const link = $(linkEl);
            const href = String(link.attr('href') || '').trim();
            if (!href) return;

            const title =
                cleanText(link.text()) ||
                cleanText(String(link.attr('title') || '')) ||
                extractAlbumTitleFromHref(href);
            if (!title) return;

            const row = link.closest('tr');
            const icon = String(
                row.find('img').first().attr('src') ||
                link.closest('td').prev('td').find('img').first().attr('src') ||
                link.closest('td').find('img').first().attr('src') ||
                ''
            ).trim();

            const cells = row.find('td');
            const albumType = cells.length >= 4 ? cleanText(cells.eq(3).text()) : '';
            const year = cells.length >= 5 ? cleanText(cells.eq(4).text()) : '';

            addBrowseItem(itemMap, {
                href,
                title,
                icon,
                albumType,
                year,
            });
        });
    }

    return {
        $,
        items: Array.from(itemMap.values()),
    };
};

const parseTopAlbumGrid = ($: ReturnType<typeof cheerioLoad>) => {
    const root = $('#pageContent').length ? $('#pageContent') : $('body');
    const topItemMap = new Map<string, BrowseAlbumItem>();
    const topCells = root.find('td.albumIconLarge');

    topCells.each((_, cellEl) => {
        const cell = $(cellEl);
        const link = cell.find('a[href*="/game-soundtracks/album/"]').first();
        if (!link.length) return;

        const href = String(link.attr('href') || '').trim();
        if (!href) return;

        const title =
            cleanText(cell.find('p').first().text()) ||
            cleanText(link.text()) ||
            extractAlbumTitleFromHref(href);
        const icon = String(cell.find('img').first().attr('src') || '').trim();

        addBrowseItem(topItemMap, {
            href,
            title,
            icon,
        });
    });

    let label: string | null = null;
    if (topCells.length > 0) {
        const table = topCells.first().closest('table');
        const heading = cleanText(table.prevAll('h2').first().text() || '');
        label = heading || null;
    }

    return {
        items: Array.from(topItemMap.values()),
        label,
    };
};

const parseTotalAlbumCount = ($: ReturnType<typeof cheerioLoad>) => {
    const root = $('#pageContent').length ? $('#pageContent') : $('body');
    const rootText = cleanText(root.text());
    const match = rootText.match(/\bFound\s+([\d,]+)\s+albums?!?\b/i);
    if (!match?.[1]) return null;
    const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    return parsed;
};

const parseBrowsePagination = (
    $: ReturnType<typeof cheerioLoad>,
    sourceUrl: string,
    currentPage: number
): BrowsePagination => {
    let basePath = '';
    try {
        basePath = new URL(sourceUrl).pathname.toLowerCase();
    } catch {
        basePath = '';
    }

    const pages = new Set<number>([currentPage]);
    let textNext: number | null = null;
    let textPrev: number | null = null;

    const root = $('#pageContent').length ? $('#pageContent') : $('body');
    root.find('a[href]').each((_, linkEl) => {
        const href = String($(linkEl).attr('href') || '').trim();
        if (!href) return;

        let parsed: URL;
        try {
            parsed = new URL(href, sourceUrl);
        } catch {
            return;
        }

        if (basePath && parsed.pathname.toLowerCase() !== basePath) return;
        const page = coercePage(parsed.searchParams.get('page'), 1);
        pages.add(page);

        const text = cleanText($(linkEl).text()).toLowerCase();
        if (text.includes('next') || text === '>' || text === '>>') {
            textNext = page;
        }
        if (text.includes('prev') || text.includes('previous') || text === '<' || text === '<<') {
            textPrev = page;
        }
    });

    const sortedPages = Array.from(pages).sort((a, b) => a - b);
    let totalPages = Math.max(1, sortedPages[sortedPages.length - 1] || currentPage || 1);

    const counterText = cleanText(root.find('.pagination .counter').first().text() || '');
    const counterMatch = counterText.match(/\bPage\s+(\d+)\s+of\s+(\d+)\b/i);
    if (counterMatch?.[2]) {
        const parsedTotal = Number.parseInt(counterMatch[2], 10);
        if (Number.isFinite(parsedTotal) && parsedTotal > totalPages) {
            totalPages = parsedTotal;
        }
    }
    const prevPage = pages.has(currentPage - 1) ? currentPage - 1 : (textPrev && textPrev < currentPage ? textPrev : null);
    const nextPage = pages.has(currentPage + 1) ? currentPage + 1 : (textNext && textNext > currentPage ? textNext : null);

    return {
        currentPage: Math.max(1, currentPage),
        totalPages: Math.max(Math.max(1, currentPage), totalPages),
        prevPage,
        nextPage,
    };
};

const makeBaseResponse = (section: BrowseSectionKey, slug: string, page: number): BrowseResponse => ({
    section,
    sectionLabel: toSectionLabel(section, slug),
    slug,
    page,
    sourceUrl: '',
    items: [],
    pagination: {
        currentPage: page,
        totalPages: 1,
        prevPage: null,
        nextPage: null,
    },
});

const createActionResponse = (
    base: BrowseResponse,
    action: BrowseAction,
    noStore = true
) => {
    return json(
        { ...base, action },
        {
            headers: noStore ? { 'Cache-Control': 'no-store' } : { 'Cache-Control': LIST_CACHE_CONTROL },
        }
    );
};

const resolveRandomAction = async (section: BrowseSectionKey): Promise<BrowseAction> => {
    if (section === 'random_album' || section === 'random_album_advanced') {
        const targetUrl = section === 'random_album'
            ? `${BASE_URL}/random-album`
            : `${BASE_URL}/random-album-advanced`;
        const init: RequestInit = section === 'random_album_advanced'
            ? {
                method: 'POST',
                headers: {
                    ...getKhHeaders(targetUrl),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Referer: targetUrl,
                },
                body: new URLSearchParams({
                    randomAdvanced: 'Show Me A Random Album',
                }).toString(),
                redirect: 'manual',
            }
            : {
                headers: getKhHeaders(targetUrl),
                redirect: 'manual',
            };

        const response = await fetchWithTimeout(targetUrl, init);
        const redirectLocation = toAbsoluteUrl(response.headers.get('location') || '');
        const resolvedUrl = redirectLocation || toAbsoluteUrl(response.url || targetUrl);
        const albumId = normalizeAlbumId(resolvedUrl);
        if (albumId) {
            return {
                kind: 'open_album',
                section,
                label: section === 'random_album' ? 'Random Album' : 'Random Album [A]',
                albumUrl: `${BASE_URL}${albumId}`,
                albumId,
                sourceUrl: resolvedUrl,
            };
        }

        return {
            kind: 'open_external',
            section,
            label: section === 'random_album' ? 'Random Album' : 'Random Album [A]',
            externalUrl: resolvedUrl || targetUrl,
            sourceUrl: resolvedUrl || targetUrl,
            message: 'Could not resolve a random album inside app. Opening KHInsider directly.',
        };
    }

    const targetUrl = `${BASE_URL}/random-song`;
    const response = await fetchWithTimeout(targetUrl, {
        headers: getKhHeaders(targetUrl),
        redirect: 'manual',
    });
    const redirectLocation = toAbsoluteUrl(response.headers.get('location') || '');
    const resolvedUrl = redirectLocation || toAbsoluteUrl(response.url || targetUrl);
    const albumId = normalizeAlbumId(resolvedUrl);
    const albumUrl = albumId ? `${BASE_URL}${albumId}` : '';
    const trackToken = extractTrackToken(resolvedUrl);

    if (albumUrl && trackToken) {
        return {
            kind: 'open_track',
            section,
            label: 'Random Song',
            albumUrl,
            albumId: albumId || null,
            trackUrl: resolvedUrl,
            trackToken,
            sourceUrl: resolvedUrl,
        };
    }

    return {
        kind: 'open_external',
        section,
        label: 'Random Song',
        externalUrl: resolvedUrl || targetUrl,
        sourceUrl: resolvedUrl || targetUrl,
        message: 'Could not map this random song to an in-app album reliably. Opening KHInsider directly.',
    };
};

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const sectionRaw = String(searchParams.get('section') || 'browse_all').trim().toLowerCase();
    const slugRaw = String(searchParams.get('slug') || '').trim().toLowerCase();
    const page = coercePage(searchParams.get('page'), 1);

    const section = sectionRaw as BrowseSectionKey;
    if (
        section !== 'browse_all' &&
        section !== 'top40' &&
        section !== 'top1000_all_time' &&
        section !== 'top100_last_6_months' &&
        section !== 'top100_newly_added' &&
        section !== 'currently_viewed' &&
        section !== 'most_favorites' &&
        section !== 'requests' &&
        section !== 'type' &&
        section !== 'year' &&
        section !== 'random_album' &&
        section !== 'random_album_advanced' &&
        section !== 'random_song'
    ) {
        return json({ error: 'Invalid browse section.' }, { status: 400 });
    }

    if (section === 'type' && !TYPE_SLUG_ALLOWLIST.has(slugRaw)) {
        return json({ error: 'Invalid type slug.' }, { status: 400 });
    }
    if (section === 'year' && !/^\d{4}$/.test(slugRaw)) {
        return json({ error: 'Invalid year slug.' }, { status: 400 });
    }

    const base = makeBaseResponse(section, slugRaw, page);

    try {
        if (section === 'random_album' || section === 'random_album_advanced' || section === 'random_song') {
            const action = await resolveRandomAction(section);
            return createActionResponse(base, action, true);
        }

        let targetPath = '';
        if (section === 'type') {
            targetPath = `/game-soundtracks/${slugRaw}`;
        } else if (section === 'year') {
            targetPath = `/game-soundtracks/year/${slugRaw}`;
        } else {
            targetPath = STATIC_SECTION_CONFIG[section].path;
        }

        const target = new URL(targetPath, BASE_URL);
        if (page > 1) {
            target.searchParams.set('page', String(page));
        }

        const targetUrl = target.toString();
        if (!targetUrl.startsWith(BASE_URL)) {
            return json({ error: 'Forbidden target URL.' }, { status: 403 });
        }

        const response = await fetchWithTimeout(targetUrl, {
            headers: getKhHeaders(targetUrl),
        });

        if (!response.ok) {
            return json({ error: `Browse source returned ${response.status}.` }, { status: response.status });
        }

        const html = await response.text();
        const title = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''));
        const requiresLogin = /please log in/i.test(title);

        if (section === 'requests' && requiresLogin) {
            const payload: BrowseResponse = {
                ...base,
                sourceUrl: response.url || targetUrl,
                notice: 'Requests are account-only on KHInsider. Open KHInsider to view and manage requests.',
                requiresLogin: true,
            };
            return json(payload, {
                headers: {
                    'Cache-Control': 'no-store',
                },
            });
        }

        const { $, items } = parseBrowseItems(html);
        const topGrid = parseTopAlbumGrid($);
        const totalItems = parseTotalAlbumCount($);
        const pagination = parseBrowsePagination($, response.url || targetUrl, page);

        const payload: BrowseResponse = {
            ...base,
            sourceUrl: response.url || targetUrl,
            sectionLabel: toSectionLabel(section, slugRaw),
            items,
            ...(typeof totalItems === 'number' ? { totalItems } : {}),
            ...(section === 'year' && page === 1 && topGrid.items.length > 0
                ? {
                    topItems: topGrid.items.slice(0, 12),
                    topItemsLabel: topGrid.label || `Top ${Math.min(12, topGrid.items.length)} Albums From ${slugRaw}`,
                }
                : {}),
            pagination,
            ...(items.length === 0
                ? {
                    notice: section === 'requests'
                        ? 'No request data could be parsed for this page.'
                        : 'No albums found for this browse section.',
                }
                : {}),
        };

        return json(payload, {
            headers: {
                'Cache-Control': LIST_CACHE_CONTROL,
            },
        });
    } catch (error) {
        if (isTimeoutError(error)) {
            return json({ error: 'Browse request timed out.' }, { status: 504 });
        }
        if (isAbortError(error)) {
            return json({ error: 'Browse request aborted.' }, { status: 499 });
        }
        console.error('GET /api/browse failed', error);
        return json({ error: 'Browse request failed.' }, { status: 500 });
    }
}
