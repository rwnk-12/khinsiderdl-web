import React, { useEffect, useMemo, useState } from 'react';
import type { Playlist } from '../lib/playlists';
import { Icon } from './Icon';

type PlaylistPickerMode = 'track' | 'album' | 'queue';

interface PlaylistPickerOverlayProps {
    isOpen: boolean;
    mode: PlaylistPickerMode;
    tracks: any[];
    playlists: Playlist[];
    onClose: () => void;
    onCreateAndAddToPlaylist: (name: string, tracks: any[], byline?: string) => {
        playlistId: string | null;
        created: boolean;
        requestedCount: number;
        uniqueSelectedCount: number;
        addedCount: number;
        existingCount: number;
        addedTrackKeys: string[];
    };
    onAddToPlaylist: (playlistId: string, tracks: any[]) => {
        playlistId: string;
        playlistFound: boolean;
        requestedCount: number;
        uniqueSelectedCount: number;
        addedCount: number;
        existingCount: number;
        addedTrackKeys: string[];
    };
    onRemoveFromPlaylist: (playlistId: string, tracks: any[]) => {
        playlistId: string;
        playlistFound: boolean;
        requestedCount: number;
        uniqueSelectedCount: number;
        removedCount: number;
        missingCount: number;
        removedTrackKeys: string[];
    };
    onPlaylistAddSuccess?: (payload: {
        mode: PlaylistPickerMode;
        tracks: any[];
        addedTrackKeys: string[];
    }) => void;
}

const getHeading = (mode: PlaylistPickerMode) => {
    if (mode === 'album') return 'Add Album To Playlist';
    if (mode === 'queue') return 'Add Queue Track To Playlist';
    return 'Add Track To Playlist';
};

const getTrackKey = (track: any) => {
    const trackKey = String(track?.trackKey || '').trim();
    if (trackKey) return trackKey;
    const url = String(track?.url || '').trim();
    if (url) return `url:${url}`;
    const title = String(track?.title || '').trim().toLowerCase();
    const albumName = String(track?.albumName || '').trim().toLowerCase();
    return `meta:${title}|${albumName}`;
};

