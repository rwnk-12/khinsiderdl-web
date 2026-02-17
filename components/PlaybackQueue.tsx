import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Icon } from './Icon';

const QUEUE_VIRTUALIZATION_MIN_ITEMS = 24;
const QUEUE_VIRTUALIZATION_OVERSCAN_ROWS = 8;
const QUEUE_VIRTUALIZATION_ROW_HEIGHT_ESTIMATE = 66;

type AutoScrollMode = 'instant' | 'smooth' | 'off';

export type QueueEntry = {
    track: any;
    index: number;
    isActive: boolean;
    identityKey: string;
};

export type QueueDerivedSnapshot = {
    activeIndex: number;
    manualEntries: QueueEntry[];
    contextEntries: QueueEntry[];
    total: number;
};

interface PlaybackQueueProps {
    queue: any[];
    currentTrack: any;
    onPlayTrack: (track: any, index: number) => void;
    onRemoveTrack?: (index: number) => void;
    onClearManual?: () => void;
    onClearAlbum?: () => void;
    sourceLabel?: string;
    onAddToPlaylist?: (track: any) => void;
    onAddManualQueueToPlaylist?: () => void;
    isPlaylistRecentlyAdded?: (track: any) => boolean;
    isOpen?: boolean;
    autoScrollMode?: AutoScrollMode;
    derivedSnapshot?: QueueDerivedSnapshot;
    onFirstRowPainted?: () => void;
}

type QueueRowProps = {
    entry: QueueEntry;
    safeActiveIndex: number;
    onPlayTrack: (track: any, index: number) => void;
    onRemoveTrack?: (index: number) => void;
    onAddToPlaylist?: (track: any) => void;
    isPlaylistRecentlyAdded?: (track: any) => boolean;
    activeRef: React.MutableRefObject<HTMLDivElement | null>;
};

const toScrollBehavior = (mode: AutoScrollMode): ScrollBehavior => {
    if (mode === 'smooth') return 'smooth';
    return 'auto';
};

const toTrackMatchKey = (track: any) => {
    const key = String(track?.trackKey || track?.url || '').trim();
    if (key) return key.toLowerCase();
    const title = String(track?.title || '').trim().toLowerCase();
    const album = String(track?.albumName || '').trim().toLowerCase();
    if (!title && !album) return '';
    return `${title}|${album}`;
};

const isSameQueueTrack = (a: any, b: any) => {
    const aKey = toTrackMatchKey(a);
    const bKey = toTrackMatchKey(b);
    if (aKey && bKey) return aKey === bKey;
    return false;
};

const buildQueueIdentityKey = (track: any, index: number) => {
    const base = String(track?.trackKey || track?.url || '').trim();
    if (base) return `${base}::${index}`;
    const title = String(track?.title || '').trim();
    const album = String(track?.albumName || '').trim();
    return `${title}|${album}::${index}`;
};

