import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

export const BASE_URL = 'https://downloads.khinsider.com';

export const ALLOWED_DOMAINS = [
  'khinsider.com',
  'downloads.khinsider.com',
  'images.khinsider.com',
  'soundtracks.khinsider.com',
  'vgmsite.com',
  'vgmtreasurechest.com',
];

export const isUrlAllowed = (urlStr: string | null | undefined): boolean => {
  if (!urlStr) return false;
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return ALLOWED_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );
  } catch (e) {
    return false;
  }
};


export const getKhHeaders = (targetUrl: string) => {
  const urlObj = new URL(targetUrl);
  const hostname = urlObj.hostname;

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
  };


  if (hostname.includes('vgmtreasurechest.com') || hostname.includes('vgmsite.com')) {

    headers['Referer'] = `https://${hostname}/`;
    headers['Origin'] = `https://${hostname}`;
    headers['Sec-Fetch-Site'] = 'same-origin';
  } else {
    headers['Referer'] = BASE_URL;
  }

  return headers;
};


export const FL_HEADERS = getKhHeaders(BASE_URL);

export const cleanText = (str: string | undefined | null) => {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim();
};

export const cheerioLoad = (html: string) => {
  return cheerio.load(html);
};

export const json = (data: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Cross-Origin-Resource-Policy')) headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new NextResponse(JSON.stringify(data), { ...init, headers });
};

const getErrorName = (error: any) => {
  const direct = String(error?.name || '').trim();
  if (direct) return direct;
  return String(error?.cause?.name || '').trim();
};

const getErrorMessage = (error: any) => {
  const direct = String(error?.message || '').trim();
  if (direct) return direct;
  return String(error?.cause?.message || '').trim();
};

const getNumericCode = (error: any) => {
  const direct = Number(error?.code);
  if (Number.isFinite(direct)) return direct;
  const cause = Number(error?.cause?.code);
  if (Number.isFinite(cause)) return cause;
  return null;
};

export const isTimeoutError = (error: any) => {
  const name = getErrorName(error);
  if (name === 'TimeoutError') return true;
  const code = getNumericCode(error);
  if (code === 23) return true;
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('timed out') || message.includes('aborted due to timeout');
};

export const isAbortError = (error: any) => {
  const name = getErrorName(error);
  if (name === 'AbortError') return true;
  const code = getNumericCode(error);
  if (code === 20) return true;
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('aborted');
};
