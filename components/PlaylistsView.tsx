import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Playlist } from '../lib/playlists';
import type { SharedPlaylistRecordV1 } from '../lib/playlist-share';
import { Icon } from './Icon';
import { TabHeader } from './TabHeader';
import { ActionOverflowMenu } from './ActionOverflowMenu';
import { AutoScrollLabel } from './AutoScrollLabel';

interface PlaylistsViewProps {
    playlists: Playlist[];
    selectedPlaylistId: string | null;
    onSelectPlaylist: (playlistId: string) => void;
    isIdentifierView: boolean;
    routeIdentifier: string | null;
    onOpenPlaylistIdentifier: (playlistId: string) => void;
    onBackToPlaylists: () => void;
    onCreatePlaylist: (name: string, byline?: string) => string | null;
    onRenamePlaylist: (playlistId: string, nextName: string, nextByline?: string) => void;
    onDeletePlaylist: (playlistId: string) => void;
    onPlayPlaylist: (playlistId: string, startIndex?: number, shuffle?: boolean) => void;
    onPlayTrackFromPlaylist: (playlistId: string, index: number) => void;
    isSharedIdentifierView: boolean;
    sharedPlaylistStatus: 'idle' | 'loading' | 'ready' | 'error' | 'not_found';
    sharedPlaylistRecord: SharedPlaylistRecordV1 | null;
    onPlaySharedPlaylist: (startIndex?: number, shuffle?: boolean) => void;
    onPlayTrackFromSharedPlaylist: (trackIndex: number) => void;
    onImportSharedPlaylist: () => void;
    onRemoveTrack: (playlistId: string, trackIndex: number) => void;
    onMoveTrack: (playlistId: string, fromIndex: number, toIndex: number) => void;
    onExportPlaylists: () => void;
    onExportPlaylist: (playlistId: string) => void;
    onSharePlaylist: (playlistId: string) => void;
    onDownloadPlaylistZip: (payload: { name: string; tracks: any[] }) => void;
    onImportPlaylists: () => void;
    onAddTrackToPlaylist: (track: any) => void;
    onShareTrack: (track: any) => void;
    onDownloadTrack: (track: any) => void;
    onAddTrackToQueue: (track: any) => void;
    getTrackDownloadProgress: (track: any) => number | undefined;
    trackHasRecentPlaylistAdd: (track: any) => boolean;
    onOpenTrackAlbum: (track: any) => void;
}

const formatUpdatedAt = (updatedAt: number) => {
    if (!updatedAt) return 'Unknown';
    try {
        const date = new Date(updatedAt);
        return date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return 'Unknown';
    }
};

const getPlaylistCoverUrls = (playlist: Playlist) => {
    return playlist.tracks
        .map((track) => String(track.thumbnail || track.albumArt || '').trim())
        .filter(Boolean)
        .slice(0, 4);
};

const formatTitleWithByline = (name: unknown, byline?: unknown) => {
    const cleanName = String(name ?? '').trim();
    const cleanByline = String(byline ?? '').trim();
    if (!cleanByline) return cleanName;
    return `${cleanName} by ${cleanByline}`;
};

const normalizeCoverUrl = (raw: unknown) => String(raw ?? '').trim();

const getTrackIdentityKey = (track: any, index: number, scope: string) => {
    const primary = String(track?.trackKey || track?.url || '').trim();
    if (primary) return `${scope}-${primary}`;
    const title = String(track?.title || '').trim().toLowerCase();
    const album = String(track?.albumName || '').trim().toLowerCase();
    const addedAt = Number(track?.addedAt || 0);
    return `${scope}-${title}|${album}|${addedAt}|${index}`;
};

const getCoverIdentityKey = (scope: string, rawCoverUrl: unknown, index: number) => {
    const normalized = normalizeCoverUrl(rawCoverUrl);
    if (normalized) return `${scope}-${normalized}`;
    return `${scope}-cover-${index}`;
};

const PLAYLIST_COVER_LOAD_TIMEOUT_MS = 9000;
const IDENTIFIER_VIRTUALIZATION_MIN_ITEMS = 120;
const IDENTIFIER_VIRTUALIZATION_OVERSCAN_ROWS = 8;
const IDENTIFIER_VIRTUALIZATION_FALLBACK_ROW_HEIGHT = 56;

type PlaylistTextDialogMode = 'create' | 'rename';

type PlaylistTextDialogState = {
    mode: PlaylistTextDialogMode;
    playlistId?: string;
    value: string;
    byline: string;
    error: string;
};

type PlaylistDeleteDialogState = {
    playlistId: string;
    name: string;
};

