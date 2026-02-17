import { getKhHeaders, cleanText, cheerioLoad, json, BASE_URL, isUrlAllowed } from '../_shared/khinsider';

export const runtime = 'nodejs';

const normalizeAlbumId = (raw?: string | null) => {
  const input = String(raw || '').trim();
  if (!input) return '';
  let path = input;
  if (/^https?:\/\//i.test(input)) {
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');

  if (!rawUrl) return json({ error: 'URL required' }, { status: 400 });

  let targetUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    const normalizedPath = targetUrl.startsWith('/') ? targetUrl : `/${targetUrl}`;
    targetUrl = `${BASE_URL}${normalizedPath}`;
  }
  if (!isUrlAllowed(targetUrl)) return json({ error: 'Forbidden' }, { status: 403 });

  try {
    const fetchAlbumPage = async (candidate: string) => {
      return fetch(candidate, { headers: getKhHeaders(candidate) });
    };

    let response: Response;
    try {
      response = await fetchAlbumPage(targetUrl);
    } catch (e: any) {
      const dnsFailure = e?.cause?.code === 'ENOTFOUND' || e?.code === 'ENOTFOUND';
      if (!dnsFailure) throw e;

      const parsed = new URL(targetUrl);
      if (parsed.hostname !== 'downloads.khinsider.com') throw e;
      const fallbackUrl = `${parsed.protocol}//khinsider.com${parsed.pathname}${parsed.search}`;
      response = await fetchAlbumPage(fallbackUrl);
      targetUrl = fallbackUrl;
    }

    if (!response.ok) {
      const parsed = new URL(targetUrl);
      const canTryAlternateHost = parsed.hostname === 'downloads.khinsider.com' || parsed.hostname === 'khinsider.com';
      if (canTryAlternateHost) {
        const alternateHost = parsed.hostname === 'downloads.khinsider.com' ? 'khinsider.com' : 'downloads.khinsider.com';
        const alternateUrl = `${parsed.protocol}//${alternateHost}${parsed.pathname}${parsed.search}`;
        const altRes = await fetchAlbumPage(alternateUrl);
        if (altRes.ok) {
          response = altRes;
          targetUrl = alternateUrl;
        }
      }
    }

    if (!response.ok) throw new Error(`Khinsider returned ${response.status}`);

    const html = await response.text();
    const $ = cheerioLoad(html);
    const pageContent = $('#pageContent').html() || '';
    const canonicalHref = $('link[rel="canonical"]').attr('href') || '';
    const albumId = normalizeAlbumId(canonicalHref) || normalizeAlbumId(targetUrl);
    const canonicalUrl = albumId ? `${BASE_URL}${albumId}` : (canonicalHref || targetUrl);

    const meta: any = {
      name: $('h2').first().text().trim(),
      year: null, developers: null, composers: null, catalogNumber: null,
      publisher: null, albumType: null, totalFilesize: null, dateAdded: null,
      platforms: [] as string[], availableFormats: [] as string[],
      description: null, relatedAlbums: [] as any[],
      commentsThreadUrl: null as string | null,
      comments: [] as any[],
      coverUrl: null, albumImages: [] as string[], imagesThumbs: [] as string[], tracks: [] as any[],
      albumId: albumId || null, canonicalUrl,
      albumArtist: null, primaryArtist: null,
    };

    const toAbsoluteUrl = (raw?: string | null) => {
      const value = String(raw || '').trim();
      if (!value) return null;
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith('//')) return `https:${value}`;
      return `${BASE_URL}${value.startsWith('/') ? value : `/${value}`}`;
    };

    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const getMeta = (label: string) => {
      const l = escapeRegex(label);
      const patterns = [
        new RegExp(`<b>\\s*${l}\\s*:?</b>\\s*([^<]+)`, 'i'),
        new RegExp(`${l}\\s*:\\s*<b>\\s*([^<]+)\\s*</b>`, 'i'),
        new RegExp(`${l}\\s*:\\s*<b>\\s*<a[^>]*>\\s*([^<]+)\\s*</a>\\s*</b>`, 'i'),
        new RegExp(`${l}\\s*:\\s*<a[^>]*>\\s*([^<]+)\\s*</a>`, 'i'),
        new RegExp(`${l}\\s*:\\s*([^<\\n\\r]+)`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = pageContent.match(pattern);
        if (match?.[1]) return cleanText(match[1]);
      }
      return null;
    };

    const getTotalFilesize = () => {
      const blockMatch = pageContent.match(/Total\s*Filesize\s*:\s*([\s\S]*?)(?:<br\s*\/?>|<\/p>|&nbsp;)/i);
      if (!blockMatch?.[1]) return getMeta('Total Filesize');

      const block = blockMatch[1];
      const entries: string[] = [];
      const entryRegex = /<b>\s*([^<]+?)\s*<\/b>\s*(?:\(([^)]+)\))?/gi;
      let m: RegExpExecArray | null;

      while ((m = entryRegex.exec(block)) !== null) {
        const size = cleanText(m[1]);
        const format = cleanText(m[2] || '');
        if (!size) continue;
        entries.push(format ? `${size} (${format.toUpperCase()})` : size);
      }

      if (entries.length > 0) return entries.join(', ');

      const plain = cleanText(block.replace(/<[^>]+>/g, ' '));
      return plain || getMeta('Total Filesize');
    };

    meta.year = getMeta('Year');
    meta.developers = getMeta('Developed by');
    meta.catalogNumber = getMeta('Catalog Number');
    meta.publisher = getMeta('Published by');
    meta.albumType = getMeta('Album type');
    meta.totalFilesize = getTotalFilesize();
    meta.dateAdded = getMeta('Date Added');

    meta.composers = getMeta('Composed by') || getMeta('Performed by');
    if (!meta.composers) {
      const descMatch = pageContent.match(/Composed by ([^<]+?)<br/i);
      if (descMatch) meta.composers = descMatch[1].replace(/&amp;/g, '&').trim();
    }
    meta.albumArtist = meta.composers || meta.developers || meta.publisher || null;
    meta.primaryArtist = meta.albumArtist;

    $('.albuminfo a[href*="game-soundtracks"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes('/album/')) meta.platforms.push($(el).text());
    });
    meta.platforms = [...new Set(meta.platforms)];

    const descHeader = $('h2').filter((i, el) => $(el).text().includes('Description'));
    if (descHeader.length) {
      let description = '';
      let next = descHeader.next();
      while (next.length && !next.is('h2')) {
        description += next.text() + '\n';
        next = next.next();
      }
      meta.description = cleanText(description);
    }

    const commentsRoot = $('#news_comments');
    if (commentsRoot.length) {
      const replyHref = commentsRoot.find('.reply_to_comment a').first().attr('href');
      meta.commentsThreadUrl = toAbsoluteUrl(replyHref);

      commentsRoot.find('.comment_wrap').each((i, el) => {
        const comment = $(el);
        const usernameLink = comment.find('.comment_username a').first();
        const metaLine = comment.find('.comment_meta').first();
        const messageRoot = comment.find('.comment_message').first().clone();
        messageRoot.find('img').remove();
        messageRoot.find('.quote').each((j, quoteEl) => {
          const quoteText = cleanText($(quoteEl).text());
          $(quoteEl).replaceWith(` Quote: ${quoteText} `);
        });

        const message = cleanText(messageRoot.text());
        if (!message) return;

        const status = cleanText(metaLine.find('.status').first().text()) || null;
        const postedAt = cleanText(metaLine.clone().find('.status').remove().end().text()) || null;
        const username = cleanText(usernameLink.text()) || `User ${i + 1}`;

        meta.comments.push({
          username,
          userUrl: toAbsoluteUrl(usernameLink.attr('href')),
          avatarUrl: toAbsoluteUrl(comment.find('.comment_useravatar img').first().attr('src')),
          postedAt,
          status,
          message,
        });
      });
    }

    const relatedHeader = $('h2').filter((i, el) => $(el).text().includes('also viewed'));
    if (relatedHeader.length) {
      relatedHeader.next('table').find('td').each((i, el) => {
        const a = $(el).find('a').first();
        const img = $(el).find('img').attr('src');
        if (a.length) {
          const href = a.attr('href') || '';
          meta.relatedAlbums.push({
            title: cleanText(a.text()),
            url: href.startsWith('http') ? href : BASE_URL + href,
            thumb: img ? (img.startsWith('http') ? img : BASE_URL + img) : null,
            albumId: normalizeAlbumId(href) || null,
          });
        }
      });
    }

    const images: string[] = [];
    const thumbs: string[] = [];
    $('.albumImage').each((i, el) => {
      const a = $(el).find('a').first();
      const img = $(el).find('img').first();

      let href = a.attr('href');
      let thumbSrc = img.attr('src');

      if (href) {
        if (!href.startsWith('http')) href = BASE_URL + href;
        images.push(href);
      }

      if (thumbSrc) {
        if (!thumbSrc.startsWith('http')) thumbSrc = BASE_URL + thumbSrc;
        thumbs.push(thumbSrc);
      }
    });
    meta.albumImages = [...new Set(images)];
    meta.imagesThumbs = [...new Set(thumbs)];
    meta.coverUrl = meta.albumImages.length > 0 ? meta.albumImages[0] : null;

    const headers: string[] = [];
    $('#songlist tr').first().find('th').each((i, el) => {
      headers.push((cleanText($(el).text()) || '').toLowerCase());
    });
    meta.availableFormats = headers.filter((h) => !!h && !['#', 'song name', 'play', 'time', 'size'].includes(h));

    let trackCounter = 1;
    $('#songlist tr').each((i, el) => {
      if ($(el).attr('id')) return;
      const tds = $(el).find('td');
      if (tds.length < 2) return;

      const anchor = $(el).find('a').filter((idx, a) => {
        const h = $(a).attr('href');
        return typeof h === 'string' && h.includes('/game-soundtracks/album/');
      }).first();

      if (!anchor.length) return;

      const title = cleanText(anchor.text());
      const href = anchor.attr('href') || '';
      const url = href.startsWith('http') ? href : BASE_URL + href;
      const number = trackCounter++;
      let duration: string | null = null;
      let fileSize: string | null = null;
      let bitrate: string | null = null;

      tds.each((j, td) => {
        const txt = $(td).text().trim();
        if (/^\d+:\d{2}(:\d{2})?$/.test(txt)) duration = txt;
        else if (/\d+(\.\d+)?\s*(MB|KB|GB)/i.test(txt)) fileSize = txt;
        else if (/\d+\s*k(bps)?/i.test(txt)) bitrate = txt;
      });

      meta.tracks.push({ number, title, duration: duration || '--:--', fileSize: fileSize || '', bitrate, url, albumId: albumId || null });
    });

    return json(meta);
  } catch (e: any) {
    return json({ error: e?.message || 'Album fetch failed' }, { status: 500 });
  }
}
