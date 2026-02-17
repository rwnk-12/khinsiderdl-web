import React, { useEffect, useRef, useState } from 'react';
import { SimilarAlbumCard } from './SimilarAlbumCard';
import { Icon } from './Icon';

type SimilarAlbum = {
    id?: string;
    url?: string;
    albumId?: string;
    title?: string;
    thumb?: string;
};

const getSimilarAlbumKey = (album: SimilarAlbum, index: number) => {
    const stable = String(album.albumId || album.url || album.id || '').trim();
    if (stable) return stable.toLowerCase();
    const title = String(album.title || '').trim().toLowerCase();
    const thumb = String(album.thumb || '').trim().toLowerCase();
    return `${title || 'untitled'}|${thumb || 'no-thumb'}|${index}`;
};

export const SimilarAlbums = ({
    albums,
    onSelect,
    deferLoading,
    pageShowSignal,
}: {
    albums: SimilarAlbum[];
    onSelect: (album: SimilarAlbum) => void;
    deferLoading?: boolean;
    pageShowSignal?: number;
}) => {
    const [viewMode, setViewMode] = useState<'carousel' | 'grid'>('carousel');
    const [isMobile, setIsMobile] = useState(false);
    const carouselRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const media = window.matchMedia('(max-width: 768px)');
        const update = () => setIsMobile(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        if (isMobile && viewMode !== 'carousel') {
            setViewMode('carousel');
        }
    }, [isMobile, viewMode]);

    const scroll = (direction: 'left' | 'right') => {
        if (carouselRef.current) {
            const scrollAmount = Math.max(360, Math.round(carouselRef.current.clientWidth * 0.72));
            carouselRef.current.scrollBy({
                left: direction === 'left' ? -scrollAmount : scrollAmount,
                behavior: 'smooth'
            });
        }
    };

    return (
        <div className="related-albums">
            <div className="similar-albums-head">
                <h3 className="f-header similar-albums-title">Similar Albums</h3>
                <div className="similar-albums-controls">
                    {!isMobile && (
                        <button
                            className="btn-mini"
                            onClick={() => setViewMode(viewMode === 'carousel' ? 'grid' : 'carousel')}
                            title={viewMode === 'carousel' ? "Switch to Grid" : "Switch to Carousel"}
                        >
                            <Icon name={viewMode === 'carousel' ? "grid" : "list"} size={16} />
                        </button>
                    )}
                </div>
            </div>

            {(isMobile || viewMode === 'carousel') ? (
                <div className="similar-albums-carousel-wrap">
                    <button className="carousel-nav-btn prev desktop-only" onClick={() => scroll('left')}>
                        <Icon name="chevronLeft" size={20} />
                    </button>
                    <div className="album-carousel" ref={carouselRef}>
                        {albums.map((alb, index) => (
                            <SimilarAlbumCard
                                key={getSimilarAlbumKey(alb, index)}
                                album={alb}
                                onSelect={onSelect}
                                deferLoading={deferLoading}
                                pageShowSignal={pageShowSignal}
                            />
                        ))}
                    </div>
                    <button className="carousel-nav-btn next desktop-only" onClick={() => scroll('right')}>
                        <Icon name="chevronRight" size={20} />
                    </button>
                </div>
            ) : (
                <div className="similar-albums-grid">
                    {albums.map((alb, index) => (
                        <SimilarAlbumCard
                            key={getSimilarAlbumKey(alb, index)}
                            album={alb}
                            onSelect={onSelect}
                            deferLoading={deferLoading}
                            pageShowSignal={pageShowSignal}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
