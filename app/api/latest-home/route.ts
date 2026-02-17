import { BASE_URL, cleanText, cheerioLoad, getKhHeaders, json } from '../_shared/khinsider';

export const runtime = 'nodejs';

type LatestItem = {
  title: string;
  url: string;
  image: string | null;
  date: string;
  rawDate: string;
  albumType: string | null;
  year: string | null;
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_S_MAXAGE_SECONDS = 30 * 60;
const CACHE_STALE_WHILE_REVALIDATE_SECONDS = 5 * 60;
let cacheAt = 0;
let cacheItems: LatestItem[] | null = null;

const normalizeAbsUrl = (raw?: string | null) => {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${BASE_URL}${value}`;
  return `${BASE_URL}/${value}`;
};

const parseHeadingDateToIso = (rawHeading?: string) => {
  const raw = String(rawHeading || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
};

export async function GET() {
  const now = Date.now();
  if (cacheItems && now - cacheAt < CACHE_TTL_MS) {
    return json(cacheItems, {
      headers: {
        'Cache-Control': `public, s-maxage=${CACHE_S_MAXAGE_SECONDS}, stale-while-revalidate=${CACHE_STALE_WHILE_REVALIDATE_SECONDS}`,
      },
    });
  }

  try {
    const res = await fetch(BASE_URL, { headers: getKhHeaders(BASE_URL) });
    if (!res.ok) throw new Error(`Khinsider returned ${res.status}`);

    const html = await res.text();
    const $ = cheerioLoad(html);
    const root = $('#homepageLatestSoundtracks');
    const seen = new Set<string>();
    const items: LatestItem[] = [];
    let currentRawDate = '';
    let currentIsoDate = '';

    root.children().each((_, node) => {
      const el = $(node);
      if (el.is('h3.latestSoundtrackHeading')) {
        currentRawDate = cleanText(el.text());
        currentIsoDate = parseHeadingDateToIso(currentRawDate);
        return;
      }

      if (!el.hasClass('albumListWrapper')) return;

      el.find('table.albumList tr').each((idx, tr) => {
        if (idx === 0) return;

        const row = $(tr);
        const tds = row.find('td');
        if (tds.length < 2) return;

        const albumLink = tds.eq(1).find('a[href*="/game-soundtracks/album/"]').first();
        if (!albumLink.length) return;

        const href = normalizeAbsUrl(albumLink.attr('href'));
        if (!href || seen.has(href)) return;
        seen.add(href);

        const title = cleanText(albumLink.text());
        const imageSrc = normalizeAbsUrl(tds.eq(0).find('img').attr('src')) || null;
        const albumType = cleanText(tds.eq(3).text()) || null;
        const year = cleanText(tds.eq(4).text()) || null;

        items.push({
          title,
          url: href,
          image: imageSrc,
          date: currentIsoDate || '',
          rawDate: currentRawDate || '',
          albumType,
          year,
        });
      });
    });

    cacheItems = items;
    cacheAt = now;

    return json(items, {
      headers: {
        'Cache-Control': `public, s-maxage=${CACHE_S_MAXAGE_SECONDS}, stale-while-revalidate=${CACHE_STALE_WHILE_REVALIDATE_SECONDS}`,
      },
    });
  } catch (e: any) {
    return json({ error: e?.message || 'Latest home fetch failed' }, { status: 500 });
  }
}
