import React, { useRef, useState } from 'react';
import { AutoScrollLabel } from './AutoScrollLabel';
import { Icon } from './Icon';
import type { Track } from '../lib/app-types';
import { LruCache } from '../lib/lru-cache';

const SIMILAR_CARD_IMAGE_LOAD_TIMEOUT_MS = 12_000;

const similarAlbumMetaCache = new LruCache<string, { albumType?: string; year?: string }>(220);
const similarAlbumMetaPending = new Map<string, Promise<{ albumType?: string; year?: string }>>();

const readAlbumMeta = async (rawUrl: string) => {
    const url = String(rawUrl || '').trim();
    if (!url) return {};
    const cached = similarAlbumMetaCache.get(url);
    if (cached) return cached;
    if (similarAlbumMetaPending.has(url)) return similarAlbumMetaPending.get(url)!;

    const pending = fetch(`/api/album?url=${encodeURIComponent(url)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
            const next = {
                albumType: String(data?.albumType || '').trim() || undefined,
                year: String(data?.year || '').trim() || undefined,
            };
            similarAlbumMetaCache.set(url, next);
            return next;
        })
        .catch(() => ({}))
        .finally(() => {
            similarAlbumMetaPending.delete(url);
        });

    similarAlbumMetaPending.set(url, pending);
    return pending;
};

type SimilarAlbumCardProps = {
    album: Track & {
        thumb?: string;
        type?: string;
        albumType?: string;
        year?: string;
    };
    onSelect: (album: Track & { thumb?: string; type?: string; albumType?: string; year?: string }) => void;
    deferLoading?: boolean;
    pageShowSignal?: number;
};

export const SimilarAlbumCard = ({
    album,
    onSelect,
    deferLoading,
    pageShowSignal = 0,
}: SimilarAlbumCardProps) => {
    const cardRef = useRef<HTMLDivElement>(null);
    const [isHovered, setIsHovered] = useState(false);
    const [rawThumb, setRawThumb] = useState(String(album?.thumb || '').trim());
    const [useProxyFallback, setUseProxyFallback] = useState(false);
    const [isThumbLoaded, setIsThumbLoaded] = useState(false);
    const [hasEnteredViewport, setHasEnteredViewport] = useState(!deferLoading);
    const [resolvedMeta, setResolvedMeta] = useState<{ albumType?: string; year?: string }>({});

    const toProxyImageSrc = (rawUrl: string) => {
        const value = String(rawUrl || '').trim();
        if (!value) return '';
        if (value.startsWith('/api/image?url=')) return value;
        return `/api/image?url=${encodeURIComponent(value)}`;
    };

    const toSmallThumbUrl = (rawUrl: string) => {
        const value = String(rawUrl || '').trim();
        if (!value) return '';
        return value.includes('/thumbs_large/') ? value.replace('/thumbs_large/', '/thumbs_small/') : value;
    };

    React.useEffect(() => {
        setRawThumb(String(album?.thumb || '').trim());
        setUseProxyFallback(false);
        setIsThumbLoaded(false);
        if (!deferLoading) setHasEnteredViewport(true);
    }, [album?.thumb, deferLoading]);

    React.useEffect(() => {
        if (!deferLoading || hasEnteredViewport) return;
        const node = cardRef.current;
        if (!node) return;

        if (typeof IntersectionObserver === 'undefined') {
            setHasEnteredViewport(true);
            return;
        }

        const rootCandidate = node.closest('.panel-content');
        const root = rootCandidate instanceof HTMLElement ? rootCandidate : null;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry) return;
                if (!entry.isIntersecting && entry.intersectionRatio <= 0) return;
                setHasEnteredViewport(true);
                observer.disconnect();
            },
            {
                root,
                rootMargin: '120px 0px',
                threshold: 0.01,
            }
        );

        observer.observe(node);
        return () => observer.disconnect();
    }, [deferLoading, hasEnteredViewport]);

    const displayedThumb = React.useMemo(() => {
        if (!rawThumb) return '';
        return useProxyFallback ? toProxyImageSrc(rawThumb) : rawThumb;
    }, [rawThumb, useProxyFallback]);
    const shouldAttemptImageLoad = hasEnteredViewport && !!displayedThumb;

    React.useEffect(() => {
        if (!shouldAttemptImageLoad) {
            setIsThumbLoaded(false);
            return;
        }
        setIsThumbLoaded(false);
    }, [displayedThumb, shouldAttemptImageLoad]);

    React.useEffect(() => {
        const albumType = String(album?.albumType || album?.type || '').trim();
        const year = String(album?.year || '').trim();
        if (albumType || year || deferLoading) return;

        const url = String(album?.url || '').trim();
        if (!url) return;

        let cancelled = false;
        readAlbumMeta(url).then((meta) => {
            if (cancelled) return;
            setResolvedMeta(meta || {});
        });
        return () => {
            cancelled = true;
        };
    }, [album?.albumType, album?.type, album?.year, album?.url, deferLoading]);

    const handleImgError = React.useCallback(() => {
        if (!rawThumb) return;
        if (!useProxyFallback) {
            setUseProxyFallback(true);
            return;
        }
        const fallbackSmall = toSmallThumbUrl(rawThumb);
        if (fallbackSmall && fallbackSmall !== rawThumb) {
            setRawThumb(fallbackSmall);
            setUseProxyFallback(false);
            return;
        }
        setRawThumb('');
        setUseProxyFallback(false);
        setIsThumbLoaded(true);
    }, [rawThumb, useProxyFallback]);

    const syncThumbLoadedStateFromDom = React.useCallback(() => {
        if (!shouldAttemptImageLoad || !displayedThumb) return;
        const node = cardRef.current?.querySelector<HTMLImageElement>('.similar-album-card-image');
        if (!node || !node.complete) return;
        if (node.naturalWidth > 0) {
            setIsThumbLoaded(true);
            return;
        }
        handleImgError();
    }, [displayedThumb, handleImgError, shouldAttemptImageLoad]);

    React.useEffect(() => {
        if (!shouldAttemptImageLoad || !displayedThumb || isThumbLoaded) return;
        syncThumbLoadedStateFromDom();
        const rafId = window.requestAnimationFrame(syncThumbLoadedStateFromDom);
        return () => window.cancelAnimationFrame(rafId);
    }, [displayedThumb, isThumbLoaded, shouldAttemptImageLoad, syncThumbLoadedStateFromDom]);

    React.useEffect(() => {
        if (!shouldAttemptImageLoad || !displayedThumb) return;
        const rafId = window.requestAnimationFrame(syncThumbLoadedStateFromDom);
        return () => window.cancelAnimationFrame(rafId);
    }, [displayedThumb, pageShowSignal, shouldAttemptImageLoad, syncThumbLoadedStateFromDom]);

    React.useEffect(() => {
        if (!shouldAttemptImageLoad || !displayedThumb || isThumbLoaded) return;
        const timeoutId = window.setTimeout(() => {
            if (!useProxyFallback) {
                setUseProxyFallback(true);
                return;
            }
            const fallbackSmall = toSmallThumbUrl(rawThumb);
            if (fallbackSmall && fallbackSmall !== rawThumb) {
                setRawThumb(fallbackSmall);
                setUseProxyFallback(false);
                return;
            }
            setRawThumb('');
            setUseProxyFallback(false);
            setIsThumbLoaded(true);
        }, SIMILAR_CARD_IMAGE_LOAD_TIMEOUT_MS);
        return () => window.clearTimeout(timeoutId);
    }, [displayedThumb, isThumbLoaded, rawThumb, shouldAttemptImageLoad, useProxyFallback]);

    const albumType = String(album?.albumType || album?.type || resolvedMeta.albumType || '').trim();
    const year = String(album?.year || resolvedMeta.year || '').trim();

    return (
        <div
            ref={cardRef}
            className="home-album-card album-card-mini"
            onClick={() => onSelect(album)}
        >
            <div
                className="home-album-card-art similar-album-card-art"
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                {!shouldAttemptImageLoad ? (
                    <div className="home-album-card-shimmer" aria-hidden="true"></div>
                ) : displayedThumb ? (
                    <img
                        src={displayedThumb}
                        className="similar-album-card-image"
                        referrerPolicy="no-referrer"
                        onError={handleImgError}
                        onLoad={() => setIsThumbLoaded(true)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        fetchPriority="low"
                    />
                ) : (
                    <div className="home-album-card-art-fallback">
                        <Icon name="headphones" size={26} />
                    </div>
                )}
                {shouldAttemptImageLoad && !isThumbLoaded && displayedThumb ? (
                    <div className="home-album-card-shimmer is-overlay" aria-hidden="true"></div>
                ) : null}
            </div>
            <div className="home-album-card-copy">
                <AutoScrollLabel
                    text={album.title}
                    className="home-album-card-title"
                    forceHover={isHovered}
                />
                {albumType && (
                    <AutoScrollLabel
                        text={albumType}
                        className="home-album-card-artist"
                    />
                )}
                {year && (
                    <AutoScrollLabel
                        text={year}
                        className="home-album-card-meta"
                    />
                )}
            </div>
        </div>
    );
};
