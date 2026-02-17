import { BASE_URL, getKhHeaders, cleanText, cheerioLoad, json } from '../_shared/khinsider';
import type {
  SearchAlbumsResponse,
  SearchFilterOption,
  SearchFilterOptions,
  SearchFilters,
  SearchPagination,
  SearchResultAlbum,
} from '../../../lib/search-types';

export const runtime = 'nodejs';

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
  if (match?.[1]) return match[1].replace(/[/?]+$/, '').toLowerCase();
  const shortMatch = path.match(/\/album\/([^/?#]+)/i);
  if (shortMatch?.[1]) {
    return `/game-soundtracks/album/${shortMatch[1]}`.replace(/[/?]+$/, '').toLowerCase();
  }
  return '';
};

const normalizeFilterValue = (raw: string | null | undefined) => {
  const value = String(raw || '').trim();
  if (!value || value === '0') return '';
  return value;
};

const toAbsoluteUrl = (raw: string | null | undefined) => {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('http')) return value;
  return `${BASE_URL}${value.startsWith('/') ? value : `/${value}`}`;
};

const parseSelectOptions = ($: any, select: any): SearchFilterOption[] => {
  if (!select || !select.length) return [];
  const seen = new Set<string>();
  const options: SearchFilterOption[] = [];

  select.find('option').each((_: number, optionEl: any) => {
    const rawValue = String($(optionEl).attr('value') ?? '').trim();
    const value = normalizeFilterValue(rawValue);
    if (seen.has(value)) return;
    seen.add(value);
    const label = cleanText($(optionEl).text()) || 'Any';
    options.push({ value, label });
  });

  return options;
};

const parseFilterOptions = ($: any): SearchFilterOptions => {
  const empty: SearchFilterOptions = {
    sort: [],
    albumType: [],
    albumYear: [],
    albumCategory: [],
  };

  const form = $('form[action="/music/search"]').first();
  if (!form.length) return empty;

  const allSelects = form.find('select');
  const sortSelect = form.find('select[name="sort"]').first();
  const albumTypeSelect = form.find('select[name="album_type"]').first();
  const albumYearSelect = allSelects.eq(2);
  const albumCategorySelect = allSelects.eq(3);

  return {
    sort: parseSelectOptions($, sortSelect),
    albumType: parseSelectOptions($, albumTypeSelect),
    albumYear: parseSelectOptions($, albumYearSelect),
    albumCategory: parseSelectOptions($, albumCategorySelect),
  };
};

const parseTotalMatches = ($: any): number | null => {
  let foundLine = '';
  $('p').each((_: number, el: any) => {
    if (foundLine) return;
    const text = cleanText($(el).text());
    if (/Found\s+[\d,]+\s+matching\s+albums/i.test(text)) {
      foundLine = text;
    }
  });

  if (!foundLine) {
    const bodyText = cleanText($('#pageContent').text());
    const bodyMatch = bodyText.match(/Found\s+[\d,]+\s+matching\s+albums/i);
    foundLine = bodyMatch?.[0] || '';
  }

  if (!foundLine) return null;
  const match = foundLine.match(/Found\s+([\d,]+)\s+matching\s+albums/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const extractResultToken = (href: string | null | undefined): string | null => {
  const value = String(href || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value, BASE_URL);
    const result = normalizeFilterValue(url.searchParams.get('result'));
    return result || null;
  } catch {
    return null;
  }
};

const parsePagination = (
  $: any,
  appliedResult: string,
  itemCount: number,
  totalMatches: number | null
): SearchPagination => {
  let prevResult: string | null = null;
  let nextResult: string | null = null;
  const linkedResults = new Set<string>();

  $('a[href*="/search"]').each((_: number, el: any) => {
    const href = String($(el).attr('href') || '');
    if (!href) return;

    const token = extractResultToken(href);
    if (token) linkedResults.add(token);

    const rel = String($(el).attr('rel') || '').toLowerCase();
    const text = cleanText($(el).text()).toLowerCase();
    const isPrev = rel === 'prev' || text.includes('previous') || text === 'prev' || text === '<' || text === '<<';
    const isNext = rel === 'next' || text.includes('next') || text === 'next' || text === '>' || text === '>>';

    if (isPrev && !prevResult) prevResult = token;
    if (isNext && !nextResult) nextResult = token;
  });

  const currentOffset = appliedResult ? Number.parseInt(appliedResult, 10) : 0;
  const hasNumericOffset = Number.isFinite(currentOffset);
  const numericResults = Array.from(linkedResults)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (hasNumericOffset) {
    if (!prevResult) {
      const prevCandidate = [...numericResults].reverse().find((value) => value < currentOffset);
      if (Number.isFinite(prevCandidate)) prevResult = String(prevCandidate);
    }
    if (!nextResult) {
      const nextCandidate = numericResults.find((value) => value > currentOffset);
      if (Number.isFinite(nextCandidate)) nextResult = String(nextCandidate);
    }
  }

  let currentPage = 1;
  let totalPages = 1;

  const pageText = cleanText($('#pageContent').text());
  const pageMatch = pageText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (pageMatch?.[1] && pageMatch?.[2]) {
    const parsedCurrent = Number.parseInt(pageMatch[1], 10);
    const parsedTotal = Number.parseInt(pageMatch[2], 10);
    if (Number.isFinite(parsedCurrent) && parsedCurrent > 0) currentPage = parsedCurrent;
    if (Number.isFinite(parsedTotal) && parsedTotal > 0) totalPages = parsedTotal;
  } else {
    if (hasNumericOffset && itemCount > 0) {
      currentPage = Math.floor(currentOffset / itemCount) + 1;
    }
    if (totalMatches !== null && itemCount > 0) {
      totalPages = Math.max(1, Math.ceil(totalMatches / itemCount));
    } else {
      totalPages = Math.max(currentPage, nextResult ? currentPage + 1 : currentPage);
    }
  }

  if (totalPages < currentPage) totalPages = currentPage;
  if (currentPage < 1) currentPage = 1;

  return {
    currentPage,
    totalPages,
    prevResult,
    nextResult,
  };
};

const makeDefaultPayload = (applied: SearchFilters, sourceUrl: string): SearchAlbumsResponse => ({
  items: [],
  applied,
  filterOptions: {
    sort: [],
    albumType: [],
    albumYear: [],
    albumCategory: [],
  },
  pagination: {
    currentPage: 1,
    totalPages: 1,
    prevResult: null,
    nextResult: null,
  },
  totalMatches: null,
  sourceUrl,
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = cleanText(searchParams.get('q') || '');

  if (!q || q.length > 100) {
    return json({ error: 'Query required (max 100 chars)' }, { status: 400 });
  }

  try {
    const term = q.replace('series:', '');
    const applied: SearchFilters = {
      q: term,
      sort: cleanText(searchParams.get('sort') || '') || 'relevance',
      album_type: normalizeFilterValue(searchParams.get('album_type')),
      album_year: normalizeFilterValue(searchParams.get('album_year')),
      album_category: normalizeFilterValue(searchParams.get('album_category')),
      result: normalizeFilterValue(searchParams.get('result')),
    };

    const upstreamParams = new URLSearchParams();
    upstreamParams.set('search', term);
    upstreamParams.set('type', 'album');
    upstreamParams.set('sort', applied.sort || 'relevance');
    upstreamParams.set('album_type', applied.album_type);
    upstreamParams.set('album_year', applied.album_year);
    upstreamParams.set('album_category', applied.album_category);
    upstreamParams.set('albumListSize', 'large');
    if (applied.result) upstreamParams.set('result', applied.result);

    const targetUrl = `${BASE_URL}/search?${upstreamParams.toString()}`;

    const response = await fetch(targetUrl, { headers: getKhHeaders(targetUrl) });
    if (!response.ok) throw new Error(`Khinsider returned ${response.status}`);

    const html = await response.text();
    const $ = cheerioLoad(html);
    const payload = makeDefaultPayload(applied, response.url || targetUrl);

    const pageHeader = $('h2').first().text().trim();
    if (pageHeader && pageHeader !== 'Search' && !pageHeader.includes('Search Results')) {
      const canonical = toAbsoluteUrl($('link[rel="canonical"]').attr('href') || response.url || targetUrl);
      const albumId = normalizeAlbumId(canonical);
      const icon = toAbsoluteUrl($('.albumImage a img').attr('src')) || null;
      payload.items.push({
        title: pageHeader,
        id: canonical.replace(BASE_URL, '') || canonical,
        icon,
        url: canonical,
        albumId: albumId || null,
        albumType: null,
        year: null,
      });
      payload.pagination = {
        currentPage: 1,
        totalPages: 1,
        prevResult: null,
        nextResult: null,
      };
      return json(payload);
    }

    const results: SearchResultAlbum[] = [];
    $('.albumList tr').each((i: number, el: any) => {
      if (i === 0) return;
      const tds = $(el).find('td');
      if (tds.length < 2) return;

      const titleTd = tds.eq(1);
      const linkTag = titleTd.find('a').first();
      const href = linkTag.attr('href');

      if (href && href.includes('/game-soundtracks/album/')) {
        const iconImgRaw = tds.eq(0).find('img').attr('src');
        const iconImg = toAbsoluteUrl(iconImgRaw) || null;
        const albumId = normalizeAlbumId(href);
        const albumType = cleanText(tds.eq(3).text()) || null;
        const year = cleanText(tds.eq(4).text()) || null;
        const absoluteUrl = toAbsoluteUrl(href);
        results.push({
          title: cleanText(linkTag.text()),
          id: href,
          icon: iconImg,
          url: absoluteUrl,
          albumId: albumId || null,
          albumType,
          year,
        });
      }
    });

    payload.items = results;
    payload.filterOptions = parseFilterOptions($);
    payload.totalMatches = parseTotalMatches($);
    payload.pagination = parsePagination($, applied.result, results.length, payload.totalMatches);

    return json(payload);
  } catch (e: any) {
    console.error("Search Error:", e);
    return json({ error: 'Search failed' }, { status: 500 });
  }
}
