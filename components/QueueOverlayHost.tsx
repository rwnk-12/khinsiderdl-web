'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { QueueOverlay } from './QueueOverlay';
import { useHistoryState } from '../lib/useHistoryState';

export type QueueOverlayHostHandle = {
    open: () => void;
    close: () => void;
    toggle: () => void;
    isOpen: () => boolean;
};

type QueueOverlayHostProps = {
    queue: any[];
    currentTrack: any;
    onPlay: (track: any, index: number) => void;
    onRemove?: (index: number) => void;
    onClearManual?: () => void;
    onClearAlbum?: () => void;
    sourceLabel?: string;
    onAddToPlaylist?: (track: any) => void;
    onAddManualQueueToPlaylist?: () => void;
    isPlaylistRecentlyAdded?: (track: any) => boolean;
    onVisibilityApplied?: (visible: boolean) => void;
    onFirstRowPainted?: () => void;
    onOpenRequest?: () => void;
    onCloseRequest?: () => void;
};

export const QueueOverlayHost = React.memo(forwardRef<QueueOverlayHostHandle, QueueOverlayHostProps>(function QueueOverlayHost(
    {
        queue,
        currentTrack,
        onPlay,
        onRemove,
        onClearManual,
        onClearAlbum,
        sourceLabel,
        onAddToPlaylist,
        onAddManualQueueToPlaylist,
        isPlaylistRecentlyAdded,
        onVisibilityApplied,
        onFirstRowPainted,
        onOpenRequest,
        onCloseRequest,
    },
    ref
) {
    const [isOpen, setIsOpen] = useState(false);
    const isOpenRef = useRef(false);

    useEffect(() => {
        isOpenRef.current = isOpen;
    }, [isOpen]);

    const open = useCallback(() => {
        setIsOpen((prev) => {
            if (prev) return prev;
            onOpenRequest?.();
            return true;
        });
    }, [onOpenRequest]);

    const close = useCallback(() => {
        setIsOpen((prev) => {
            if (!prev) return prev;
            onCloseRequest?.();
            return false;
        });
    }, [onCloseRequest]);

    const toggle = useCallback(() => {
        setIsOpen((prev) => {
            const next = !prev;
            if (next) onOpenRequest?.();
            else onCloseRequest?.();
            return next;
        });
    }, [onCloseRequest, onOpenRequest]);

    useImperativeHandle(ref, () => ({
        open,
        close,
        toggle,
        isOpen: () => isOpenRef.current,
    }), [close, open, toggle]);

    useHistoryState('queue', isOpen, close);

    return (
        <QueueOverlay
            isOpen={isOpen}
            onClose={close}
            queue={queue}
            currentTrack={currentTrack}
            onPlay={onPlay}
            onRemove={onRemove}
            onClearManual={onClearManual}
            onClearAlbum={onClearAlbum}
            sourceLabel={sourceLabel}
            onAddToPlaylist={onAddToPlaylist}
            onAddManualQueueToPlaylist={onAddManualQueueToPlaylist}
            isPlaylistRecentlyAdded={isPlaylistRecentlyAdded}
            onVisibilityApplied={onVisibilityApplied}
            onFirstRowPainted={onFirstRowPainted}
        />
    );
}));

QueueOverlayHost.displayName = 'QueueOverlayHost';