export const PlaylistPickerOverlay: React.FC<PlaylistPickerOverlayProps> = ({
    isOpen,
    mode,
    tracks,
    playlists,
    onClose,
    onCreateAndAddToPlaylist,
    onAddToPlaylist,
    onRemoveFromPlaylist,
    onPlaylistAddSuccess,
}) => {
    const [newPlaylistName, setNewPlaylistName] = useState('');
    const [newPlaylistByline, setNewPlaylistByline] = useState('');
    const [inlineError, setInlineError] = useState('');

    useEffect(() => {
        if (!isOpen) {
            setNewPlaylistName('');
            setNewPlaylistByline('');
            setInlineError('');
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const selectedCount = useMemo(() => {
        if (!Array.isArray(tracks)) return 0;
        return tracks.length;
    }, [tracks]);
    const selectedTrackKeys = useMemo(() => {
        const keys = new Set<string>();
        (Array.isArray(tracks) ? tracks : []).forEach((track: any) => {
            const key = getTrackKey(track);
            if (key) keys.add(key);
        });
        return [...keys];
    }, [tracks]);
    const playlistAvailability = useMemo(() => {
        const availability = new Map<string, {
            totalSelected: number;
            existingCount: number;
            newCount: number;
            allExisting: boolean;
        }>();

        playlists.forEach((playlist) => {
            const existingKeys = new Set((playlist.tracks || []).map((track) => String(track?.trackKey || '').trim()).filter(Boolean));
            let existingCount = 0;
            selectedTrackKeys.forEach((key) => {
                if (existingKeys.has(key)) existingCount += 1;
            });
            const totalSelected = selectedTrackKeys.length;
            const newCount = Math.max(0, totalSelected - existingCount);
            availability.set(playlist.id, {
                totalSelected,
                existingCount,
                newCount,
                allExisting: totalSelected > 0 && newCount === 0,
            });
        });

        return availability;
    }, [playlists, selectedTrackKeys]);

    if (!isOpen) return null;

    const handleCreateAndAdd = (event: React.FormEvent) => {
        event.preventDefault();
        const trimmed = String(newPlaylistName || '').trim();
        if (!trimmed) {
            setInlineError('Enter a playlist name.');
            return;
        }
        const byline = String(newPlaylistByline || '').trim();
        const result = onCreateAndAddToPlaylist(trimmed, tracks, byline);
        if (!result.created || !result.playlistId) {
            setInlineError('Could not create playlist.');
            return;
        }

        if (result.uniqueSelectedCount <= 0) {
            setInlineError('No valid tracks to add.');
            return;
        }

        if (result.addedCount <= 0) {
            if (result.existingCount > 0) {
                setInlineError(result.uniqueSelectedCount > 1
                    ? 'All selected tracks already exist in that playlist.'
                    : 'Selected track already exists in that playlist.');
                return;
            }
            setInlineError('No valid tracks to add.');
            return;
        }

        onPlaylistAddSuccess?.({
            mode,
            tracks,
            addedTrackKeys: result.addedTrackKeys,
        });
        onClose();
    };

    const handleAddExisting = (playlistId: string) => {
        const result = onAddToPlaylist(playlistId, tracks);
        if (!result.playlistFound) {
            setInlineError('Playlist no longer exists.');
            return;
        }
        if (result.uniqueSelectedCount <= 0) {
            setInlineError('No valid tracks to add.');
            return;
        }
        if (result.addedCount <= 0) {
            if (result.existingCount > 0) {
                setInlineError(result.uniqueSelectedCount > 1
                    ? 'All selected tracks already exist in that playlist.'
                    : 'Selected track already exists in that playlist.');
                return;
            }
            setInlineError('No valid tracks to add.');
            return;
        }
        onPlaylistAddSuccess?.({
            mode,
            tracks,
            addedTrackKeys: result.addedTrackKeys,
        });
        onClose();
    };

    const handleRemoveExisting = (playlistId: string, playlistNameRaw: string) => {
        if (typeof window !== 'undefined') {
            const playlistName = String(playlistNameRaw || 'this playlist').trim() || 'this playlist';
            const uniqueCount = selectedTrackKeys.length;
            const message = uniqueCount > 1
                ? `Remove ${uniqueCount} selected tracks from "${playlistName}"?`
                : `Remove this track from "${playlistName}"?`;
            const confirmed = window.confirm(message);
            if (!confirmed) return;
        }
        const result = onRemoveFromPlaylist(playlistId, tracks);
        if (!result.playlistFound) {
            setInlineError('Playlist no longer exists.');
            return;
        }
        if (result.uniqueSelectedCount <= 0) {
            setInlineError('No valid tracks to remove.');
            return;
        }
        if (result.removedCount <= 0) {
            setInlineError(result.uniqueSelectedCount > 1
                ? 'Selected tracks are no longer present in that playlist.'
                : 'Selected track is no longer present in that playlist.');
            return;
        }
        onClose();
    };

    return (
        <div className="playlist-picker-overlay" role="presentation">
            <div className="playlist-picker-backdrop" onClick={onClose}></div>
            <div
                className="playlist-picker-shell"
                role="dialog"
                aria-modal="true"
                aria-label={getHeading(mode)}
            >
                <div className="playlist-picker-header">
                    <h3 className="f-header playlist-picker-title">{getHeading(mode)}</h3>
                    <button
                        type="button"
                        className="q-close-btn"
                        onClick={onClose}
                        aria-label="Close add to playlist"
                    >
                        <Icon name="close" size={18} />
                    </button>
                </div>
                <div className="playlist-picker-body">
                    <div className="f-ui playlist-picker-count">{selectedCount} tracks selected</div>

                    <form className="playlist-picker-create" onSubmit={handleCreateAndAdd}>
                        <input
                            type="text"
                            value={newPlaylistName}
                            onChange={(event) => {
                                setNewPlaylistName(event.target.value);
                                setInlineError('');
                            }}
                            className="playlist-picker-input"
                            placeholder="New playlist name"
                            maxLength={60}
                        />
                        <input
                            type="text"
                            value={newPlaylistByline}
                            onChange={(event) => {
                                setNewPlaylistByline(event.target.value);
                                setInlineError('');
                            }}
                            className="playlist-picker-input"
                            placeholder="By (leave blank to not add)"
                            maxLength={80}
                        />
                        <button type="submit" className="btn-main">
                            <Icon name="plus" size={14} />
                            Create + Add
                        </button>
                    </form>
                    {inlineError ? <div className="playlist-picker-error">{inlineError}</div> : null}

                    <div className="playlist-picker-list">
                        {playlists.length === 0 ? (
                            <div className="playlist-picker-empty">No playlists yet.</div>
                        ) : (
                            playlists.map((playlist) => {
                                const availability = playlistAvailability.get(playlist.id);
                                const allExisting = !!availability?.allExisting;
                                const newCount = availability?.newCount ?? selectedTrackKeys.length;
                                const existingCount = availability?.existingCount ?? 0;
                                const ctaLabel = allExisting
                                    ? 'Already Exists'
                                    : (newCount > 0 && newCount < selectedTrackKeys.length)
                                        ? `Add ${newCount} New`
                                        : 'Add';
                                const cta = allExisting ? (
                                    <span className="playlist-picker-row-cta-lines">
                                        <span>Already Exists</span>
                                        <span className="playlist-picker-row-cta-sub">Remove it from here?</span>
                                    </span>
                                ) : ctaLabel;
                                const subtitle = existingCount > 0
                                    ? `${playlist.tracks.length} tracks · ${existingCount} already there`
                                    : `${playlist.tracks.length} tracks`;

                                return (
                                    <button
                                        key={playlist.id}
                                        type="button"
                                        className={`playlist-picker-row ${allExisting ? 'is-exists-option' : ''}`}
                                        onClick={() => (allExisting ? handleRemoveExisting(playlist.id, playlist.name) : handleAddExisting(playlist.id))}
                                        title={allExisting ? 'Remove selected tracks from this playlist' : 'Add selected tracks to this playlist'}
                                    >
                                        <div className="playlist-picker-row-main">
                                            <div className="playlist-picker-row-name">{playlist.name}</div>
                                            {playlist.byline ? (
                                                <div className="playlist-picker-row-byline">By {playlist.byline}</div>
                                            ) : null}
                                            <div className="playlist-picker-row-sub">{subtitle}</div>
                                        </div>
                                        <span className={`playlist-picker-row-cta ${allExisting ? 'is-exists' : ''}`}>
                                            {cta}
                                        </span>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
