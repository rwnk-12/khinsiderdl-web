import React, { useRef, useEffect, useState } from 'react';
import Image from 'next/image';
import { Icon } from './Icon';
import { MedievalSpinner } from './MedievalSpinner';
import { AutoScrollLabel } from './AutoScrollLabel';
import type { Track } from '../lib/app-types';

type PlayerTrack = Track & {
    title: string;
};

type PlayerProps = {
    track: PlayerTrack | null;
    isPlaying: boolean;
    duration: number;
    onPlayPause: () => void;
    onToggleMode: () => void;
    mode: 'standard' | 'minimized';
    volume: number;
    onVolumeChange: (volume: number) => void;
    playbackRate: number;
    onPlaybackRateChange: (rate: number) => void;
    onNext: () => void;
    onPrev: () => void;
    albumArt?: string;
    thumbnail?: string;
    albumTitle?: string;
    onClose: () => void;
    isLoading: boolean;
    onDownload?: () => void;
    onAlbumClick?: () => void;
    isRepeatEnabled?: boolean;
    onToggleRepeat?: () => void;
    onShareTrack?: () => void;
    onAddToPlaylist?: () => void;
    isPlaylistRecentlyAdded?: boolean;
    audioRef: React.RefObject<HTMLAudioElement | null>;
    isMobileFullScreen: boolean;
    setMobileFullScreen: (open: boolean) => void;
    isLiked?: boolean;
    onLike?: () => void;
    onToggleQueue?: () => void;
};