const QueueRow = React.memo(({
    entry,
    safeActiveIndex,
    onPlayTrack,
    onRemoveTrack,
    onAddToPlaylist,
    isPlaylistRecentlyAdded,
    activeRef,
}: QueueRowProps) => {
    const canRemove = !!onRemoveTrack && entry.index > safeActiveIndex;
    const recentlyAdded = !!isPlaylistRecentlyAdded?.(entry.track);
    const artworkSrc = String(entry.track?.thumbnail || entry.track?.albumArt || '').trim();

    return (
        <div
            ref={(node) => {
                if (!entry.isActive) return;
                activeRef.current = node;
            }}
            className={`pq-item ${entry.isActive ? 'active' : ''}`}
            onClick={() => onPlayTrack(entry.track, entry.index)}
        >
            <div className="pq-item-art">
                {artworkSrc ? (
                    <img
                        src={artworkSrc}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                    />
                ) : (
                    <div className="pq-art-placeholder">
                        <Icon name="headphones" size={14} />
                    </div>
                )}
                {entry.isActive ? (
                    <div className="pq-active-indicator">
                        <Icon name="volume" size={12} />
                    </div>
                ) : null}
            </div>
            <div className="pq-item-info">
                <div className="pq-item-title">{entry.track.title}</div>
                <div className="pq-item-artist">{entry.track.albumName || 'Unknown Album'}</div>
            </div>
            <div className="pq-item-dur">{entry.track.duration || ''}</div>
            {onAddToPlaylist ? (
                <button
                    type="button"
                    className={`pq-remove-btn ${recentlyAdded ? 'is-feedback' : ''}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        onAddToPlaylist(entry.track);
                    }}
                    aria-label="Add to playlist"
                    title={recentlyAdded ? 'Added to playlist' : 'Add to playlist'}
                >
                    <Icon name={recentlyAdded ? 'doubleCheck' : 'plus'} size={13} />
                </button>
            ) : null}
            {canRemove ? (
                <button
                    type="button"
                    className="pq-remove-btn"
                    onClick={(event) => {
                        event.stopPropagation();
                        onRemoveTrack?.(entry.index);
                    }}
                    aria-label="Remove from queue"
                    title="Remove from queue"
                >
                    <Icon name="close" size={12} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => {
    return (
        prev.entry.identityKey === next.entry.identityKey &&
        prev.entry.isActive === next.entry.isActive &&
        prev.safeActiveIndex === next.safeActiveIndex &&
        prev.onPlayTrack === next.onPlayTrack &&
        prev.onRemoveTrack === next.onRemoveTrack &&
        prev.onAddToPlaylist === next.onAddToPlaylist &&
        prev.isPlaylistRecentlyAdded === next.isPlaylistRecentlyAdded
    );
});

QueueRow.displayName = 'QueueRow';

export const PlaybackQueue: React.FC<PlaybackQueueProps> = React.memo(({
    queue,
    currentTrack,
    onPlayTrack,
    onRemoveTrack,
    onClearManual,
    onClearAlbum,
    sourceLabel,
    onAddToPlaylist,
    onAddManualQueueToPlaylist,
    isPlaylistRecentlyAdded,
    isOpen = false,
    autoScrollMode = 'instant',
    derivedSnapshot,
    onFirstRowPainted,
}) => {
    const activeRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const lastOpenRef = useRef<boolean>(isOpen);
    const hasAutoScrolledForOpenRef = useRef(false);
    const hasReportedFirstRowForOpenRef = useRef(false);

    const [selectedPane, setSelectedPane] = useState<'manual' | 'context'>(
        currentTrack?.queueSource === 'manual' ? 'manual' : 'context'
    );

    useEffect(() => {
        if (isOpen && !lastOpenRef.current) {
            hasAutoScrolledForOpenRef.current = false;
            hasReportedFirstRowForOpenRef.current = false;
        }
        if (!isOpen) {
            hasAutoScrolledForOpenRef.current = false;
            hasReportedFirstRowForOpenRef.current = false;
        }
        lastOpenRef.current = isOpen;
    }, [isOpen]);

    const queueItems = Array.isArray(queue) ? queue : [];

    const localDerived = useMemo(() => {
        let activeIndex = -1;
        if (currentTrack) {
            for (let index = 0; index < queueItems.length; index += 1) {
                if (!isSameQueueTrack(queueItems[index], currentTrack)) continue;
                activeIndex = index;
                break;
            }
        }

        const safeActiveIndex = activeIndex >= 0 ? activeIndex : 0;
        const manualEntries: QueueEntry[] = [];
        const contextEntries: QueueEntry[] = [];

        for (let index = 0; index < queueItems.length; index += 1) {
            const track = queueItems[index];
            const entry: QueueEntry = {
                track,
                index,
                isActive: index === safeActiveIndex,
                identityKey: buildQueueIdentityKey(track, index),
            };
            if (track?.queueSource === 'manual') {
                manualEntries.push(entry);
            } else {
                contextEntries.push(entry);
            }
        }

        return {
            activeIndex,
            safeActiveIndex,
            manualEntries,
            contextEntries,
            total: queueItems.length,
            currentItem: queueItems[safeActiveIndex] || currentTrack || queueItems[0] || null,
        };
    }, [currentTrack, queueItems]);

    const activeIndex = typeof derivedSnapshot?.activeIndex === 'number'
        ? derivedSnapshot.activeIndex
        : localDerived.activeIndex;
    const safeActiveIndex = activeIndex >= 0 ? activeIndex : 0;
    const manualEntries = derivedSnapshot?.manualEntries || localDerived.manualEntries;
    const contextEntries = derivedSnapshot?.contextEntries || localDerived.contextEntries;
    const totalEntries = typeof derivedSnapshot?.total === 'number' ? derivedSnapshot.total : localDerived.total;
    const currentItem = queueItems[safeActiveIndex] || localDerived.currentItem;

    const currentContextKind = currentItem?.queueSource === 'playlist' ? 'Playlist' : 'Album';
    const hasManual = manualEntries.length > 0;
    const hasContext = contextEntries.length > 0;

    useEffect(() => {
        if (!isOpen) return;
        const preferredPane: 'manual' | 'context' = currentItem?.queueSource === 'manual' ? 'manual' : 'context';
        setSelectedPane((prev) => (prev === preferredPane ? prev : preferredPane));
    }, [currentItem?.queueSource, isOpen]);

    useEffect(() => {
        if (selectedPane === 'manual' && !hasManual && hasContext) {
            setSelectedPane('context');
            return;
        }
        if (selectedPane === 'context' && !hasContext && hasManual) {
            setSelectedPane('manual');
            return;
        }
        if (!hasManual && hasContext) {
            setSelectedPane('context');
            return;
        }
        if (!hasContext && hasManual) {
            setSelectedPane('manual');
            return;
        }
    }, [hasContext, hasManual, selectedPane]);

    const activeEntries = selectedPane === 'manual' ? manualEntries : contextEntries;
    const activePaneIndex = useMemo(() => activeEntries.findIndex((entry) => entry.isActive), [activeEntries]);
    const shouldVirtualize = activeEntries.length >= QUEUE_VIRTUALIZATION_MIN_ITEMS;

    const rowVirtualizer = useVirtualizer({
        count: activeEntries.length,
        getScrollElement: () => listRef.current,
        estimateSize: () => QUEUE_VIRTUALIZATION_ROW_HEIGHT_ESTIMATE,
        overscan: QUEUE_VIRTUALIZATION_OVERSCAN_ROWS,
        enabled: shouldVirtualize && isOpen,
        getItemKey: (index) => activeEntries[index]?.identityKey || String(index),
    });

    const virtualItems = rowVirtualizer.getVirtualItems();

    useEffect(() => {
        if (!isOpen) return;
        if (hasReportedFirstRowForOpenRef.current) return;
        if (activeEntries.length === 0) return;

        const rafId = window.requestAnimationFrame(() => {
            if (hasReportedFirstRowForOpenRef.current) return;
            hasReportedFirstRowForOpenRef.current = true;
            onFirstRowPainted?.();
        });

        return () => window.cancelAnimationFrame(rafId);
    }, [activeEntries.length, isOpen, onFirstRowPainted]);

    useEffect(() => {
        if (!isOpen) return;
        if (autoScrollMode === 'off') return;
        if (hasAutoScrolledForOpenRef.current) return;
        if (activePaneIndex < 0) return;

        const rafId = window.requestAnimationFrame(() => {
            const root = listRef.current;
            if (!root) return;

            if (shouldVirtualize) {
                rowVirtualizer.scrollToIndex(activePaneIndex, {
                    align: 'center',
                    behavior: autoScrollMode === 'smooth' ? 'smooth' : 'auto',
                });
                hasAutoScrolledForOpenRef.current = true;
                return;
            }

            const node = activeRef.current;
            if (!node) return;
            node.scrollIntoView({ behavior: toScrollBehavior(autoScrollMode), block: 'center' });
            hasAutoScrolledForOpenRef.current = true;
        });

        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [
        activePaneIndex,
        autoScrollMode,
        isOpen,
        rowVirtualizer,
        shouldVirtualize,
    ]);

    const canClearActive = selectedPane === 'manual'
        ? (!!onClearManual && activeEntries.length > 0)
        : (!!onClearAlbum && activeEntries.length > 0);
    const canAddManualQueue = !!onAddManualQueueToPlaylist && selectedPane === 'manual' && manualEntries.length > 0;
    const clearActive = () => {
        if (selectedPane === 'manual') {
            onClearManual?.();
            return;
        }
        onClearAlbum?.();
    };

    if (totalEntries === 0) {
        return (
            <div className="pq-empty">
                <Icon name="list" size={48} />
                <p>Queue is empty</p>
                <span>Play an album or track to start</span>
            </div>
        );
    }

    return (
        <div className="pq-container medieval-scroll">
            <h3 className="pq-header">
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="pq-title">Now Playing</span>
                    {sourceLabel ? <span className="pq-source">{sourceLabel}</span> : null}
                    {currentItem ? (
                        <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px', fontFamily: 'Mate SC' }}>
                            {currentItem.albumName || 'Unknown Album'}
                        </span>
                    ) : null}
                </div>
                <div className="pq-header-actions">
                    <span className="pq-count">{totalEntries} Tracks</span>
                </div>
            </h3>

            <div className="pq-pane-tabs">
                <button
                    type="button"
                    className={`pq-pane-tab ${selectedPane === 'manual' ? 'active' : ''}`}
                    onClick={() => setSelectedPane('manual')}
                >
                    Manual Queue ({manualEntries.length})
                </button>
                <button
                    type="button"
                    className={`pq-pane-tab ${selectedPane === 'context' ? 'active' : ''}`}
                    onClick={() => setSelectedPane('context')}
                >
                    Context Queue ({contextEntries.length})
                </button>
            </div>

            <div className="pq-list" ref={listRef}>
                <div className="pq-subheader">
                    <span>
                        {selectedPane === 'manual'
                            ? 'Manual Queue'
                            : `Context Queue - ${currentContextKind}`}
                    </span>
                    {(canAddManualQueue || canClearActive) ? (
                        <div className="pq-subheader-actions">
                            {canAddManualQueue ? (
                                <button
                                    type="button"
                                    className="pq-add-playlist-btn"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onAddManualQueueToPlaylist?.();
                                    }}
                                    title="Add all manual queue tracks to playlist"
                                    aria-label="Add all manual queue tracks to playlist"
                                >
                                    <Icon name="plus" size={11} />
                                    Add Queue
                                </button>
                            ) : null}
                            {canClearActive ? (
                                <button
                                    type="button"
                                    className="pq-clear-btn"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        clearActive();
                                    }}
                                >
                                    Clear
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>

                {activeEntries.length === 0 ? (
                    <div className="pq-empty-sub">No tracks in this queue.</div>
                ) : shouldVirtualize ? (
                    <div className="pq-virtual-window" style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
                        {virtualItems.map((virtualItem) => {
                            const entry = activeEntries[virtualItem.index];
                            if (!entry) return null;
                            return (
                                <div
                                    key={entry.identityKey}
                                    data-index={virtualItem.index}
                                    className="pq-virtual-row"
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        transform: `translateY(${virtualItem.start}px)`,
                                    }}
                                >
                                    <QueueRow
                                        entry={entry}
                                        safeActiveIndex={safeActiveIndex}
                                        onPlayTrack={onPlayTrack}
                                        onRemoveTrack={onRemoveTrack}
                                        onAddToPlaylist={onAddToPlaylist}
                                        isPlaylistRecentlyAdded={isPlaylistRecentlyAdded}
                                        activeRef={activeRef}
                                    />
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="pq-virtual-window">
                        {activeEntries.map((entry) => (
                            <QueueRow
                                key={entry.identityKey}
                                entry={entry}
                                safeActiveIndex={safeActiveIndex}
                                onPlayTrack={onPlayTrack}
                                onRemoveTrack={onRemoveTrack}
                                onAddToPlaylist={onAddToPlaylist}
                                isPlaylistRecentlyAdded={isPlaylistRecentlyAdded}
                                activeRef={activeRef}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

PlaybackQueue.displayName = 'PlaybackQueue';
