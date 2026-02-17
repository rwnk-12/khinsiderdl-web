export const isUrl = (str: string): boolean => {
    const urlPattern = /^(https?:\/\/)?(www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/.*)?$/;
    return urlPattern.test(str.trim());
};

const getErrorName = (error: any) => {
    const direct = String(error?.name || '').trim();
    if (direct) return direct;
    return String(error?.cause?.name || '').trim();
};

const getErrorCode = (error: any) => {
    const direct = Number(error?.code);
    if (Number.isFinite(direct)) return direct;
    const cause = Number(error?.cause?.code);
    if (Number.isFinite(cause)) return cause;
    return null;
};

const getErrorMessage = (error: any) => {
    const direct = String(error?.message || '').trim();
    if (direct) return direct;
    return String(error?.cause?.message || '').trim();
};

export const isTimeoutLikeError = (error: any) => {
    const name = getErrorName(error);
    if (name === 'TimeoutError') return true;
    const code = getErrorCode(error);
    if (code === 23) return true;
    const message = getErrorMessage(error).toLowerCase();
    return message.includes('timed out') || message.includes('aborted due to timeout');
};

export const isAbortLikeError = (error: any) => {
    const name = getErrorName(error);
    if (name === 'AbortError') return true;
    const code = getErrorCode(error);
    if (code === 20) return true;
    const message = getErrorMessage(error).toLowerCase();
    return message.includes('aborted');
};

export const extractPathFromUrl = (url: string): string => {
    try {
        const urlWithProtocol = url.startsWith('http') ? url : `https://${url}`;
        const urlObj = new URL(urlWithProtocol);
        return urlObj.pathname + urlObj.search + urlObj.hash;
    } catch {
        return url;
    }
};

export const toTitleCase = (str: string) => {
    return str ? str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()) : "";
};