export const Player = ({
    track, isPlaying, duration, onPlayPause, onToggleMode, mode,
    volume, onVolumeChange, playbackRate, onPlaybackRateChange, onNext, onPrev,
    albumArt, thumbnail, albumTitle, onClose, isLoading, onDownload, onAlbumClick,
    isRepeatEnabled, onToggleRepeat, onShareTrack, onAddToPlaylist, isPlaylistRecentlyAdded, audioRef,
    isMobileFullScreen, setMobileFullScreen, isLiked, onLike, onToggleQueue
}: PlayerProps) => {


    const sliderRef = useRef<HTMLInputElement>(null);
    const mobileSliderRef = useRef<HTMLInputElement>(null);
    const progressBarRef = useRef<HTMLDivElement>(null);
    const mobileProgressBarRef = useRef<HTMLDivElement>(null);
    const timeCurrRef = useRef<HTMLSpanElement>(null);
    const mobileTimeCurrRef = useRef<HTMLSpanElement>(null);
    const rafRef = useRef<number | null>(null);
    const isDraggingRef = useRef(false);
    const isAdjustingVolumeRef = useRef(false);
    const isAdjustingSpeedRef = useRef(false);


    const [mobileArtSource, setMobileArtSource] = useState('');
    const [desktopArtSource, setDesktopArtSource] = useState('');
    const [mobileUseProxyFallback, setMobileUseProxyFallback] = useState(false);
    const [desktopUseProxyFallback, setDesktopUseProxyFallback] = useState(false);
    const snapVolumePercent = (value: number) => {
        if (!Number.isFinite(value)) return 0;
        const clamped = Math.max(0, Math.min(100, value));
        return Math.round(clamped / 10) * 10;
    };
    const snapSpeedPercent = (value: number) => {
        if (!Number.isFinite(value)) return 100;
        const clamped = Math.max(50, Math.min(200, value));
        return Math.round(clamped / 5) * 5;
    };
    const [volumeSliderPercent, setVolumeSliderPercent] = useState(() => snapVolumePercent(volume * 100));
    const [speedSliderPercent, setSpeedSliderPercent] = useState(() => snapSpeedPercent(playbackRate * 100));

    const formatTime = (seconds: number) => {
        if (!seconds || isNaN(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

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

    const handleArtworkError = (
        currentSource: string,
        useProxyFallback: boolean,
        setUseProxyFallback: React.Dispatch<React.SetStateAction<boolean>>,
        setSource: React.Dispatch<React.SetStateAction<string>>
    ) => {
        if (!useProxyFallback) {
            setUseProxyFallback(true);
            return;
        }
        const fallbackSmall = toSmallThumbUrl(currentSource);
        if (fallbackSmall && fallbackSmall !== currentSource) {
            setSource(fallbackSmall);
            setUseProxyFallback(false);
            return;
        }
        setSource('');
    };

    useEffect(() => {
        setMobileArtSource(String(albumArt || thumbnail || '').trim());
        setMobileUseProxyFallback(false);
    }, [albumArt, thumbnail]);

    useEffect(() => {
        setDesktopArtSource(String(thumbnail || albumArt || '').trim());
        setDesktopUseProxyFallback(false);
    }, [thumbnail, albumArt]);

    useEffect(() => {
        if (isAdjustingVolumeRef.current) return;
        const next = snapVolumePercent(volume * 100);
        setVolumeSliderPercent((prev) => (prev === next ? prev : next));
    }, [volume]);

    useEffect(() => {
        if (isAdjustingSpeedRef.current) return;
        const next = snapSpeedPercent(playbackRate * 100);
        setSpeedSliderPercent((prev) => (prev === next ? prev : next));
    }, [playbackRate]);

    const updateVolumeSlider = (nextValue: number, commit: boolean) => {
        const snapped = snapVolumePercent(nextValue);
        setVolumeSliderPercent((prev) => (prev === snapped ? prev : snapped));
        const normalized = snapped / 100;
        if (audioRef.current) {
            audioRef.current.volume = normalized;
        }
        if (commit) {
            onVolumeChange(normalized);
        }
    };

    const updateSpeedSlider = (nextValue: number, commit: boolean) => {
        const snapped = snapSpeedPercent(nextValue);
        setSpeedSliderPercent((prev) => (prev === snapped ? prev : snapped));
        const normalized = snapped / 100;
        if (audioRef.current) {
            audioRef.current.playbackRate = normalized;
            if ((audioRef.current as any).mozPreservesPitch !== undefined) {
                (audioRef.current as any).mozPreservesPitch = false;
            } else {
                (audioRef.current as any).preservesPitch = false;
            }
        }
        if (commit) {
            onPlaybackRateChange(normalized);
        }
    };

    const handleVolumeInput = (e: React.FormEvent<HTMLInputElement>) => {
        isAdjustingVolumeRef.current = true;
        updateVolumeSlider(e.currentTarget.valueAsNumber, false);
    };

    const handleVolumeCommit = (e: React.SyntheticEvent<HTMLInputElement>) => {
        isAdjustingVolumeRef.current = false;
        updateVolumeSlider(e.currentTarget.valueAsNumber, true);
    };

    const handleSpeedInput = (e: React.FormEvent<HTMLInputElement>) => {
        isAdjustingSpeedRef.current = true;
        updateSpeedSlider(e.currentTarget.valueAsNumber, false);
    };

    const handleSpeedCommit = (e: React.SyntheticEvent<HTMLInputElement>) => {
        isAdjustingSpeedRef.current = false;
        updateSpeedSlider(e.currentTarget.valueAsNumber, true);
    };

    useEffect(() => {
        const audio = audioRef?.current;
        if (!audio) return;

        const updateUI = () => {
            const time = audio.currentTime;
            const dur = audio.duration || 1;
            const percent = (time / dur) * 100;

            const fmt = formatTime(time);
            if (timeCurrRef.current) timeCurrRef.current.innerText = fmt;
            if (mobileTimeCurrRef.current) mobileTimeCurrRef.current.innerText = fmt;

            if (progressBarRef.current) progressBarRef.current.style.width = `${percent}%`;
            if (mobileProgressBarRef.current) mobileProgressBarRef.current.style.width = `${percent}%`;

            if (!isDraggingRef.current) {
                if (sliderRef.current) {
                    sliderRef.current.value = time.toString();
                    sliderRef.current.style.backgroundSize = `${percent}% 100%`;
                }
                if (mobileSliderRef.current) {
                    mobileSliderRef.current.value = time.toString();
                    mobileSliderRef.current.style.backgroundSize = `${percent}% 100%`;
                }
            }

            if (isPlaying) {
                rafRef.current = requestAnimationFrame(updateUI);
            }
        };

        if (isPlaying) {
            rafRef.current = requestAnimationFrame(updateUI);
        } else {
            updateUI();
        }

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [isPlaying, audioRef]);

    const handleSeekStart = () => {
        isDraggingRef.current = true;
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        const dur = duration || 1;
        const percent = (val / dur) * 100;

        e.target.style.backgroundSize = `${percent}% 100%`;

        const fmt = formatTime(val);
        if (timeCurrRef.current) timeCurrRef.current.innerText = fmt;
        if (mobileTimeCurrRef.current) mobileTimeCurrRef.current.innerText = fmt;
    };

    const handleSeekEnd = (e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
        isDraggingRef.current = false;
        if (audioRef?.current) {
            const val = parseFloat((e.target as HTMLInputElement).value);
            audioRef.current.currentTime = val;
        }
    };

    const handleMobileBarClick = (e: React.MouseEvent) => {
        if (window.innerWidth <= 768) {
            setMobileFullScreen(true);
        }

    };

    if (!track) return null;

    const mobileArtSrc = mobileUseProxyFallback ? toProxyImageSrc(mobileArtSource) : mobileArtSource;
    const desktopArtSrc = desktopUseProxyFallback ? toProxyImageSrc(desktopArtSource) : desktopArtSource;
    const speedFillPercent = Math.max(0, Math.min(100, ((speedSliderPercent - 50) / 150) * 100));
    const playbackRateLabel = `${(speedSliderPercent / 100).toFixed(2)}x`;

    return (
        <>
            <div className={`mobile-player-overlay ${isMobileFullScreen ? 'active' : ''}`}>
                <div className="mp-header">
                    <button className="mp-close-btn mp-toggle-btn" onClick={() => setMobileFullScreen(false)}>
                        <Icon name="chevronDown" size={24} />
                    </button>
                </div>

                <div className="mp-art-container">
                    {mobileArtSrc ? (
                        <div className="mp-art-shell">
                            <Image
                                src={mobileArtSrc}
                                referrerPolicy="no-referrer"
                                className="mp-art"
                                alt=""
                                fill
                                sizes="(max-width: 768px) 88vw, 420px"
                                quality={90}
                                loading={isMobileFullScreen ? 'eager' : 'lazy'}
                                fetchPriority={isMobileFullScreen ? 'high' : 'auto'}
                                onError={() => handleArtworkError(
                                    mobileArtSource,
                                    mobileUseProxyFallback,
                                    setMobileUseProxyFallback,
                                    setMobileArtSource
                                )}
                            />
                        </div>
                    ) : (
                        <div className="mp-art mp-art-fallback">
                            <Icon name="headphones" size={64} />
                        </div>
                    )}
                </div>

                <div className="mp-info">
                    <div className="mp-info-grid">
                        <div className="mp-text-column">
                            <AutoScrollLabel
                                text={track.title}
                                className="mp-title mp-title-scroll"
                                forceHover={true}
                            />
                            <div
                                className="mp-album mp-album-link"
                                onClick={() => { setMobileFullScreen(false); if (onAlbumClick) onAlbumClick(); }}
                            >
                                {albumTitle}
                            </div>
                        </div>

                        <div className="mp-controls-column">
                            {onLike && (
                                <button className={`mp-btn mp-btn-compact ${isLiked ? 'is-liked' : ''}`} onClick={onLike}>
                                    <Icon name={isLiked ? "heartFilled" : "heart"} size={22} />
                                </button>
                            )}

                            {onToggleQueue && (
                                <button
                                    className="mp-btn mp-btn-compact"
                                    onClick={onToggleQueue}
                                    title="Queue"
                                >
                                    <Icon name="list" size={22} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="mp-progress">
                    <div className="mp-progress-top">
                        <span ref={mobileTimeCurrRef} className="mp-time">0:00</span>
                        <span className="mp-time">{formatTime(duration)}</span>
                    </div>
                    <input
                        ref={mobileSliderRef}
                        type="range"
                        min="0"
                        max={duration || 0}
                        step="0.1"
                        defaultValue="0"
                        onChange={handleSeek}
                        onMouseDown={handleSeekStart}
                        onMouseUp={handleSeekEnd}
                        onTouchStart={handleSeekStart}
                        onTouchEnd={handleSeekEnd}
                        className="seek-slider mobile-seek"
                    />
                </div>

                <div className="mp-controls">
                    <div className="mp-controls-center">
                        <button className="mp-btn mp-btn-side" onClick={onPrev}><Icon name="skipBack" size={24} /></button>
                        <button className="mp-btn-main" onClick={onPlayPause}>
                            {isLoading ? (
                                <MedievalSpinner className="spinner-svg small" />
                            ) : (
                                <Icon name={isPlaying ? "pause" : "play"} size={28} />
                            )}
                        </button>
                        <button className="mp-btn mp-btn-side" onClick={onNext}><Icon name="skipFwd" size={24} /></button>
                    </div>
                </div>

                <div className="mp-sliders">
                    <div className="mp-slider-group">
                        <Icon name="volume" size={16} />
                        <input
                            type="range"
                            min="0" max="100" step="10"
                            value={volumeSliderPercent}
                            onInput={handleVolumeInput}
                            onPointerDown={() => { isAdjustingVolumeRef.current = true; }}
                            onPointerUp={handleVolumeCommit}
                            onPointerCancel={handleVolumeCommit}
                            onBlur={handleVolumeCommit}
                            onKeyUp={handleVolumeCommit}
                            className="vol-slider"
                            style={{ flex: 1, backgroundSize: `${volumeSliderPercent}% 100%` }}
                        />
                        <span className="player-value-label">{volumeSliderPercent}%</span>
                    </div>
                    <div className="mp-slider-group">
                        <span className="speed-label speed-label-mobile">{playbackRateLabel}</span>
                        <input
                            type="range"
                            min="50" max="200" step="5"
                            value={speedSliderPercent}
                            onInput={handleSpeedInput}
                            onPointerDown={() => { isAdjustingSpeedRef.current = true; }}
                            onPointerUp={handleSpeedCommit}
                            onPointerCancel={handleSpeedCommit}
                            onBlur={handleSpeedCommit}
                            onKeyUp={handleSpeedCommit}
                            className="speed-slider"
                            style={{ flex: 1, backgroundSize: `${speedFillPercent}% 100%` }}
                        />
                    </div>
                </div>
            </div>

            <div className={`medieval-player player-${mode}`} onClick={handleMobileBarClick}>
                <div className="player-toggle-btn desktop-only" onClick={(e) => { e.stopPropagation(); onToggleMode(); }}>
                    <Icon name={mode === 'standard' ? 'chevronDown' : 'chevronUp'} size={20} />
                </div>

                <div className="player-progress-container mobile-only">
                    <div ref={mobileProgressBarRef} className="player-progress-bar" style={{ width: '0%' }}></div>
                </div>

                <div className="player-content-standard">
                    <div className="p-info">
                        {desktopArtSrc ? (
                            <Image
                                src={desktopArtSrc}
                                referrerPolicy="no-referrer"
                                className="p-art"
                                alt=""
                                width={64}
                                height={64}
                                sizes="64px"
                                quality={90}
                                loading="eager"
                                fetchPriority="high"
                                onError={() => handleArtworkError(
                                    desktopArtSource,
                                    desktopUseProxyFallback,
                                    setDesktopUseProxyFallback,
                                    setDesktopArtSource
                                )}
                            />
                        ) : (
                            <div className="p-art p-art-fallback">
                                <Icon name="headphones" size={24} />
                            </div>
                        )}
                        <div className="p-meta">
                            <div className="p-title-row">
                                <div className="p-title" title={track.title}>{track.title}</div>
                                <div className="p-title-actions desktop-only" role="group" aria-label="Title actions">
                                    {onShareTrack && (
                                        <button
                                            className="p-btn"
                                            onClick={(e) => { e.stopPropagation(); onShareTrack(); }}
                                            title="Share Track Link"
                                            aria-label="Share track link"
                                        >
                                            <Icon name="link" size={16} />
                                        </button>
                                    )}
                                    {onAddToPlaylist && (
                                        <button
                                            className={`p-btn ${isPlaylistRecentlyAdded ? 'is-active' : ''}`}
                                            onClick={(e) => { e.stopPropagation(); onAddToPlaylist(); }}
                                            title={isPlaylistRecentlyAdded ? "Added to Playlist" : "Add to Playlist"}
                                            aria-label={isPlaylistRecentlyAdded ? "Added to playlist" : "Add to playlist"}
                                        >
                                            <Icon name={isPlaylistRecentlyAdded ? "doubleCheck" : "plus"} size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div
                                className={`p-subtitle ${onAlbumClick ? 'interactive' : ''}`}
                                title={albumTitle}
                                onClick={(e) => { e.stopPropagation(); if (onAlbumClick) onAlbumClick(); }}
                            >
                                {albumTitle || "Unknown Album"}
                            </div>
                        </div>
                    </div>

                    <div className="p-center-wrapper">
                        <div className="p-controls">
                            {onLike && (
                                <button className="p-btn mobile-only" onClick={(e) => { e.stopPropagation(); onLike(); }} title={isLiked ? "Unlike" : "Like"} style={{ color: isLiked ? 'var(--c-crimson)' : 'inherit' }}>
                                    <Icon name={isLiked ? "heartFilled" : "heart"} size={20} />
                                </button>
                            )}
                            {onToggleRepeat && (
                                <button
                                    className={`p-btn desktop-only ${isRepeatEnabled ? 'is-active' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); onToggleRepeat(); }}
                                    title={isRepeatEnabled ? "Repeat Current Track: On" : "Repeat Current Track: Off"}
                                    aria-label={isRepeatEnabled ? "Disable repeat current track" : "Enable repeat current track"}
                                >
                                    <Icon name="repeat" size={16} />
                                </button>
                            )}
                            <button className="p-btn desktop-only" onClick={(e) => { e.stopPropagation(); onPrev(); }} title="Previous"><Icon name="skipBack" size={20} /></button>
                            <button className="p-btn p-btn-main" onClick={(e) => { e.stopPropagation(); onPlayPause(); }}>
                                {isLoading ? (
                                    <MedievalSpinner className="spinner-svg small" />
                                ) : (
                                    <Icon name={isPlaying ? "pause" : "play"} size={22} />
                                )}
                            </button>
                            <button className="p-btn" onClick={(e) => { e.stopPropagation(); onNext(); }} title="Next"><Icon name="skipFwd" size={20} /></button>
                            {onLike && (
                                <button
                                    className={`p-btn desktop-only ${isLiked ? 'is-liked' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); onLike(); }}
                                    title={isLiked ? "Unlike" : "Like"}
                                    aria-label={isLiked ? "Unlike track" : "Like track"}
                                >
                                    <Icon name={isLiked ? "heartFilled" : "heart"} size={16} />
                                </button>
                            )}
                        </div>
                        <div className="player-progress-desktop desktop-only">
                            <span ref={timeCurrRef} className="time-curr">0:00</span>
                            <input
                                ref={sliderRef}
                                type="range"
                                min="0"
                                max={duration || 0}
                                step="0.1"
                                defaultValue="0"
                                onChange={handleSeek}
                                onMouseDown={handleSeekStart}
                                onMouseUp={handleSeekEnd}
                                className="seek-slider"
                                onClick={(e) => e.stopPropagation()}
                            />
                            <span className="time-dur">{formatTime(duration)}</span>
                        </div>
                    </div>

                    <div className="p-extras">
                        <div className="desktop-only p-action-cluster" role="group" aria-label="Track actions">
                            {onToggleQueue && (
                                <button
                                    className="p-btn"
                                    onClick={(e) => { e.stopPropagation(); onToggleQueue(); }}
                                    title="Toggle Queue"
                                    aria-label="Toggle queue"
                                >
                                    <Icon name="list" size={16} />
                                </button>
                            )}
                            {onDownload && (
                                <button
                                    className="p-btn"
                                    onClick={(e) => { e.stopPropagation(); onDownload(); }}
                                    title="Download Track"
                                    aria-label="Download track"
                                >
                                    <Icon name="download" size={16} />
                                </button>
                            )}
                        </div>

                        <div className="p-settings">

                            <div className="p-speed" title="Playback Speed">
                                <span className="speed-label">{playbackRateLabel}</span>
                                <input
                                    type="range"
                                    min="50" max="200" step="5"
                                    value={speedSliderPercent}
                                    onInput={handleSpeedInput}
                                    onPointerDown={() => { isAdjustingSpeedRef.current = true; }}
                                    onPointerUp={handleSpeedCommit}
                                    onPointerCancel={handleSpeedCommit}
                                    onBlur={handleSpeedCommit}
                                    onKeyUp={handleSpeedCommit}
                                    className="speed-slider"
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ backgroundSize: `${speedFillPercent}% 100%` }}
                                />
                                <button
                                    className="p-btn p-btn-reset"
                                    onClick={(e) => { e.stopPropagation(); updateSpeedSlider(100, true); }}
                                    title="Reset Speed to 1x"
                                    style={{ opacity: speedSliderPercent === 100 ? 0.3 : 1 }}
                                >
                                    <Icon name="refresh" size={14} />
                                </button>
                            </div>
                            <div className="p-volume" title="Volume">
                                <Icon name="volume" size={18} />
                                <input
                                    type="range"
                                    min="0" max="100" step="10"
                                    value={volumeSliderPercent}
                                    onInput={handleVolumeInput}
                                    onPointerDown={() => { isAdjustingVolumeRef.current = true; }}
                                    onPointerUp={handleVolumeCommit}
                                    onPointerCancel={handleVolumeCommit}
                                    onBlur={handleVolumeCommit}
                                    onKeyUp={handleVolumeCommit}
                                    className="vol-slider"
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ backgroundSize: `${volumeSliderPercent}% 100%` }}
                                />
                                <span className="player-value-label">{volumeSliderPercent}%</span>
                            </div>
                        </div>

                        <button className="p-btn p-btn-close" onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close Player">
                            <Icon name="close" size={20} />
                        </button>
                    </div>
                </div>
                <div className="player-content-mini">
                    <div className="mini-text">
                        <span className="mini-text-title">{track.title}</span>
                        <span className="mini-text-subtitle">
                            Playing
                        </span>
                    </div>
                </div>
            </div>
        </>
    );
};
