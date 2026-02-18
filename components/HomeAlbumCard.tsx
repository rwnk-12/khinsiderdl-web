import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { AutoScrollLabel } from './AutoScrollLabel';
import { Icon } from './Icon';

const HOME_CARD_IMAGE_SIZES = '(max-width: 640px) 46vw, (max-width: 1024px) 24vw, 200px';
const HOME_CARD_IMAGE_LOAD_TIMEOUT_MS = 12_000;
const HOME_CARD_PRELOAD_ROOT_MARGIN = '140px 0px';

const toSmallThumbUrl = (rawUrl: string) => {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    return value.includes('/thumbs_large/') ? value.replace('/thumbs_large/', '/thumbs_small/') : value;
};

type HomeAlbumCardProps = {
    title: string;
    imageUrl: string;
    artist?: string;
    metaLine?: string;
    lightweightTextMode?: boolean;
    priority?: boolean;
    showImage?: boolean;
    pageShowSignal?: number;
    onWarmup?: () => void;
    selectPayload?: unknown;
    onSelect: (payload?: unknown) => void;
};

export const HomeAlbumCard = React.memo(({
    title,
    imageUrl,
    artist,
    metaLine,
    lightweightTextMode = false,
    priority = false,
    showImage = true,
    pageShowSignal = 0,
    onWarmup,
    selectPayload,
    onSelect,
}: HomeAlbumCardProps) => {
    const cardRef = useRef<HTMLButtonElement | null>(null);
    const [isHovered, setIsHovered] = useState(false);
    const [rawImageSrc, setRawImageSrc] = useState(String(imageUrl || '').trim());
    const [isImageLoaded, setIsImageLoaded] = useState(false);
    const [hasEnteredViewport, setHasEnteredViewport] = useState(priority);
    const shouldAttemptImageLoad = showImage && (priority || hasEnteredViewport);

    useEffect(() => {
        setRawImageSrc(String(imageUrl || '').trim());
        setIsImageLoaded(false);
    }, [imageUrl]);

    useEffect(() => {
        if (!showImage || priority || hasEnteredViewport) return;

        const node = cardRef.current;
        if (!node) return;

        if (typeof IntersectionObserver === 'undefined') {
            setHasEnteredViewport(true);
            return;
        }

        const rootCandidate = node.closest('.panel-content');
        const root = rootCandidate instanceof HTMLElement ? rootCandidate : null;
        let didDisconnect = false;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry) return;
                if (!entry.isIntersecting && entry.intersectionRatio <= 0) return;
                if (didDisconnect) return;
                setHasEnteredViewport(true);
                observer.disconnect();
            },
            {
                root,
                rootMargin: HOME_CARD_PRELOAD_ROOT_MARGIN,
                threshold: 0.01,
            }
        );

        observer.observe(node);

        return () => {
            didDisconnect = true;
            observer.disconnect();
        };
    }, [hasEnteredViewport, priority, showImage]);

    const displayImageSrc = useMemo(() => {
        if (!rawImageSrc) return '';
        return rawImageSrc;
    }, [rawImageSrc]);

    useEffect(() => {
        if (!shouldAttemptImageLoad) {
            setIsImageLoaded(false);
            return;
        }
        setIsImageLoaded(false);
    }, [displayImageSrc, shouldAttemptImageLoad]);

    const handleImageError = useCallback(() => {
        const fallbackSmall = toSmallThumbUrl(rawImageSrc);
        if (fallbackSmall && fallbackSmall !== rawImageSrc) {
            setRawImageSrc(fallbackSmall);
            return;
        }
        setRawImageSrc('');
    }, [rawImageSrc]);

    const syncImageLoadedStateFromDom = useCallback(() => {
        if (!shouldAttemptImageLoad || !displayImageSrc) return;
        const node = cardRef.current?.querySelector<HTMLImageElement>('.home-album-card-image');
        if (!node || !node.complete) return;
        if (node.naturalWidth > 0) {
            setIsImageLoaded(true);
            return;
        }
        handleImageError();
    }, [displayImageSrc, handleImageError, shouldAttemptImageLoad]);

    useEffect(() => {
        if (!shouldAttemptImageLoad || !displayImageSrc || isImageLoaded) return;
        syncImageLoadedStateFromDom();
        const rafId = window.requestAnimationFrame(syncImageLoadedStateFromDom);
        return () => window.cancelAnimationFrame(rafId);
    }, [displayImageSrc, isImageLoaded, shouldAttemptImageLoad, syncImageLoadedStateFromDom]);

    useEffect(() => {
        if (!shouldAttemptImageLoad || !displayImageSrc) return;
        const rafId = window.requestAnimationFrame(syncImageLoadedStateFromDom);
        return () => window.cancelAnimationFrame(rafId);
    }, [displayImageSrc, pageShowSignal, shouldAttemptImageLoad, syncImageLoadedStateFromDom]);

    useEffect(() => {
        if (!shouldAttemptImageLoad || !displayImageSrc || isImageLoaded) return;
        const timeoutId = window.setTimeout(() => {
            const fallbackSmall = toSmallThumbUrl(rawImageSrc);
            if (fallbackSmall && fallbackSmall !== rawImageSrc) {
                setRawImageSrc(fallbackSmall);
                return;
            }
            setRawImageSrc('');
            setIsImageLoaded(true);
        }, HOME_CARD_IMAGE_LOAD_TIMEOUT_MS);

        return () => window.clearTimeout(timeoutId);
    }, [displayImageSrc, isImageLoaded, rawImageSrc, shouldAttemptImageLoad]);

    const warmup = () => {
        setHasEnteredViewport(true);
        if (onWarmup) onWarmup();
    };

    return (
        <button
            ref={cardRef}
            type="button"
            className="home-album-card"
            onMouseEnter={() => {
                setIsHovered(true);
                warmup();
            }}
            onMouseLeave={() => setIsHovered(false)}
            onFocus={() => {
                setIsHovered(true);
                warmup();
            }}
            onBlur={() => setIsHovered(false)}
            onClick={() => {
                warmup();
                onSelect(selectPayload);
            }}
        >
            <div className="home-album-card-art">
                {!shouldAttemptImageLoad ? (
                    <div className="home-album-card-shimmer" aria-hidden="true"></div>
                ) : displayImageSrc ? (
                    <Image
                        src={displayImageSrc}
                        alt=""
                        fill
                        className="home-album-card-image"
                        sizes={HOME_CARD_IMAGE_SIZES}
                        quality={75}
                        preload={priority}
                        loading={priority ? 'eager' : 'lazy'}
                        fetchPriority={priority ? 'high' : 'auto'}
                        onLoad={() => setIsImageLoaded(true)}
                        onError={() => {
                            setIsImageLoaded(true);
                            handleImageError();
                        }}
                        referrerPolicy="no-referrer"
                    />
                ) : (
                    <div className="home-album-card-art-fallback">
                        <Icon name="headphones" size={26} />
                    </div>
                )}
                {shouldAttemptImageLoad && !isImageLoaded && displayImageSrc ? (
                    <div className="home-album-card-shimmer is-overlay" aria-hidden="true"></div>
                ) : null}
            </div>
            <div className="home-album-card-copy">
                {lightweightTextMode ? (
                    <>
                        <span className="home-album-card-title home-album-card-title-static">{title}</span>
                        {artist ? <span className="home-album-card-artist home-album-card-line-static">{artist}</span> : null}
                        {metaLine ? <span className="home-album-card-meta home-album-card-line-static">{metaLine}</span> : null}
                    </>
                ) : (
                    <>
                        <AutoScrollLabel
                            text={title}
                            className="home-album-card-title"
                            forceHover={isHovered}
                        />
                        {artist ? <AutoScrollLabel text={artist} className="home-album-card-artist" /> : null}
                        {metaLine ? <AutoScrollLabel text={metaLine} className="home-album-card-meta" /> : null}
                    </>
                )}
            </div>
        </button>
    );
});

HomeAlbumCard.displayName = 'HomeAlbumCard';
