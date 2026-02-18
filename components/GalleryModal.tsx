import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

const GALLERY_INITIAL_RENDER_COUNT = 12;
const GALLERY_RENDER_CHUNK = 12;
const GALLERY_VIRTUALIZATION_MIN_ITEMS = 100;
const GALLERY_VIRTUAL_OVERSCAN_ROWS = 2;
const GALLERY_ITEM_MIN_WIDTH = 180;
const GALLERY_GRID_GAP_PX = 20;
const GALLERY_ITEM_META_HEIGHT = 30;
const GALLERY_FULL_RES_EXTRA_ROWS = 2;

const buildCandidates = (primary: string, secondary: string) => {
    const list = [primary, secondary]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    const deduped: string[] = [];
    const seen = new Set<string>();
    list.forEach((value) => {
        if (seen.has(value)) return;
        seen.add(value);
        deduped.push(value);
    });
    return deduped;
};

type GalleryEntry = {
    id: string;
    full: string;
    thumb: string;
};

export type GalleryModalProps = {
    images: string[];
    thumbs?: string[];
    onClose: () => void;
    initialIndex?: number;
    onFirstImageLoaded?: () => void;
};

export const GalleryModal = ({
    images,
    thumbs = [],
    onClose,
    initialIndex = 0,
    onFirstImageLoaded,
}: GalleryModalProps) => {
    const normalizedEntries = useMemo(() => {
        const source = Array.isArray(images) ? images : [];
        return source
            .map((rawImage, index) => {
                const full = String(rawImage || '').trim();
                const thumb = String(thumbs[index] || '').trim();
                const normalizedFull = full || thumb;
                if (!normalizedFull) return null;
                return {
                    id: `${index}:${normalizedFull}`,
                    full: normalizedFull,
                    thumb: thumb || normalizedFull,
                } satisfies GalleryEntry;
            })
            .filter(Boolean) as GalleryEntry[];
    }, [images, thumbs]);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    const loadMorePendingRef = useRef(false);
    const loadMoreIdleHandleRef = useRef<number | null>(null);
    const loadMoreTimeoutRef = useRef<number | null>(null);
    const firstImageReportedRef = useRef(false);
    const scrollRafRef = useRef<number | null>(null);

    const [renderCount, setRenderCount] = useState(() =>
        Math.min(normalizedEntries.length, GALLERY_INITIAL_RENDER_COUNT)
    );
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [gridColumns, setGridColumns] = useState(1);
    const [gridRowHeight, setGridRowHeight] = useState(GALLERY_ITEM_MIN_WIDTH + GALLERY_ITEM_META_HEIGHT);
    const [candidateStepByKey, setCandidateStepByKey] = useState<Record<string, number>>({});
    const [loadedByKey, setLoadedByKey] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setRenderCount(Math.min(normalizedEntries.length, GALLERY_INITIAL_RENDER_COUNT));
        setScrollTop(0);
        setViewportHeight(0);
        setCandidateStepByKey({});
        setLoadedByKey({});
        firstImageReportedRef.current = false;
    }, [normalizedEntries.length]);

    const clearLoadMoreScheduler = useCallback(() => {
        if (typeof window === 'undefined') return;
        const win = window as any;
        if (loadMoreIdleHandleRef.current != null && typeof win.cancelIdleCallback === 'function') {
            win.cancelIdleCallback(loadMoreIdleHandleRef.current);
            loadMoreIdleHandleRef.current = null;
        }
        if (loadMoreTimeoutRef.current != null) {
            window.clearTimeout(loadMoreTimeoutRef.current);
            loadMoreTimeoutRef.current = null;
        }
        loadMorePendingRef.current = false;
    }, []);

    const scheduleLoadMore = useCallback(() => {
        if (typeof window === 'undefined') return;
        if (loadMorePendingRef.current) return;
        loadMorePendingRef.current = true;

        const commit = () => {
            loadMorePendingRef.current = false;
            setRenderCount((prev) => Math.min(normalizedEntries.length, prev + GALLERY_RENDER_CHUNK));
        };

        const win = window as any;
        if (typeof win.requestIdleCallback === 'function') {
            loadMoreIdleHandleRef.current = win.requestIdleCallback(() => {
                loadMoreIdleHandleRef.current = null;
                commit();
            }, { timeout: 120 });
            return;
        }

        loadMoreTimeoutRef.current = window.setTimeout(() => {
            loadMoreTimeoutRef.current = null;
            commit();
        }, 34);
    }, [normalizedEntries.length]);

    useEffect(() => clearLoadMoreScheduler, [clearLoadMoreScheduler]);

    useEffect(() => {
        if (renderCount >= normalizedEntries.length) return;
        const root = scrollRef.current;
        const target = loadMoreRef.current;
        if (!root || !target || typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry?.isIntersecting) return;
                scheduleLoadMore();
            },
            {
                root,
                rootMargin: '640px 0px',
                threshold: 0.01,
            }
        );

        observer.observe(target);
        return () => observer.disconnect();
    }, [normalizedEntries.length, renderCount, scheduleLoadMore]);

    const measureGrid = useCallback(() => {
        const root = scrollRef.current;
        if (!root) return;

        const nextViewportHeight = Math.max(0, root.clientHeight);
        const width = Math.max(0, root.clientWidth);
        const nextColumns = Math.max(
            1,
            Math.floor((width + GALLERY_GRID_GAP_PX) / (GALLERY_ITEM_MIN_WIDTH + GALLERY_GRID_GAP_PX))
        );
        const usableWidth = Math.max(1, width - ((nextColumns - 1) * GALLERY_GRID_GAP_PX));
        const cardWidth = usableWidth / nextColumns;
        const nextRowHeight = Math.max(1, Math.round(cardWidth + GALLERY_ITEM_META_HEIGHT));

        setViewportHeight((prev) => (prev === nextViewportHeight ? prev : nextViewportHeight));
        setGridColumns((prev) => (prev === nextColumns ? prev : nextColumns));
        setGridRowHeight((prev) => (Math.abs(prev - nextRowHeight) < 1 ? prev : nextRowHeight));
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        measureGrid();
        const root = scrollRef.current;
        if (!root) return;

        const onScroll = () => {
            if (scrollRafRef.current != null) return;
            scrollRafRef.current = window.requestAnimationFrame(() => {
                scrollRafRef.current = null;
                setScrollTop(root.scrollTop);
                setViewportHeight((prev) => (prev === root.clientHeight ? prev : root.clientHeight));
            });
        };

        root.addEventListener('scroll', onScroll, { passive: true });

        const onResize = () => measureGrid();
        window.addEventListener('resize', onResize);

        let resizeObserver: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => measureGrid());
            resizeObserver.observe(root);
        }

        return () => {
            root.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onResize);
            resizeObserver?.disconnect();
            if (scrollRafRef.current != null) {
                window.cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = null;
            }
        };
    }, [measureGrid]);

    const renderedEntries = useMemo(
        () => normalizedEntries.slice(0, Math.max(0, Math.min(renderCount, normalizedEntries.length))),
        [normalizedEntries, renderCount]
    );

    const shouldVirtualize = renderedEntries.length >= GALLERY_VIRTUALIZATION_MIN_ITEMS;

    const virtualRange = useMemo(() => {
        if (!shouldVirtualize) {
            return {
                start: 0,
                end: Math.max(0, renderedEntries.length - 1),
                topPadding: 0,
                bottomPadding: 0,
            };
        }

        const total = renderedEntries.length;
        if (total === 0) {
            return { start: 0, end: -1, topPadding: 0, bottomPadding: 0 };
        }

        const rowHeight = Math.max(1, gridRowHeight);
        const columns = Math.max(1, gridColumns);
        const totalRows = Math.ceil(total / columns);
        const viewportStartRow = Math.floor(Math.max(0, scrollTop) / rowHeight);
        const viewportEndRow = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight);

        const startRow = Math.max(0, viewportStartRow - GALLERY_VIRTUAL_OVERSCAN_ROWS);
        const endRow = Math.min(totalRows - 1, viewportEndRow + GALLERY_VIRTUAL_OVERSCAN_ROWS);

        const start = Math.max(0, Math.min(total - 1, startRow * columns));
        const end = Math.max(start, Math.min(total - 1, ((endRow + 1) * columns) - 1));

        const topPadding = startRow * rowHeight;
        const rowsAfter = Math.max(0, totalRows - (endRow + 1));
        const bottomPadding = rowsAfter * rowHeight;

        return { start, end, topPadding, bottomPadding };
    }, [gridColumns, gridRowHeight, renderedEntries.length, scrollTop, shouldVirtualize, viewportHeight]);

    const visibleItems = useMemo(() => {
        const indexed = renderedEntries.map((entry, index) => ({ entry, index }));
        if (!shouldVirtualize) return indexed;
        if (virtualRange.end < virtualRange.start) return [];
        return indexed.slice(virtualRange.start, virtualRange.end + 1);
    }, [renderedEntries, shouldVirtualize, virtualRange.end, virtualRange.start]);

    const fullResRange = useMemo(() => {
        const columns = Math.max(1, gridColumns);
        const extraItems = columns * GALLERY_FULL_RES_EXTRA_ROWS;
        const baseStart = shouldVirtualize ? virtualRange.start : 0;
        const baseEnd = shouldVirtualize ? virtualRange.end : Math.max(0, renderedEntries.length - 1);
        return {
            start: Math.max(0, baseStart - extraItems),
            end: Math.min(Math.max(0, renderedEntries.length - 1), baseEnd + extraItems),
        };
    }, [gridColumns, renderedEntries.length, shouldVirtualize, virtualRange.end, virtualRange.start]);

    const getSourceStateKey = useCallback((index: number, preferFull: boolean) => {
        return `${index}:${preferFull ? 'full' : 'thumb'}`;
    }, []);

    const reportFirstImageLoaded = useCallback(() => {
        if (firstImageReportedRef.current) return;
        firstImageReportedRef.current = true;
        onFirstImageLoaded?.();
    }, [onFirstImageLoaded]);

    const handleImageLoad = useCallback((stateKey: string) => {
        setLoadedByKey((prev) => (prev[stateKey] ? prev : { ...prev, [stateKey]: true }));
        reportFirstImageLoaded();
    }, [reportFirstImageLoaded]);

    const handleImageError = useCallback((stateKey: string) => {
        setLoadedByKey((prev) => ({ ...prev, [stateKey]: false }));
        setCandidateStepByKey((prev) => ({ ...prev, [stateKey]: (prev[stateKey] || 0) + 1 }));
    }, []);

    return (
        <div className="gallery-modal-shell">
            <div className="gallery-header">
                <h3 className="f-header" style={{ margin: 0, color: '#c5a059' }}>Gallery</h3>
                <button className="btn-mini" onClick={onClose} aria-label="Close gallery">
                    <Icon name="close" />
                </button>
            </div>

            <div className="gallery-grid-scroll" ref={scrollRef}>
                <div className="gallery-grid">
                    {shouldVirtualize && virtualRange.topPadding > 0 ? (
                        <div
                            className="gallery-virtual-spacer"
                            style={{ gridColumn: '1 / -1', height: `${virtualRange.topPadding}px` }}
                        ></div>
                    ) : null}

                    {visibleItems.map(({ entry, index }) => {
                        const preferFull =
                            index === initialIndex ||
                            !entry.thumb ||
                            index >= fullResRange.start && index <= fullResRange.end;
                        const sourceKey = getSourceStateKey(index, preferFull);
                        const primary = preferFull ? entry.full : (entry.thumb || entry.full);
                        const secondary = preferFull ? (entry.thumb || '') : entry.full;
                        const candidates = buildCandidates(primary, secondary);
                        const step = candidateStepByKey[sourceKey] || 0;
                        const activeSrc = candidates[step] || '';
                        const isLoaded = !!loadedByKey[sourceKey];

                        return (
                            <div key={entry.id} className="gallery-item">
                                <div className="gallery-item-art">
                                    {activeSrc ? (
                                        <img
                                            src={activeSrc}
                                            referrerPolicy="no-referrer"
                                            alt={`Full cover art ${index + 1}`}
                                            loading={index < 6 ? 'eager' : 'lazy'}
                                            decoding={index < 6 ? 'sync' : 'async'}
                                            onLoad={() => handleImageLoad(sourceKey)}
                                            onError={() => handleImageError(sourceKey)}
                                        />
                                    ) : (
                                        <div className="gallery-item-fallback">
                                            <Icon name="headphones" size={28} />
                                        </div>
                                    )}
                                    {activeSrc && !isLoaded ? (
                                        <div className="home-album-card-shimmer is-overlay" aria-hidden="true"></div>
                                    ) : null}
                                </div>
                                <span>Cover {index + 1}</span>
                            </div>
                        );
                    })}

                    {shouldVirtualize && virtualRange.bottomPadding > 0 ? (
                        <div
                            className="gallery-virtual-spacer"
                            style={{ gridColumn: '1 / -1', height: `${virtualRange.bottomPadding}px` }}
                        ></div>
                    ) : null}

                    {renderCount < normalizedEntries.length ? (
                        <div
                            ref={loadMoreRef}
                            className="gallery-load-sentinel"
                            aria-hidden="true"
                            style={{ gridColumn: '1 / -1', height: '1px' }}
                        ></div>
                    ) : null}
                </div>
            </div>
        </div>
    );
};
