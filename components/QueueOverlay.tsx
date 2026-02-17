import React, { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Icon } from './Icon';
import { LoadingIndicator } from './LoadingIndicator';

const PlaybackQueue = dynamic(
    () => import('./PlaybackQueue').then((mod) => mod.PlaybackQueue),
    {
        ssr: false,
        loading: () => (
            <div className="queue-overlay-loading">
                <LoadingIndicator />
            </div>
        ),
    }
);

const QUEUE_OVERLAY_CLOSE_FALLBACK_MS = 220;

type QueueOverlayPhase = 'closed' | 'opening' | 'open' | 'closing';

interface QueueOverlayProps {
    isOpen: boolean;
    onClose: () => void;
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
}

export const QueueOverlay: React.FC<QueueOverlayProps> = ({
    isOpen,
    onClose,
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
}) => {
    const [phase, setPhase] = React.useState<QueueOverlayPhase>(isOpen ? 'opening' : 'closed');
    const containerRef = React.useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (isOpen) {
            setPhase((prev) => (prev === 'open' || prev === 'opening' ? prev : 'opening'));
            return;
        }
        setPhase((prev) => {
            if (prev === 'closed' || prev === 'closing') return prev;
            onVisibilityApplied?.(false);
            return 'closing';
        });
    }, [isOpen, onVisibilityApplied]);

    useEffect(() => {
        if (phase !== 'opening') return;
        const rafId = window.requestAnimationFrame(() => {
            onVisibilityApplied?.(true);
            setPhase('open');
        });
        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [onVisibilityApplied, phase]);

    useEffect(() => {
        if (phase !== 'closing') return;
        const node = containerRef.current;
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            setPhase('closed');
        };
        const handleTransitionEnd = (event: TransitionEvent) => {
            if (event.target !== node) return;
            if (event.propertyName !== 'transform' && event.propertyName !== 'opacity') return;
            settle();
        };
        node?.addEventListener('transitionend', handleTransitionEnd);
        const fallbackId = window.setTimeout(settle, QUEUE_OVERLAY_CLOSE_FALLBACK_MS);
        return () => {
            node?.removeEventListener('transitionend', handleTransitionEnd);
            window.clearTimeout(fallbackId);
        };
    }, [phase]);

    useEffect(() => {
        const shouldLockBody = phase !== 'closed';
        document.body.style.overflow = shouldLockBody ? 'hidden' : '';
        return () => {
            document.body.style.overflow = '';
        };
    }, [phase]);

    useEffect(() => {
        if (phase === 'closed') return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, phase]);

    if (phase === 'closed') return null;

    const isVisible = phase === 'opening' || phase === 'open';
    const isQueueContentOpen = phase === 'opening' || phase === 'open';
    const shouldRenderQueueContent = phase !== 'closing';

    return (
        <div className={`queue-overlay-root center ${isVisible ? 'visible' : ''}`}>
            <div className="queue-overlay-backdrop" onClick={onClose}></div>
            <div className="queue-overlay-container" ref={containerRef}>
                <div className="queue-overlay-header">
                    <div className="q-mobile-header-title mobile-only">Now Playing Queue</div>

                    <div className="desktop-only" style={{ flex: 1 }}></div>

                    <button className="q-close-btn desktop-only" onClick={onClose}>
                        <Icon name="close" size={20} />
                    </button>
                </div>
                <div className="queue-overlay-content">
                    {shouldRenderQueueContent ? (
                        <PlaybackQueue
                            isOpen={isQueueContentOpen}
                            autoScrollMode="instant"
                            queue={queue}
                            currentTrack={currentTrack}
                            onPlayTrack={onPlay}
                            onRemoveTrack={onRemove}
                            onClearManual={onClearManual}
                            onClearAlbum={onClearAlbum}
                            sourceLabel={sourceLabel}
                            onAddToPlaylist={onAddToPlaylist}
                            onAddManualQueueToPlaylist={onAddManualQueueToPlaylist}
                            isPlaylistRecentlyAdded={isPlaylistRecentlyAdded}
                            onFirstRowPainted={onFirstRowPainted}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
};
