import React, { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { dlManager } from '../lib/download-manager';
import type { DownloadManagerState, QueueItem } from '../lib/app-types';
import { Icon } from './Icon';

const QUEUE_SECTION_VIRTUALIZATION_MIN_ITEMS = 60;
const QUEUE_SECTION_VIRTUALIZATION_OVERSCAN = 8;
const QUEUE_SECTION_ROW_ESTIMATE = 74;
const QUEUE_ITEM_UI_UPDATE_MIN_INTERVAL_MS = 80;

type QueueListMode = 'active' | 'pending' | 'completed';

type QueueSectionListProps = {
    items: QueueItem[];
    mode: QueueListMode;
    emptyMessage: string;
    renderItem: (item: QueueItem, mode: QueueListMode) => React.ReactNode;
};

const QueueSectionList = ({ items, mode, emptyMessage, renderItem }: QueueSectionListProps) => {
    const listRef = useRef<HTMLDivElement | null>(null);
    const shouldVirtualize = items.length >= QUEUE_SECTION_VIRTUALIZATION_MIN_ITEMS;

    const rowVirtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => listRef.current,
        estimateSize: () => QUEUE_SECTION_ROW_ESTIMATE,
        overscan: QUEUE_SECTION_VIRTUALIZATION_OVERSCAN,
        enabled: shouldVirtualize,
        getItemKey: (index) => String(items[index]?.id ?? `${mode}-${index}`),
    });

    if (items.length === 0) {
        return <div className="empty-msg">{emptyMessage}</div>;
    }

    if (!shouldVirtualize) {
        return (
            <div className="queue-list">
                {items.map((item, index) => (
                    <React.Fragment key={String(item?.id ?? `${mode}-${index}`)}>
                        {renderItem(item, mode)}
                    </React.Fragment>
                ))}
            </div>
        );
    }

    return (
        <div ref={listRef} className="queue-list queue-list-virtualized medieval-scroll">
            <div className="queue-list-inner" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                    const item = items[virtualItem.index];
                    if (!item) return null;
                    return (
                        <div
                            key={String(item?.id ?? `${mode}-${virtualItem.index}`)}
                            data-index={virtualItem.index}
                            ref={rowVirtualizer.measureElement}
                            className="queue-list-row"
                            style={{ transform: `translateY(${virtualItem.start}px)` }}
                        >
                            {renderItem(item, mode)}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export const QueueView = () => {
    const [state, setState] = useState<DownloadManagerState>(dlManager.getState());
    const itemUpdateRafRef = useRef<number | null>(null);
    const itemUpdateTimerRef = useRef<number | null>(null);
    const itemUpdateLastCommitRef = useRef(0);

    useEffect(() => {
        const handler = (newState: DownloadManagerState) => setState(newState);
        dlManager.on('update', handler);

        const flushItemState = () => {
            if (itemUpdateRafRef.current != null) return;
            itemUpdateRafRef.current = window.requestAnimationFrame(() => {
                itemUpdateRafRef.current = null;
                itemUpdateLastCommitRef.current = (typeof performance !== 'undefined' && performance.now)
                    ? performance.now()
                    : Date.now();
                setState(dlManager.getState());
            });
        };

        const itemHandler = () => {
            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            const elapsed = now - itemUpdateLastCommitRef.current;
            if (elapsed >= QUEUE_ITEM_UI_UPDATE_MIN_INTERVAL_MS) {
                if (itemUpdateTimerRef.current != null) {
                    window.clearTimeout(itemUpdateTimerRef.current);
                    itemUpdateTimerRef.current = null;
                }
                flushItemState();
                return;
            }
            if (itemUpdateTimerRef.current != null) return;
            const waitMs = Math.max(0, Math.ceil(QUEUE_ITEM_UI_UPDATE_MIN_INTERVAL_MS - elapsed));
            itemUpdateTimerRef.current = window.setTimeout(() => {
                itemUpdateTimerRef.current = null;
                flushItemState();
            }, waitMs);
        };

        dlManager.on('itemUpdate', itemHandler);
        return () => {
            dlManager.off('update', handler);
            dlManager.off('itemUpdate', itemHandler);
            if (itemUpdateRafRef.current != null) {
                window.cancelAnimationFrame(itemUpdateRafRef.current);
                itemUpdateRafRef.current = null;
            }
            if (itemUpdateTimerRef.current != null) {
                window.clearTimeout(itemUpdateTimerRef.current);
                itemUpdateTimerRef.current = null;
            }
        };
    }, []);
    const { active, queue, completed, errors } = state;

    const getItemAlbumName = (item: QueueItem) => {
        return String(
            item?.meta?.name ||
            item?.track?.albumName ||
            item?.track?.album ||
            'Unknown Album'
        );
    };

    const getItemTitle = (item: QueueItem) => {
        if (item?.type === 'album') return getItemAlbumName(item);
        return String(item?.track?.title || 'Unknown Track');
    };

    const renderItem = (item: QueueItem, mode: QueueListMode) => {
        const isActive = mode === 'active';
        const isCompleted = mode === 'completed';
        const itemTitle = getItemTitle(item);
        const itemAlbumName = getItemAlbumName(item);
        const statusText = isCompleted
            ? 'Completed'
            : String(item.statusText || (isActive ? 'In Progress' : 'Pending'));

        return (
            <div className={`queue-item ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`.trim()}>
                {isActive && <div className="progress-bg" style={{ width: `${Number(item?.progress || 0)}%` }}></div>}
                <div className="q-info">
                    <span className="q-type">{item.type === 'album' ? 'ALBUM' : 'TRACK'}</span>
                    <span className="q-title">{itemTitle}</span>
                    {item.type === 'track' && <span className="q-meta">{itemAlbumName}</span>}
                    <span className={`q-status-text ${isCompleted ? 'completed' : ''}`}>{statusText}</span>
                </div>
                <div className="q-actions">
                    {(isActive || item.status === 'pending') && (
                        <button className="btn-icon-only" onClick={() => dlManager.cancel(item.id)}>
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>
            </div>
        );
    };
    return (
        <div className="queue-container medieval-scroll">
            <div className="queue-summary" role="status" aria-live="polite">
                <span className="queue-summary-pill">Active {active.length}</span>
                <span className="queue-summary-pill">Pending {queue.length}</span>
                {errors.length > 0 ? <span className="queue-summary-pill is-error">Errors {errors.length}</span> : null}
                {completed.length > 0 ? <span className="queue-summary-pill is-completed">Completed {completed.length}</span> : null}
                {completed.length > 0 ? (
                    <button
                        className="btn-mini queue-clear-completed-btn"
                        onClick={() => dlManager.clearCompleted()}
                        title="Clear completed downloads"
                        aria-label="Clear completed downloads"
                    >
                        <Icon name="trash" size={14} />
                        <span>Clear Completed</span>
                    </button>
                ) : null}
            </div>
            <div className="queue-section">
                <h3 className="f-ui queue-section-title">Active ({active.length})</h3>
                <QueueSectionList
                    items={active}
                    mode="active"
                    emptyMessage="No active downloads"
                    renderItem={renderItem}
                />
            </div>
            <div className="queue-section">
                <h3 className="f-ui queue-section-title">Pending ({queue.length})</h3>
                <QueueSectionList
                    items={queue}
                    mode="pending"
                    emptyMessage="Queue is empty"
                    renderItem={renderItem}
                />
            </div>
            {(errors.length > 0) && (
                <div className="queue-section">
                <h3 className="f-ui queue-section-title queue-section-title-error">Errors ({errors.length})</h3>
                    {errors.map((item) => (
                        <div key={item.id} className="queue-item error" onClick={() => dlManager.retry(item.id)}>
                            <div className="q-info">
                                <span className="q-title">{getItemTitle(item)}</span>
                                <span className="q-meta">{item.error || "Failed"}</span>
                            </div>
                            <div className="q-status"><Icon name="refresh" size={14} /></div>
                        </div>
                    ))}
                </div>
            )}
            {(completed.length > 0) && (
                <div className="queue-section">
                    <h3 className="f-ui queue-section-title queue-section-title-completed">Completed ({completed.length})</h3>
                    <QueueSectionList
                        items={completed}
                        mode="completed"
                        emptyMessage="No completed downloads"
                        renderItem={renderItem}
                    />
                </div>
            )}
        </div>
    );
};
