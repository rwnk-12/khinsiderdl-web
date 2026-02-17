
import { NextRequest, NextResponse } from 'next/server';
import { getKhHeaders, isUrlAllowed } from '../_shared/khinsider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const DOWNLOAD_RATE_WINDOW_MS = 60_000;
const DOWNLOAD_RATE_MAX_REQUESTS = 240;
const downloadRateBuckets = new Map<string, number[]>();

const getClientIp = (request: NextRequest) => {
  const cfIp = String(request.headers.get('cf-connecting-ip') || '').trim();
  if (cfIp) return cfIp;
  const forwarded = String(request.headers.get('x-forwarded-for') || '').trim();
  if (forwarded) return forwarded.split(',')[0].trim() || 'unknown';
  const realIp = String(request.headers.get('x-real-ip') || '').trim();
  if (realIp) return realIp;
  return 'unknown';
};

const isCrossSiteBrowserRequest = (request: NextRequest) => {
  const secFetchSite = String(request.headers.get('sec-fetch-site') || '').trim().toLowerCase();
  return secFetchSite === 'cross-site';
};

const checkDownloadRateLimit = (request: NextRequest) => {
  const ip = getClientIp(request);
  const now = Date.now();
  const windowStart = now - DOWNLOAD_RATE_WINDOW_MS;
  const history = (downloadRateBuckets.get(ip) || []).filter((timestamp) => timestamp > windowStart);
  if (history.length >= DOWNLOAD_RATE_MAX_REQUESTS) {
    downloadRateBuckets.set(ip, history);
    return false;
  }
  history.push(now);
  downloadRateBuckets.set(ip, history);

  if (downloadRateBuckets.size > 8000) {
    for (const [key, timestamps] of downloadRateBuckets.entries()) {
      const trimmed = timestamps.filter((timestamp) => timestamp > windowStart);
      if (trimmed.length === 0) downloadRateBuckets.delete(key);
      else downloadRateBuckets.set(key, trimmed);
    }
  }
  return true;
};

const jsonError = (message: string, status: number) =>
  new NextResponse(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });

export async function GET(req: NextRequest) {
  if (isCrossSiteBrowserRequest(req)) {
    return jsonError('Forbidden', 403);
  }
  if (!checkDownloadRateLimit(req)) {
    return jsonError('Too many requests', 429);
  }

  const url = req.nextUrl.searchParams.get('url');

  if (!url) {
    return jsonError('URL required', 400);
  }

  if (!isUrlAllowed(url)) {
    console.warn(`[Blocked] Download Proxy Attempt: ${url}`);
    return jsonError('Forbidden: Domain not allowed', 403);
  }

  try {
    const range = req.headers.get('range');
    let targetUrl = url;

    const fetchUpstream = async (candidateUrl: string) => {
      const headers = new Headers(getKhHeaders(candidateUrl));
      if (range) headers.set('Range', range);
      return fetch(candidateUrl, {
        headers,
        redirect: 'follow',
        signal: req.signal,
      });
    };

    let upstream: Response;
    try {
      upstream = await fetchUpstream(targetUrl);
    } catch (e: any) {
      const dnsFailure = e?.cause?.code === 'ENOTFOUND' || e?.code === 'ENOTFOUND';
      if (!dnsFailure) throw e;

      const parsed = new URL(targetUrl);
      if (parsed.hostname !== 'downloads.khinsider.com') throw e;

      const fallbackUrl = `${parsed.protocol}//khinsider.com${parsed.pathname}${parsed.search}`;
      console.warn(`Download Proxy DNS fallback: ${parsed.hostname} -> khinsider.com`);
      targetUrl = fallbackUrl;
      upstream = await fetchUpstream(fallbackUrl);
    }

    if (!upstream.ok && upstream.status !== 206) {
      return jsonError(`Upstream Error: ${upstream.status}`, upstream.status);
    }

    const resHeaders = new Headers(upstream.headers);
    resHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');
    resHeaders.set('X-Content-Type-Options', 'nosniff');
    if (!resHeaders.has('Cache-Control')) {
      resHeaders.set('Cache-Control', 'private, max-age=0, must-revalidate');
    }

    resHeaders.delete('Content-Encoding');
    resHeaders.delete('Content-Security-Policy');
    resHeaders.delete('X-Frame-Options');

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });

  } catch (e: any) {
    if (e.name === 'AbortError') return new NextResponse(null, { status: 408 });
    const dnsFailure = e?.cause?.code === 'ENOTFOUND' || e?.code === 'ENOTFOUND';
    if (dnsFailure) {
      console.warn(`Download Proxy DNS Error: ${e?.cause?.hostname || 'unknown-host'}`);
      return jsonError('Upstream DNS lookup failed', 502);
    }
    console.error("Download Proxy Error:", e);
    return jsonError('Download failed', 500);
  }
}
