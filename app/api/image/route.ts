import { getKhHeaders, isUrlAllowed, isAbortError, isTimeoutError } from '../_shared/khinsider';

export const runtime = 'nodejs';
const IMAGE_FETCH_TIMEOUT_MS = 60_000;
const IMAGE_RATE_WINDOW_MS = 60_000;
const IMAGE_RATE_MAX_REQUESTS = 600;
const imageRateBuckets = new Map<string, number[]>();

const getClientIp = (request: Request) => {
  const cfIp = String(request.headers.get('cf-connecting-ip') || '').trim();
  if (cfIp) return cfIp;
  const forwarded = String(request.headers.get('x-forwarded-for') || '').trim();
  if (forwarded) return forwarded.split(',')[0].trim() || 'unknown';
  const realIp = String(request.headers.get('x-real-ip') || '').trim();
  if (realIp) return realIp;
  return 'unknown';
};

const isCrossSiteBrowserRequest = (request: Request) => {
  const secFetchSite = String(request.headers.get('sec-fetch-site') || '').trim().toLowerCase();
  return secFetchSite === 'cross-site';
};

const checkImageRateLimit = (request: Request) => {
  const ip = getClientIp(request);
  const now = Date.now();
  const windowStart = now - IMAGE_RATE_WINDOW_MS;
  const history = (imageRateBuckets.get(ip) || []).filter((timestamp) => timestamp > windowStart);
  if (history.length >= IMAGE_RATE_MAX_REQUESTS) {
    imageRateBuckets.set(ip, history);
    return false;
  }
  history.push(now);
  imageRateBuckets.set(ip, history);

  if (imageRateBuckets.size > 8000) {
    for (const [key, timestamps] of imageRateBuckets.entries()) {
      const trimmed = timestamps.filter((timestamp) => timestamp > windowStart);
      if (trimmed.length === 0) imageRateBuckets.delete(key);
      else imageRateBuckets.set(key, trimmed);
    }
  }
  return true;
};

const buildErrorResponse = (message: string, status: number) => {
  return new Response(message, {
    status,
    headers: {
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
};

export async function GET(request: Request) {
  if (isCrossSiteBrowserRequest(request)) {
    return buildErrorResponse('Forbidden', 403);
  }
  if (!checkImageRateLimit(request)) {
    return buildErrorResponse('Too many requests', 429);
  }

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) return new Response('No URL', { status: 400 });

  if (!isUrlAllowed(url)) {
    return new Response('Forbidden: Domain not allowed', { status: 403 });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException('The image request timed out', 'TimeoutError'));
    }, IMAGE_FETCH_TIMEOUT_MS);
    const onRequestAbort = () => {
      controller.abort(request.signal.reason || new DOMException('The request was aborted', 'AbortError'));
    };

    if (request.signal.aborted) {
      onRequestAbort();
    } else {
      request.signal.addEventListener('abort', onRequestAbort, { once: true });
    }

    try {
      const imgRes = await fetch(url, {
        headers: getKhHeaders(url),
        signal: controller.signal
      });

      if (!imgRes.ok) return buildErrorResponse('Image fetch failed', imgRes.status);

      return new Response(imgRes.body, {
        headers: {
          'Content-Type': imgRes.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'public, max-age=604800, immutable',
          'Vary': 'Accept',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } finally {
      clearTimeout(timeoutId);
      request.signal.removeEventListener('abort', onRequestAbort);
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      console.warn(`Image Proxy Timeout after ${IMAGE_FETCH_TIMEOUT_MS}ms: ${url}`);
      return buildErrorResponse('Image fetch timed out', 504);
    }
    if (isAbortError(error) || request.signal.aborted) {
      return buildErrorResponse('Request cancelled', 408);
    }
    console.error("Image Proxy Error:", error);
    return buildErrorResponse('Internal Server Error', 500);
  }
}