export const PlaylistsView: React.FC<PlaylistsViewProps> = ({
    playlists,
    selectedPlaylistId,
    onSelectPlaylist,
    isIdentifierView,
    routeIdentifier,
    onOpenPlaylistIdentifier,
    onBackToPlaylists,
    onCreatePlaylist,
    onRenamePlaylist,
    onDeletePlaylist,
    onPlayPlaylist,
    onPlayTrackFromPlaylist,
    isSharedIdentifierView,
    sharedPlaylistStatus,
    sharedPlaylistRecord,
    onPlaySharedPlaylist,
    onPlayTrackFromSharedPlaylist,
    onImportSharedPlaylist,
    onRemoveTrack,
    onMoveTrack,
    onExportPlaylists,
    onExportPlaylist,
    onSharePlaylist,
    onDownloadPlaylistZip,
    onImportPlaylists,
    onAddTrackToPlaylist,
    onShareTrack,
    onDownloadTrack,
    onAddTrackToQueue,
    getTrackDownloadProgress,
    trackHasRecentPlaylistAdd,
    onOpenTrackAlbum,
}) => {
    const [sortMode, setSortMode] = useState<'recents' | 'name'>('recents');
    const [libraryViewMode, setLibraryViewMode] = useState<'grid' | 'list'>('grid');
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [liveMessage, setLiveMessage] = useState('');
    const [textDialog, setTextDialog] = useState<PlaylistTextDialogState | null>(null);
    const [deleteDialog, setDeleteDialog] = useState<PlaylistDeleteDialogState | null>(null);
    const rowFocusRef = useRef<Record<string, HTMLButtonElement | null>>({});
    const pendingFocusTrackKeyRef = useRef<string | null>(null);
    const identifierTracklistRef = useRef<HTMLDivElement | null>(null);
    const identifierVirtualScrollRafRef = useRef<number | null>(null);
    const [identifierVirtualRowHeight, setIdentifierVirtualRowHeight] = useState(IDENTIFIER_VIRTUALIZATION_FALLBACK_ROW_HEIGHT);
    const [identifierVirtualRange, setIdentifierVirtualRange] = useState<{ start: number; end: number }>({ start: 0, end: -1 });
    const [loadedCoverKeys, setLoadedCoverKeys] = useState<Record<string, string>>({});
    const resolvedCoverUrlsRef = useRef<Record<string, 'loaded' | 'error'>>({});
    const coverLoadFallbackTimersRef = useRef<Record<string, number>>({});

    const selectedPlaylist = useMemo(() => {
        if (!selectedPlaylistId) return null;
        return playlists.find((playlist) => playlist.id === selectedPlaylistId) || null;
    }, [playlists, selectedPlaylistId]);
    const sharedPlaylist = useMemo(() => {
        if (!isSharedIdentifierView) return null;
        return sharedPlaylistRecord?.playlist || null;
    }, [isSharedIdentifierView, sharedPlaylistRecord]);
    const selectedPlaylistTracks = selectedPlaylist?.tracks || [];
    const shouldVirtualizeIdentifierTracks = isIdentifierView && selectedPlaylistTracks.length >= IDENTIFIER_VIRTUALIZATION_MIN_ITEMS;
    const indexedSelectedPlaylistTracks = useMemo(() => {
        return selectedPlaylistTracks.map((track, index) => ({ track, index }));
    }, [selectedPlaylistTracks]);

    const updateIdentifierVirtualRange = useCallback(() => {
        if (!shouldVirtualizeIdentifierTracks) return;
        const root = identifierTracklistRef.current;
        if (!root) return;
        const totalItems = selectedPlaylistTracks.length;
        if (totalItems === 0) {
            setIdentifierVirtualRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }
        const rowHeight = Math.max(1, identifierVirtualRowHeight);
        const viewportStart = root.scrollTop;
        const viewportEnd = viewportStart + root.clientHeight;
        const visibleStart = Math.floor(viewportStart / rowHeight);
        const visibleEnd = Math.max(visibleStart, Math.ceil(viewportEnd / rowHeight) - 1);
        const start = Math.max(0, visibleStart - IDENTIFIER_VIRTUALIZATION_OVERSCAN_ROWS);
        const end = Math.min(totalItems - 1, visibleEnd + IDENTIFIER_VIRTUALIZATION_OVERSCAN_ROWS);
        setIdentifierVirtualRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    }, [identifierVirtualRowHeight, selectedPlaylistTracks.length, shouldVirtualizeIdentifierTracks]);

    const measureIdentifierRowHeight = useCallback(() => {
        if (!shouldVirtualizeIdentifierTracks) return;
        const sampleRow = identifierTracklistRef.current?.querySelector('.playlists-track-row') as HTMLElement | null;
        if (!sampleRow) return;
        const measured = Math.round(sampleRow.getBoundingClientRect().height);
        if (measured > 24 && Math.abs(measured - identifierVirtualRowHeight) > 1) {
            setIdentifierVirtualRowHeight(measured);
        }
    }, [identifierVirtualRowHeight, shouldVirtualizeIdentifierTracks]);

    useEffect(() => {
        if (!shouldVirtualizeIdentifierTracks) {
            setIdentifierVirtualRange((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
            return;
        }
        const totalItems = selectedPlaylistTracks.length;
        const initialEnd = totalItems > 0 ? Math.min(totalItems - 1, 60) : -1;
        setIdentifierVirtualRange((prev) => (prev.start === 0 && prev.end === initialEnd ? prev : { start: 0, end: initialEnd }));
    }, [selectedPlaylistTracks.length, shouldVirtualizeIdentifierTracks]);

    useEffect(() => {
        if (!shouldVirtualizeIdentifierTracks) {
            if (identifierVirtualScrollRafRef.current != null && typeof window !== 'undefined') {
                window.cancelAnimationFrame(identifierVirtualScrollRafRef.current);
                identifierVirtualScrollRafRef.current = null;
            }
            return;
        }
        if (typeof window === 'undefined') return;
        const root = identifierTracklistRef.current;
        if (!root) return;

        const schedule = () => {
            if (identifierVirtualScrollRafRef.current != null) return;
            identifierVirtualScrollRafRef.current = window.requestAnimationFrame(() => {
                identifierVirtualScrollRafRef.current = null;
                updateIdentifierVirtualRange();
            });
        };
        const refresh = () => {
            measureIdentifierRowHeight();
            schedule();
        };

        refresh();
        root.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', refresh, { passive: true });

        return () => {
            root.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', refresh);
            if (identifierVirtualScrollRafRef.current != null) {
                window.cancelAnimationFrame(identifierVirtualScrollRafRef.current);
                identifierVirtualScrollRafRef.current = null;
            }
        };
    }, [measureIdentifierRowHeight, shouldVirtualizeIdentifierTracks, updateIdentifierVirtualRange]);

    const visibleIdentifierTracks = useMemo(() => {
        if (!shouldVirtualizeIdentifierTracks) return indexedSelectedPlaylistTracks;
        if (indexedSelectedPlaylistTracks.length === 0) return [];
        const start = Math.max(0, Math.min(indexedSelectedPlaylistTracks.length - 1, identifierVirtualRange.start));
        const end = Math.max(start, Math.min(indexedSelectedPlaylistTracks.length - 1, identifierVirtualRange.end));
        return indexedSelectedPlaylistTracks.slice(start, end + 1);
    }, [identifierVirtualRange.end, identifierVirtualRange.start, indexedSelectedPlaylistTracks, shouldVirtualizeIdentifierTracks]);

    const identifierVirtualTopPadding = shouldVirtualizeIdentifierTracks
        ? Math.max(0, identifierVirtualRange.start) * identifierVirtualRowHeight
        : 0;
    const identifierVirtualBottomPadding = shouldVirtualizeIdentifierTracks
        ? Math.max(0, selectedPlaylistTracks.length - (Math.max(identifierVirtualRange.end, identifierVirtualRange.start) + 1)) * identifierVirtualRowHeight
        : 0;

    const visiblePlaylists = useMemo(() => {
        const sorted = [...playlists];
        if (sortMode === 'name') {
            sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            return sorted;
        }

        sorted.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        return sorted;
    }, [playlists, sortMode]);

    const playlistCards = useMemo(() => {
        return visiblePlaylists.map((playlist) => {
            const covers = getPlaylistCoverUrls(playlist);
            const entry = { playlist, covers };
            return entry;
        });
    }, [visiblePlaylists]);

    const formatTrackAddedDate = useCallback((addedAt: number) => {
        if (!addedAt) return '--';
        try {
            return new Date(addedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            });
        } catch {
            return '--';
        }
    }, []);

    const getDurationLabel = useCallback((tracks: Array<{ duration?: string }> | undefined | null) => {
        if (!Array.isArray(tracks) || tracks.length === 0) return '';
        let totalSeconds = 0;
        for (const track of tracks) {
            const raw = String(track?.duration || '').trim();
            if (!raw) continue;
            const parts = raw.split(':').map((value) => Number.parseInt(value, 10));
            if (parts.some((value) => Number.isNaN(value))) continue;
            if (parts.length === 2) {
                totalSeconds += (parts[0] * 60) + parts[1];
            } else if (parts.length === 3) {
                totalSeconds += (parts[0] * 3600) + (parts[1] * 60) + parts[2];
            }
        }
        if (totalSeconds <= 0) return '';
        const totalMinutes = Math.floor(totalSeconds / 60);
        if (totalMinutes < 60) return `${totalMinutes} min`;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (!minutes) return `${hours} hr`;
        return `${hours} hr ${minutes} min`;
    }, []);

    const playlistDurationText = useMemo(() => {
        return getDurationLabel(selectedPlaylist?.tracks);
    }, [getDurationLabel, selectedPlaylist?.tracks]);

    const sharedPlaylistDurationText = useMemo(() => {
        return getDurationLabel(sharedPlaylist?.tracks);
    }, [getDurationLabel, sharedPlaylist?.tracks]);

    const sharedPlaylistDateText = useMemo(() => {
        if (!sharedPlaylistRecord?.createdAt) return 'Unknown';
        try {
            return new Date(sharedPlaylistRecord.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            });
        } catch {
            return 'Unknown';
        }
    }, [sharedPlaylistRecord?.createdAt]);

    const markCoverResolved = useCallback(
        (coverKey: string, rawCoverUrl: unknown, status: 'loaded' | 'error') => {
            const coverUrl = normalizeCoverUrl(rawCoverUrl);
            const timerId = coverLoadFallbackTimersRef.current[coverKey];
            if (timerId != null) {
                window.clearTimeout(timerId);
                delete coverLoadFallbackTimersRef.current[coverKey];
            }
            if (coverUrl) {
                resolvedCoverUrlsRef.current[coverUrl] = status;
            }
            setLoadedCoverKeys((prev) => {
                if (prev[coverKey] === coverUrl) return prev;
                return { ...prev, [coverKey]: coverUrl || '__resolved__' };
            });
        },
        []
    );

    const isCoverResolved = useCallback(
        (coverKey: string, rawCoverUrl: unknown) => {
            const coverUrl = normalizeCoverUrl(rawCoverUrl);
            if (!coverUrl) return true;
            if (loadedCoverKeys[coverKey] === coverUrl) return true;
            return !!resolvedCoverUrlsRef.current[coverUrl];
        },
        [loadedCoverKeys]
    );

    const syncCoverNodeState = useCallback(
        (imgNode: HTMLImageElement | null, coverKey: string, rawCoverUrl: unknown) => {
            if (!imgNode) return;
            const coverUrl = normalizeCoverUrl(rawCoverUrl);
            if (!coverUrl || !imgNode.complete) return;
            if (imgNode.naturalWidth > 0) {
                markCoverResolved(coverKey, coverUrl, 'loaded');
                return;
            }
            markCoverResolved(coverKey, coverUrl, 'error');
        },
        [markCoverResolved]
    );

    useEffect(() => {
        if (isIdentifierView) return;
        const activeCoverKeys = new Set<string>();
        for (const { playlist, covers } of playlistCards) {
            for (let index = 0; index < covers.length; index += 1) {
                const coverKey = `${playlist.id}-${index}`;
                const coverUrl = normalizeCoverUrl(covers[index]);
                activeCoverKeys.add(coverKey);

                if (isCoverResolved(coverKey, coverUrl)) continue;
                if (coverLoadFallbackTimersRef.current[coverKey] != null) continue;

                coverLoadFallbackTimersRef.current[coverKey] = window.setTimeout(() => {
                    markCoverResolved(coverKey, coverUrl, 'error');
                }, PLAYLIST_COVER_LOAD_TIMEOUT_MS);
            }
        }

        const timerEntries = Object.entries(coverLoadFallbackTimersRef.current);
        for (const [coverKey, timerId] of timerEntries) {
            if (activeCoverKeys.has(coverKey)) continue;
            window.clearTimeout(timerId);
            delete coverLoadFallbackTimersRef.current[coverKey];
        }
    }, [isCoverResolved, isIdentifierView, markCoverResolved, playlistCards]);

    useEffect(() => {
        return () => {
            const timerIds = Object.values(coverLoadFallbackTimersRef.current);
            for (const timerId of timerIds) {
                window.clearTimeout(timerId);
            }
            coverLoadFallbackTimersRef.current = {};
        };
    }, []);

    useEffect(() => {
        const isDialogOpen = !!textDialog || !!deleteDialog;
        if (!isDialogOpen) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setTextDialog(null);
            setDeleteDialog(null);
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [deleteDialog, textDialog]);

    const handleCreate = () => {
        setTextDialog({
            mode: 'create',
            value: '',
            byline: '',
            error: '',
        });
    };

    const handleRename = () => {
        if (!selectedPlaylist) return;
        setTextDialog({
            mode: 'rename',
            playlistId: selectedPlaylist.id,
            value: selectedPlaylist.name,
            byline: selectedPlaylist.byline || '',
            error: '',
        });
    };

    const handleDelete = () => {
        if (!selectedPlaylist) return;
        setDeleteDialog({
            playlistId: selectedPlaylist.id,
            name: selectedPlaylist.name,
        });
    };

    const submitTextDialog = (event: React.FormEvent) => {
        event.preventDefault();
        if (!textDialog) return;

        const trimmed = String(textDialog.value || '').trim();
        if (!trimmed) {
            setTextDialog((prev) => (prev ? { ...prev, error: 'Enter playlist name.' } : prev));
            return;
        }

        if (textDialog.mode === 'create') {
            const byline = String(textDialog.byline || '').trim();
            const playlistId = onCreatePlaylist(trimmed, byline);
            if (!playlistId) {
                setTextDialog((prev) => (prev ? { ...prev, error: 'Could not create playlist.' } : prev));
                return;
            }
            onSelectPlaylist(playlistId);
            setLiveMessage(`Created playlist ${trimmed}.`);
            setTextDialog(null);
            return;
        }

        const playlistId = String(textDialog.playlistId || '').trim();
        if (!playlistId) {
            setTextDialog(null);
            return;
        }

        const previousName = String(selectedPlaylist?.id === playlistId ? selectedPlaylist.name : '').trim();
        const nextByline = String(textDialog.byline || '').trim();
        const previousByline = String(selectedPlaylist?.id === playlistId ? (selectedPlaylist.byline || '') : '').trim();
        if (trimmed === previousName && nextByline === previousByline) {
            setTextDialog(null);
            return;
        }

        onRenamePlaylist(playlistId, trimmed, nextByline);
        setLiveMessage(`Updated playlist ${trimmed}.`);
        setTextDialog(null);
    };

    const confirmDeleteDialog = () => {
        if (!deleteDialog) return;
        onDeletePlaylist(deleteDialog.playlistId);
        setLiveMessage(`Deleted playlist ${deleteDialog.name}.`);
        setDeleteDialog(null);
    };

    const handleMove = (fromIndex: number, toIndex: number) => {
        if (!selectedPlaylist) return;
        if (toIndex < 0 || toIndex >= selectedPlaylist.tracks.length) return;
        const movedTrack = selectedPlaylist.tracks[fromIndex];
        if (!movedTrack) return;
        pendingFocusTrackKeyRef.current = movedTrack.trackKey;
        onMoveTrack(selectedPlaylist.id, fromIndex, toIndex);
        setLiveMessage(`Moved ${movedTrack.title} to position ${toIndex + 1}.`);
        window.requestAnimationFrame(() => {
            if (!pendingFocusTrackKeyRef.current) return;
            const nextNode = rowFocusRef.current[pendingFocusTrackKeyRef.current];
            if (nextNode) nextNode.focus();
            pendingFocusTrackKeyRef.current = null;
        });
    };

    const handleRemoveTrack = (index: number) => {
        if (!selectedPlaylist) return;
        const track = selectedPlaylist.tracks[index];
        if (!track) return;
        if (typeof window !== 'undefined') {
            const trackTitle = String(track.title || 'this track').trim() || 'this track';
            const playlistName = String(selectedPlaylist.name || 'this playlist').trim() || 'this playlist';
            const confirmed = window.confirm(`Remove "${trackTitle}" from "${playlistName}"?`);
            if (!confirmed) return;
        }
        onRemoveTrack(selectedPlaylist.id, index);
        setLiveMessage(`Removed ${track.title}.`);
    };

    const handleDrop = (targetIndex: number) => {
        if (!selectedPlaylist) return;
        if (dragIndex == null) return;
        if (targetIndex === dragIndex) {
            setDragIndex(null);
            setDropIndex(null);
            return;
        }
        handleMove(dragIndex, targetIndex);
        setDragIndex(null);
        setDropIndex(null);
    };

    return (
        <div className={`playlists-view content-inner ${isIdentifierView ? 'is-identifier-view' : 'is-grid-view'}`}>
            {!isIdentifierView ? (
                <>
                    <TabHeader
                        title="Your Library"
                        subtitle={`${playlists.length} playlists`}
                        className="playlists-tab-header"
                        actions={(
                            <div className="playlists-header-actions">
                                <button type="button" className="btn-main album-hero-action-btn playlists-create-cta" onClick={handleCreate}>
                                    <Icon name="plus" size={16} />
                                    Create
                                </button>
                                <div className="playlists-header-secondary-actions">
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn playlists-secondary-action"
                                        onClick={onExportPlaylists}
                                    >
                                        <Icon name="download" size={15} />
                                        Export
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn playlists-secondary-action"
                                        onClick={onImportPlaylists}
                                    >
                                        <Icon name="upload" size={15} />
                                        Import
                                    </button>
                                </div>
                                <div className="playlists-header-view-controls">
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn playlists-sort-pill"
                                        onClick={() => setSortMode((prev) => (prev === 'recents' ? 'name' : 'recents'))}
                                        aria-label="Toggle playlist sort"
                                    >
                                        {sortMode === 'recents' ? 'Recents' : 'A-Z'}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn playlists-view-toggle"
                                        onClick={() => setLibraryViewMode((prev) => (prev === 'grid' ? 'list' : 'grid'))}
                                        aria-label={`Switch to ${libraryViewMode === 'grid' ? 'list' : 'grid'} view`}
                                    >
                                        <Icon name={libraryViewMode === 'grid' ? 'list' : 'grid'} size={14} />
                                        {libraryViewMode === 'grid' ? 'List' : 'Grid'}
                                    </button>
                                </div>
                                <ActionOverflowMenu
                                    className="playlists-header-overflow"
                                    label="Playlist library actions"
                                    items={[
                                        {
                                            id: 'export-playlists',
                                            label: 'Export Library',
                                            icon: 'download',
                                            onSelect: onExportPlaylists,
                                        },
                                        {
                                            id: 'import-playlists',
                                            label: 'Import Library',
                                            icon: 'upload',
                                            onSelect: onImportPlaylists,
                                        },
                                        {
                                            id: 'sort-playlists',
                                            label: sortMode === 'recents' ? 'Sort: A-Z' : 'Sort: Recents',
                                            icon: 'refresh',
                                            onSelect: () => setSortMode((prev) => (prev === 'recents' ? 'name' : 'recents')),
                                        },
                                        {
                                            id: 'toggle-view-mode',
                                            label: libraryViewMode === 'grid' ? 'Show List View' : 'Show Grid View',
                                            icon: libraryViewMode === 'grid' ? 'list' : 'grid',
                                            onSelect: () => setLibraryViewMode((prev) => (prev === 'grid' ? 'list' : 'grid')),
                                        },
                                    ]}
                                />
                            </div>
                        )}
                    />

                    {playlists.length === 0 ? (
                        <div className="playlists-empty">No playlists yet.</div>
                    ) : visiblePlaylists.length === 0 ? (
                        <div className="playlists-empty">No playlists available.</div>
                    ) : libraryViewMode === 'list' ? (
                        <div className="playlists-list">
                            {playlistCards.map(({ playlist, covers }) => {
                                const leadCover = String(covers[0] || '').trim();
                                const coverKey = `${playlist.id}-0`;
                                const isLoaded = isCoverResolved(coverKey, leadCover);
                                return (
                                    <button
                                        key={`${playlist.id}-list`}
                                        type="button"
                                        className={`playlists-list-row ${selectedPlaylist?.id === playlist.id ? 'is-selected' : ''}`}
                                        onClick={() => {
                                            onSelectPlaylist(playlist.id);
                                            onOpenPlaylistIdentifier(playlist.id);
                                        }}
                                    >
                                        <span className={`playlists-list-cover ${isLoaded ? 'is-ready' : 'is-loading'}`} aria-hidden="true">
                                            {leadCover ? (
                                                <img
                                                    src={leadCover}
                                                    alt=""
                                                    loading="lazy"
                                                    decoding="async"
                                                    className={`playlists-list-cover-img ${isLoaded ? 'is-visible' : ''}`}
                                                    onLoad={() => markCoverResolved(coverKey, leadCover, 'loaded')}
                                                    onError={() => markCoverResolved(coverKey, leadCover, 'error')}
                                                    ref={(node) => syncCoverNodeState(node, coverKey, leadCover)}
                                                />
                                            ) : (
                                                <span className="playlists-grid-fallback">
                                                    <Icon name="headphones" size={16} />
                                                </span>
                                            )}
                                        </span>
                                        <span className="playlists-list-main">
                                            <span className="playlists-grid-name">{formatTitleWithByline(playlist.name, playlist.byline)}</span>
                                            <span className="playlists-grid-meta">{playlist.tracks.length} tracks</span>
                                        </span>
                                        <span className="playlists-list-updated">Updated {formatUpdatedAt(playlist.updatedAt)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="playlists-grid">
                            {playlistCards.map(({ playlist, covers }) => {
                                return (
                                    <button
                                        key={playlist.id}
                                        type="button"
                                        className={`playlists-grid-card ${selectedPlaylist?.id === playlist.id ? 'is-selected' : ''}`}
                                        onClick={() => {
                                            onSelectPlaylist(playlist.id);
                                            onOpenPlaylistIdentifier(playlist.id);
                                        }}
                                    >
                                        <span className="playlists-grid-cover" aria-hidden="true">
                                            {covers.length > 0 ? (
                                                covers.map((coverUrl, index) => {
                                                    const coverKey = `${playlist.id}-${index}`;
                                                    const normalizedCoverUrl = normalizeCoverUrl(coverUrl);
                                                    const isLoaded = isCoverResolved(coverKey, normalizedCoverUrl);
                                                    return (
                                                        <span
                                                            key={coverKey}
                                                            className={`playlists-grid-cover-cell ${isLoaded ? 'is-ready' : 'is-loading'}`}
                                                        >
                                                            <img
                                                                src={normalizedCoverUrl}
                                                                alt=""
                                                                loading="lazy"
                                                                decoding="async"
                                                                className={`playlists-grid-cover-img ${isLoaded ? 'is-visible' : ''}`}
                                                                onLoad={() => markCoverResolved(coverKey, normalizedCoverUrl, 'loaded')}
                                                                onError={() => markCoverResolved(coverKey, normalizedCoverUrl, 'error')}
                                                                ref={(node) => syncCoverNodeState(node, coverKey, normalizedCoverUrl)}
                                                            />
                                                        </span>
                                                    );
                                                })
                                            ) : (
                                                <span className="playlists-grid-fallback">
                                                    <Icon name="headphones" size={18} />
                                                </span>
                                            )}
                                        </span>
                                        <span className="playlists-grid-copy">
                                            <span className="playlists-grid-name">{formatTitleWithByline(playlist.name, playlist.byline)}</span>
                                            <span className="playlists-grid-meta">
                                                {playlist.tracks.length} tracks - Updated {formatUpdatedAt(playlist.updatedAt)}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </>
            ) : (
                <>
                    <button
                        type="button"
                        className="playlist-back-link f-ui"
                        onClick={onBackToPlaylists}
                    >
                        Back to playlists
                    </button>

                    {isSharedIdentifierView ? (
                        !sharedPlaylist ? (
                            <div className="playlists-empty-detail">
                                {sharedPlaylistStatus === 'loading'
                                    ? 'Loading shared playlist...'
                                    : sharedPlaylistStatus === 'not_found'
                                        ? 'Shared playlist not found.'
                                        : sharedPlaylistStatus === 'error'
                                            ? 'Shared playlist link is invalid or corrupted.'
                                            : 'No shared playlist data found in this link.'}
                            </div>
                        ) : (
                            <>
                                <div className="playlist-detail-hero">
                                    <div className="playlist-hero-art-wrap playlist-detail-art-wrap" aria-hidden="true">
                                        <span className="playlist-hero-covers">
                                            {getPlaylistCoverUrls(sharedPlaylist as Playlist).length > 0 ? (
                                                getPlaylistCoverUrls(sharedPlaylist as Playlist).map((coverUrl, index) => (
                                                    <img
                                                        key={getCoverIdentityKey(`shared-hero-${sharedPlaylistRecord?.shareId || 'playlist'}`, coverUrl, index)}
                                                        src={coverUrl}
                                                        alt=""
                                                        loading="lazy"
                                                        decoding="async"
                                                    />
                                                ))
                                            ) : (
                                                <span className="playlist-hero-fallback">
                                                    <Icon name="headphones" size={36} />
                                                </span>
                                            )}
                                        </span>
                                    </div>
                                    <div className="playlist-detail-copy">
                                        <div className="playlist-detail-kicker f-ui">Shared Playlist</div>
                                        <h1 className="f-header album-title playlist-identifier-title">
                                            {formatTitleWithByline(sharedPlaylist.name, sharedPlaylist.byline)}
                                        </h1>
                                        <div className="f-ui playlist-identifier-subtitle">
                                            {sharedPlaylist.tracks.length} tracks{sharedPlaylistDurationText ? ` · ${sharedPlaylistDurationText}` : ''}
                                        </div>
                                        <div className="playlist-detail-updated">Shared {sharedPlaylistDateText}</div>
                                    </div>
                                </div>

                                <div className="playlist-detail-actions">
                                    <div className="album-primary-actions">
                                        <button
                                            type="button"
                                            className="btn-main album-hero-action-btn album-hero-play-btn"
                                            onClick={() => onPlaySharedPlaylist(0, false)}
                                            disabled={sharedPlaylist.tracks.length === 0}
                                        >
                                            <Icon name="play" size={15} />
                                            Play
                                        </button>
                                        <button
                                            type="button"
                                            className="btn-main album-hero-action-btn album-hero-shuffle-btn"
                                            onClick={() => onPlaySharedPlaylist(0, true)}
                                            disabled={sharedPlaylist.tracks.length === 0}
                                        >
                                            <Icon name="shuffle" size={15} />
                                            Shuffle
                                        </button>
                                        <button
                                            type="button"
                                            className="btn-main album-hero-action-btn"
                                            onClick={onImportSharedPlaylist}
                                        >
                                            <Icon name="plus" size={15} />
                                            Import to Library
                                        </button>
                                        <button
                                            type="button"
                                            className="btn-main album-hero-action-btn"
                                            onClick={() => onDownloadPlaylistZip({ name: sharedPlaylist.name, tracks: sharedPlaylist.tracks })}
                                            disabled={sharedPlaylist.tracks.length === 0}
                                        >
                                            <Icon name="download" size={15} />
                                            Download ZIP
                                        </button>
                                    </div>
                                </div>

                                <div className="playlists-tracklist playlist-identifier-tracklist">
                                    {sharedPlaylist.tracks.length === 0 ? (
                                        <div className="playlists-empty-detail">This shared playlist is empty.</div>
                                    ) : (
                                        <>
                                            <div className="playlists-track-head" aria-hidden="true">
                                                <div className="playlists-track-head-index"></div>
                                                <div className="playlists-track-head-title">Title</div>
                                                <div className="playlists-track-head-album">Album</div>
                                                <div className="playlists-track-head-added">Added</div>
                                                <div className="playlists-track-head-duration">Time</div>
                                                <div className="playlists-track-head-actions"></div>
                                            </div>
                                            {sharedPlaylist.tracks.map((track, index) => {
                                                const isPlaylistAdded = trackHasRecentPlaylistAdd(track);
                                                const trackDownloadProgress = getTrackDownloadProgress(track);
                                                return (
                                                    <div key={getTrackIdentityKey(track, index, `shared-${sharedPlaylistRecord?.shareId || 'playlist'}`)} className="playlists-track-row">
                                                        {trackDownloadProgress !== undefined && (
                                                            <div className="track-progress-fill" style={{ width: `${trackDownloadProgress}%` }} />
                                                        )}
                                                        <div className="playlists-track-art" aria-hidden="true">
                                                            {String(track.thumbnail || track.albumArt || '').trim() ? (
                                                                <img
                                                                    src={String(track.thumbnail || track.albumArt || '').trim()}
                                                                    alt=""
                                                                    className="playlists-track-art-img"
                                                                    loading="lazy"
                                                                    decoding="async"
                                                                    referrerPolicy="no-referrer"
                                                                />
                                                            ) : (
                                                                <span className="playlists-track-art-fallback">
                                                                    <Icon name="headphones" size={12} />
                                                                </span>
                                                            )}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            className="playlists-track-main"
                                                            onClick={() => onPlayTrackFromSharedPlaylist(index)}
                                                            title="Play track"
                                                        >
                                                            <span className="playlists-track-title">{track.title}</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="playlists-track-album playlists-track-album-link"
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                onOpenTrackAlbum(track);
                                                            }}
                                                            title={`Open album: ${String(track.albumName || 'Unknown Album')}`}
                                                            aria-label={`Open album ${String(track.albumName || 'Unknown Album')}`}
                                                        >
                                                            <AutoScrollLabel
                                                                text={String(track.albumName || 'Unknown Album')}
                                                                className="playlists-track-album-label"
                                                            />
                                                        </button>
                                                        <div className="playlists-track-added">{formatTrackAddedDate(track.addedAt)}</div>
                                                        <div className="playlists-track-duration">{track.duration || '--:--'}</div>
                                                        <div className="playlists-track-actions t-act">
                                                            <button
                                                                type="button"
                                                                className={`btn-mini btn-playlist ${isPlaylistAdded ? 'is-feedback' : ''}`}
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    onAddTrackToPlaylist(track);
                                                                }}
                                                                title={isPlaylistAdded ? "Added to Playlist" : "Add to Playlist"}
                                                                aria-label={isPlaylistAdded ? "Added to playlist" : "Add to playlist"}
                                                            >
                                                                <Icon name={isPlaylistAdded ? "doubleCheck" : "plus"} size={15} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn-mini btn-share"
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    onShareTrack(track);
                                                                }}
                                                                title="Share track link"
                                                                aria-label="Share track link"
                                                            >
                                                                <Icon name="link" size={14} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn-mini btn-download"
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    onDownloadTrack(track);
                                                                }}
                                                                title="Download track"
                                                                aria-label="Download track"
                                                            >
                                                                <Icon name="download" size={14} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn-mini btn-queue"
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    event.stopPropagation();
                                                                    onAddTrackToQueue(track);
                                                                }}
                                                                title="Add to Manual Queue"
                                                                aria-label="Add to manual queue"
                                                            >
                                                                <Icon name="list" size={14} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </>
                                    )}
                                </div>
                            </>
                        )
                    ) : !selectedPlaylist ? (
                        <div className="playlists-empty-detail">
                            {routeIdentifier ? `No playlist found for "${routeIdentifier}".` : 'Select a playlist.'}
                        </div>
                    ) : (
                        <>
                            <div className="playlist-detail-hero">
                                <div className="playlist-hero-art-wrap playlist-detail-art-wrap" aria-hidden="true">
                                    <span className="playlist-hero-covers">
                                        {getPlaylistCoverUrls(selectedPlaylist).length > 0 ? (
                                            getPlaylistCoverUrls(selectedPlaylist).map((coverUrl, index) => (
                                                <img
                                                    key={getCoverIdentityKey(`playlist-hero-${selectedPlaylist.id}`, coverUrl, index)}
                                                    src={coverUrl}
                                                    alt=""
                                                    loading="lazy"
                                                    decoding="async"
                                                />
                                            ))
                                        ) : (
                                            <span className="playlist-hero-fallback">
                                                <Icon name="headphones" size={36} />
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div className="playlist-detail-copy">
                                    <div className="playlist-detail-kicker f-ui">Playlist</div>
                                    <div className="playlist-title-row">
                                        <h1 className="f-header album-title playlist-identifier-title">
                                            {formatTitleWithByline(selectedPlaylist.name, selectedPlaylist.byline)}
                                        </h1>
                                        <button
                                            type="button"
                                            className="playlist-byline-edit-btn"
                                            onClick={handleRename}
                                            aria-label="Edit playlist name and byline"
                                            title="Edit name/byline"
                                        >
                                            <Icon name="pencil" size={13} />
                                        </button>
                                    </div>
                                    <div className="f-ui playlist-identifier-subtitle">
                                        {selectedPlaylist.tracks.length} tracks{playlistDurationText ? ` · ${playlistDurationText}` : ''}
                                    </div>
                                    <div className="playlist-detail-updated">Updated {formatUpdatedAt(selectedPlaylist.updatedAt)}</div>
                                </div>
                            </div>

                            <div className="playlist-detail-actions">
                                <div className="album-primary-actions">
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn album-hero-play-btn"
                                        onClick={() => onPlayPlaylist(selectedPlaylist.id, 0, false)}
                                        disabled={selectedPlaylist.tracks.length === 0}
                                    >
                                        <Icon name="play" size={15} />
                                        Play
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn album-hero-shuffle-btn"
                                        onClick={() => onPlayPlaylist(selectedPlaylist.id, 0, true)}
                                        disabled={selectedPlaylist.tracks.length === 0}
                                    >
                                        <Icon name="shuffle" size={15} />
                                        Shuffle
                                    </button>
                                </div>
                                <div className="album-secondary-actions">
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn"
                                        onClick={() => onSharePlaylist(selectedPlaylist.id)}
                                    >
                                        <Icon name="link" size={14} />
                                        Share
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn"
                                        onClick={() => onExportPlaylist(selectedPlaylist.id)}
                                    >
                                        <Icon name="download" size={14} />
                                        Export
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn"
                                        onClick={() => onDownloadPlaylistZip({ name: selectedPlaylist.name, tracks: selectedPlaylist.tracks })}
                                        disabled={selectedPlaylist.tracks.length === 0}
                                    >
                                        <Icon name="download" size={14} />
                                        Download ZIP
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn"
                                        onClick={onImportPlaylists}
                                    >
                                        <Icon name="upload" size={14} />
                                        Import
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-main album-hero-action-btn playlist-delete-btn"
                                        onClick={handleDelete}
                                    >
                                        <Icon name="trash" size={14} />
                                        Delete
                                    </button>
                                </div>
                            </div>

                            {shouldVirtualizeIdentifierTracks ? (
                                <div className="playlists-virtualize-note">
                                    Large playlist detected. Showing a virtualized track window for smoother scrolling.
                                </div>
                            ) : null}

                            <div
                                className={`playlists-tracklist playlist-identifier-tracklist ${shouldVirtualizeIdentifierTracks ? 'is-virtualized' : ''}`}
                                ref={identifierTracklistRef}
                            >
                                {selectedPlaylist.tracks.length === 0 ? (
                                    <div className="playlists-empty-detail">This playlist is empty.</div>
                                ) : (
                                    <>
                                        <div className="playlists-track-head" aria-hidden="true">
                                            <div className="playlists-track-head-index"></div>
                                            <div className="playlists-track-head-title">Title</div>
                                            <div className="playlists-track-head-album">Album</div>
                                            <div className="playlists-track-head-added">Added</div>
                                            <div className="playlists-track-head-duration">Time</div>
                                            <div className="playlists-track-head-actions"></div>
                                        </div>
                                        {shouldVirtualizeIdentifierTracks && identifierVirtualTopPadding > 0 ? (
                                            <div
                                                className="playlist-identifier-virtual-spacer"
                                                aria-hidden="true"
                                                style={{ height: `${identifierVirtualTopPadding}px` }}
                                            />
                                        ) : null}
                                        {visibleIdentifierTracks.map(({ track, index }) => {
                                            const isPlaylistAdded = trackHasRecentPlaylistAdd(track);
                                            const trackDownloadProgress = getTrackDownloadProgress(track);
                                            return (
                                                <div
                                                    key={getTrackIdentityKey(track, index, `playlist-${selectedPlaylist.id}`)}
                                                    className={`playlists-track-row ${dropIndex === index ? 'is-drop-target' : ''}`}
                                                    draggable
                                                    onDragStart={() => setDragIndex(index)}
                                                    onDragEnd={() => {
                                                        setDragIndex(null);
                                                        setDropIndex(null);
                                                    }}
                                                    onDragOver={(event) => {
                                                        event.preventDefault();
                                                        if (dropIndex !== index) setDropIndex(index);
                                                    }}
                                                    onDrop={(event) => {
                                                        event.preventDefault();
                                                        handleDrop(index);
                                                    }}
                                                >
                                                    {trackDownloadProgress !== undefined && (
                                                        <div className="track-progress-fill" style={{ width: `${trackDownloadProgress}%` }} />
                                                    )}
                                                    <div className="playlists-track-art" aria-hidden="true">
                                                        {String(track.thumbnail || track.albumArt || '').trim() ? (
                                                            <img
                                                                src={String(track.thumbnail || track.albumArt || '').trim()}
                                                                alt=""
                                                                className="playlists-track-art-img"
                                                                loading="lazy"
                                                                decoding="async"
                                                                referrerPolicy="no-referrer"
                                                            />
                                                        ) : (
                                                            <span className="playlists-track-art-fallback">
                                                                <Icon name="headphones" size={12} />
                                                            </span>
                                                        )}
                                                    </div>
                                                    <button
                                                        type="button"
                                                        className="playlists-track-main"
                                                        ref={(node) => {
                                                            rowFocusRef.current[track.trackKey] = node;
                                                        }}
                                                        onClick={() => onPlayTrackFromPlaylist(selectedPlaylist.id, index)}
                                                        title="Play track"
                                                    >
                                                        <span className="playlists-track-title">{track.title}</span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="playlists-track-album playlists-track-album-link"
                                                        onClick={(event) => {
                                                            event.preventDefault();
                                                            event.stopPropagation();
                                                            onOpenTrackAlbum(track);
                                                        }}
                                                        title={`Open album: ${String(track.albumName || 'Unknown Album')}`}
                                                        aria-label={`Open album ${String(track.albumName || 'Unknown Album')}`}
                                                    >
                                                        <AutoScrollLabel
                                                            text={String(track.albumName || 'Unknown Album')}
                                                            className="playlists-track-album-label"
                                                        />
                                                    </button>
                                                    <div className="playlists-track-added">{formatTrackAddedDate(track.addedAt)}</div>
                                                    <div className="playlists-track-duration">{track.duration || '--:--'}</div>
                                                    <div className="playlists-track-actions t-act">
                                                        <button
                                                            type="button"
                                                            className={`btn-mini btn-playlist ${isPlaylistAdded ? 'is-feedback' : ''}`}
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                onAddTrackToPlaylist(track);
                                                            }}
                                                            title={isPlaylistAdded ? "Added to Playlist" : "Add to Playlist"}
                                                            aria-label={isPlaylistAdded ? "Added to playlist" : "Add to playlist"}
                                                        >
                                                            <Icon name={isPlaylistAdded ? "doubleCheck" : "plus"} size={15} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn-mini btn-share"
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                onShareTrack(track);
                                                            }}
                                                            title="Share track link"
                                                            aria-label="Share track link"
                                                        >
                                                            <Icon name="link" size={14} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn-mini btn-download"
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                onDownloadTrack(track);
                                                            }}
                                                            title="Download track"
                                                            aria-label="Download track"
                                                        >
                                                            <Icon name="download" size={14} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn-mini btn-queue"
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                onAddTrackToQueue(track);
                                                            }}
                                                            title="Add to Manual Queue"
                                                            aria-label="Add to manual queue"
                                                        >
                                                            <Icon name="list" size={14} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn-mini btn-remove"
                                                            onClick={(event) => {
                                                                event.preventDefault();
                                                                event.stopPropagation();
                                                                handleRemoveTrack(index);
                                                            }}
                                                            title="Remove from playlist"
                                                            aria-label={`Remove ${track.title} from playlist`}
                                                        >
                                                            <Icon name="listX" size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {shouldVirtualizeIdentifierTracks && identifierVirtualBottomPadding > 0 ? (
                                            <div
                                                className="playlist-identifier-virtual-spacer"
                                                aria-hidden="true"
                                                style={{ height: `${identifierVirtualBottomPadding}px` }}
                                            />
                                        ) : null}
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </>
            )}
            {textDialog ? (
                <div className="playlist-dialog-overlay" role="presentation">
                    <div className="playlist-dialog-backdrop" onClick={() => setTextDialog(null)}></div>
                    <div
                        className="playlist-dialog-shell"
                        role="dialog"
                        aria-modal="true"
                        aria-label={textDialog.mode === 'create' ? 'Create playlist' : 'Edit playlist'}
                    >
                        <div className="playlist-dialog-header">
                            <h3 className="f-header playlist-dialog-title">
                                {textDialog.mode === 'create' ? 'Create Playlist' : 'Edit Playlist'}
                            </h3>
                            <button
                                type="button"
                                className="q-close-btn"
                                onClick={() => setTextDialog(null)}
                                aria-label="Close playlist dialog"
                            >
                                <Icon name="close" size={18} />
                            </button>
                        </div>
                        <form className="playlist-dialog-body" onSubmit={submitTextDialog}>
                            <label className="playlist-dialog-label" htmlFor="playlist-dialog-name">
                                Playlist name
                            </label>
                            <input
                                id="playlist-dialog-name"
                                type="text"
                                className="playlist-picker-input playlist-dialog-input"
                                value={textDialog.value}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setTextDialog((prev) => (prev ? { ...prev, value, error: '' } : prev));
                                }}
                                maxLength={60}
                                autoFocus
                            />
                            <label className="playlist-dialog-label" htmlFor="playlist-dialog-byline">
                                By (optional)
                            </label>
                            <input
                                id="playlist-dialog-byline"
                                type="text"
                                className="playlist-picker-input playlist-dialog-input"
                                value={textDialog.byline}
                                onChange={(event) => {
                                    const byline = event.target.value;
                                    setTextDialog((prev) => (prev ? { ...prev, byline, error: '' } : prev));
                                }}
                                placeholder="Leave blank to not add"
                                maxLength={80}
                            />
                            {textDialog.error ? <div className="playlist-picker-error">{textDialog.error}</div> : null}
                            <div className="playlist-dialog-actions">
                                <button
                                    type="button"
                                    className="btn-main album-hero-action-btn"
                                    onClick={() => setTextDialog(null)}
                                >
                                    Cancel
                                </button>
                                <button type="submit" className="btn-main album-hero-action-btn">
                                    {textDialog.mode === 'create' ? 'Create' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            ) : null}
            {deleteDialog ? (
                <div className="playlist-dialog-overlay" role="presentation">
                    <div className="playlist-dialog-backdrop" onClick={() => setDeleteDialog(null)}></div>
                    <div
                        className="playlist-dialog-shell"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Delete playlist"
                    >
                        <div className="playlist-dialog-header">
                            <h3 className="f-header playlist-dialog-title">Delete Playlist</h3>
                            <button
                                type="button"
                                className="q-close-btn"
                                onClick={() => setDeleteDialog(null)}
                                aria-label="Close delete playlist dialog"
                            >
                                <Icon name="close" size={18} />
                            </button>
                        </div>
                        <div className="playlist-dialog-body">
                            <p className="playlist-dialog-message">
                                Delete playlist "{deleteDialog.name}"?
                            </p>
                            <div className="playlist-dialog-actions">
                                <button
                                    type="button"
                                    className="btn-main album-hero-action-btn"
                                    onClick={() => setDeleteDialog(null)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn-main album-hero-action-btn playlist-delete-btn"
                                    onClick={confirmDeleteDialog}
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
            <div className="sr-only" aria-live="polite">{liveMessage}</div>
        </div>
    );
};
