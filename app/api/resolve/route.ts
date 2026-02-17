import { getKhHeaders, json, BASE_URL, isUrlAllowed } from '../_shared/khinsider';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) return json({ error: 'URL required' }, { status: 400 });
  if (!isUrlAllowed(url)) return json({ error: 'Forbidden' }, { status: 403 });

  try {

    const response = await fetch(url, { headers: getKhHeaders(url) });
    const html = await response.text();

    const regex = /href=["']([^"']+\.(mp3|flac|m4a|ogg))["']/gi;
    const found: Record<string, string> = {};
    let m: RegExpExecArray | null;
    let directUrl: string | null = null;

    while ((m = regex.exec(html)) !== null) {
      let link = m[1];
      if (!link.startsWith('http')) link = BASE_URL + link;
      const ext = link.split('.').pop()?.toLowerCase() || '';
      if (ext) found[ext] = link;
      if (!directUrl) directUrl = link;
    }

    const result: any = {
      ...found,
      directUrl: found['flac'] || found['mp3'] || found['m4a'] || directUrl,
    };

    if (result.directUrl) {
      try {

        const headRes = await fetch(result.directUrl, {
          method: 'HEAD',
          headers: getKhHeaders(result.directUrl)
        });
        if (headRes.ok) {
          result.size = headRes.headers.get('content-length');
          result.acceptsRanges = headRes.headers.get('accept-ranges') === 'bytes';
          result.type = headRes.headers.get('content-type');
        }
      } catch { }
    }

    return json(result);
  } catch (e: any) {
    return json({ error: e?.message || 'Resolve failed' }, { status: 500 });
  }
}
