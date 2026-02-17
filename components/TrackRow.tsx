import React from 'react';
import { Icon } from './Icon';
import { AutoScrollLabel } from './AutoScrollLabel';
import type { Track } from '../lib/app-types';

type TrackRowProps = {
    t: Track;
    i: number;
    isCurrent: boolean;
    isPlaying: boolean;
    trackProgress?: number;
    playTrack: (track: Track, selectedTracks: Track[]) => void;
    addToQueue: (track: Track) => void;
    addToPlaybackQueue?: (track: Track) => void;
    selectedAlbumTracks: Track[];
    isLiked?: boolean;
    onLike?: (track: Track) => void;
    thumbnail?: string;
    onAddToPlaylist?: (track: Track) => void;
    onShareTrack?: (track: Track) => void;
    isPlaylistRecentlyAdded?: boolean;
    lightweightTitleMode?: boolean;
};

export const TrackRow = React.memo(({
    t,
    i,
    isCurrent,
    isPlaying,
    trackProgress,
    playTrack,
    addToQueue,
    addToPlaybackQueue,
    selectedAlbumTracks,
    isLiked,
    onLike,
    thumbnail,
    onAddToPlaylist,
    onShareTrack,
    isPlaylistRecentlyAdded,
    lightweightTitleMode,
}: TrackRowProps) => {
    const isActiveTrack = isCurrent && isPlaying;
    const useSimpleTitle = Boolean(lightweightTitleMode) && !isActiveTrack;
    const hasTrackProgress = typeof trackProgress === 'number';
    const safeTrackProgress = hasTrackProgress ? trackProgress : 0;
    const [actionFeedback, setActionFeedback] = React.useState<'queue' | null>(null);
    const actionFeedbackTimeoutRef = React.useRef<number | null>(null);

    const triggerActionFeedback = React.useCallback((kind: 'queue') => {
        setActionFeedback(kind);
        if (actionFeedbackTimeoutRef.current !== null) {
            window.clearTimeout(actionFeedbackTimeoutRef.current);
        }
        actionFeedbackTimeoutRef.current = window.setTimeout(() => {
            setActionFeedback(null);
            actionFeedbackTimeoutRef.current = null;
        }, 2000);

        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(8);
        }
    }, []);

    React.useEffect(() => {
        return () => {
            if (actionFeedbackTimeoutRef.current !== null) {
                window.clearTimeout(actionFeedbackTimeoutRef.current);
                actionFeedbackTimeoutRef.current = null;
            }
        };
    }, []);

    const handleRowClick = (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('button') || target.closest('.t-act')) {
            return;
        }
        playTrack(t, selectedAlbumTracks);
    };

    const handleAddToPlaybackQueue = () => {
        if (!addToPlaybackQueue) return;
        addToPlaybackQueue(t);
        triggerActionFeedback('queue');
    };

    const handleAddToPlaylist = () => {
        if (!onAddToPlaylist) return;
        onAddToPlaylist(t);
    };

    const handleShareTrack = () => {
        if (!onShareTrack) return;
        onShareTrack(t);
    };

    return (
        <div
            className={`track-row ${isActiveTrack ? 'is-playing' : ''} ${isCurrent ? 'is-current' : ''}`}
            onClick={handleRowClick}
        >
            {trackProgress !== undefined && (
                <div className="track-progress-fill" style={{ width: `${trackProgress}%` }}></div>
            )}
            {thumbnail && (
                <div className="t-art-wrap">
                    <img
                        src={thumbnail}
                        alt=""
                        className="t-art"
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        decoding="async"
                    />
                    {isActiveTrack && (
                        <span className="t-art-mask" aria-hidden="true">
                            <span className="t-art-eq now-playing-bars playing">
                                <span></span>
                                <span></span>
                                <span></span>
                            </span>
                        </span>
                    )}
                </div>
            )}
            <div className="t-num">
                {isActiveTrack ? (
                    <span className="now-playing-bars playing" aria-hidden="true">
                        <span></span>
                        <span></span>
                        <span></span>
                    </span>
                ) : (
                    t.number || i + 1
                )}
            </div>
            <div className="t-info-stack">
                <div className="t-title">
                    <span className="t-title-marquee-wrap">
                        {useSimpleTitle ? (
                            <span className="t-title-text">{t.title || ''}</span>
                        ) : (
                            <AutoScrollLabel
                                text={t.title || ''}
                                className="t-title-marquee"
                                forceHover={isActiveTrack}
                                style={{
                                    fontWeight: 'inherit',
                                    fontSize: 'inherit',
                                    lineHeight: 'inherit',
                                    color: 'inherit'
                                }}
                            />
                        )}
                    </span>
                    {isActiveTrack && <span className="t-now-playing-inline"> · Now Playing</span>}
                    {hasTrackProgress && safeTrackProgress > 0 && safeTrackProgress < 100 && (
                        <span className="t-progress-inline" style={{ marginLeft: '10px', fontSize: '0.8em', color: 'var(--c-gold)', fontFamily: 'Mate SC' }}>
                            {Math.round(safeTrackProgress)}%
                        </span>
                    )}
                </div>
                {t.fileSize && <div className="t-size-mobile">{t.fileSize}</div>}
            </div>
            {t.bitrate && <div className="t-bitrate">{t.bitrate}</div>}
            <div className="t-dur">{t.duration}</div>
            {t.fileSize && <div className="t-size">{t.fileSize}</div>}
            <div className="t-act">
                {onLike && (
                    <button
                        className={`btn-mini btn-like ${isLiked ? 'is-active' : ''}`}
                        onClick={() => onLike(t)}
                        title={isLiked ? "Unlike" : "Like"}
                    >
                        <Icon name={isLiked ? "heartFilled" : "heart"} size={14} />
                    </button>
                )}
                <button
                    className="btn-mini btn-play"
                    onClick={() => playTrack(t, selectedAlbumTracks)}
                    title={isActiveTrack ? "Pause" : "Play"}
                >
                    <Icon name={isActiveTrack ? "pause" : "play"} size={14} />
                </button>
                {addToPlaybackQueue && (
                    <button
                        className={`btn-mini btn-queue ${actionFeedback === 'queue' ? 'is-feedback' : ''}`}
                        onClick={handleAddToPlaybackQueue}
                        title={actionFeedback === 'queue' ? "Added to Manual Queue" : "Add to Manual Queue"}
                    >
                        <Icon name={actionFeedback === 'queue' ? "check" : "list"} size={14} />
                    </button>
                )}
                {onAddToPlaylist && (
                    <button
                        className={`btn-mini btn-playlist ${isPlaylistRecentlyAdded ? 'is-feedback' : ''}`}
                        onClick={handleAddToPlaylist}
                        title={isPlaylistRecentlyAdded ? "Added to Playlist" : "Add to Playlist"}
                    >
                        <Icon name={isPlaylistRecentlyAdded ? "doubleCheck" : "plus"} size={15} />
                    </button>
                )}
                {onShareTrack && (
                    <button
                        className="btn-mini btn-share"
                        onClick={handleShareTrack}
                        title="Share Track Link"
                        aria-label="Share track link"
                    >
                        <Icon name="link" size={14} />
                    </button>
                )}
                <button
                    className="btn-mini btn-download"
                    onClick={() => addToQueue(t)}
                    title="Download Track"
                >
                    <Icon name="download" size={14} />
                </button>
            </div>
        </div>
    );
});

TrackRow.displayName = 'TrackRow';


