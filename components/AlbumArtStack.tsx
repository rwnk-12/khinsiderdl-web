import React from 'react';
import Image from 'next/image';

type AlbumArtStackProps = {
    images: string[];
    onClick: () => void;
    deferLoading?: boolean;
    heroPriority?: boolean;
};

export const AlbumArtStack = ({ images, onClick, deferLoading, heroPriority = false }: AlbumArtStackProps) => {
    const [displayedImages, setDisplayedImages] = React.useState(images);

    const toSmallThumbUrl = (rawUrl: string) => {
        const value = String(rawUrl || '').trim();
        if (!value) return '';
        return value.includes('/thumbs_large/') ? value.replace('/thumbs_large/', '/thumbs_small/') : value;
    };

    React.useEffect(() => {
        if (!deferLoading) {
            setDisplayedImages(images);
        }
    }, [images, deferLoading]);

    if (!displayedImages || displayedImages.length === 0) return null;

    const getDisplaySource = (index: number) => {
        const raw = String(displayedImages[index] || '').trim();
        if (!raw) return '';
        return raw;
    };

    const handleImgError = (index: number) => {
        const currentRaw = String(displayedImages[index] || '').trim();
        if (!currentRaw) return;

        const fallbackSmall = toSmallThumbUrl(currentRaw);
        if (fallbackSmall && fallbackSmall !== currentRaw) {
            setDisplayedImages((prev) => {
                if (!prev[index]) return prev;
                const next = [...prev];
                next[index] = fallbackSmall;
                return next;
            });
            return;
        }

        setDisplayedImages((prev) => {
            if (!prev[index]) return prev;
            const next = [...prev];
            next[index] = '';
            return next;
        });
    };

    if (displayedImages.length === 1) {
        const imageSrc = getDisplaySource(0);
        return (
            <div className="album-cover-frame" onClick={onClick}>
                <div className="album-cover-inner">
                    {imageSrc ? (
                        <Image
                            src={imageSrc}
                            referrerPolicy="no-referrer"
                            className="album-cover"
                            alt="Album cover art"
                            fill
                            sizes="(max-width: 768px) 60vw, 272px"
                            quality={85}
                            loading={heroPriority ? 'eager' : 'lazy'}
                            fetchPriority={heroPriority ? 'high' : 'auto'}
                            onError={() => handleImgError(0)}
                        />
                    ) : (
                        <div className="stack-item-fallback" />
                    )}
                </div>
            </div>
        );
    }

    const stackImages = displayedImages.slice(0, 3);
    return (
        <div className="stack-container" onClick={onClick} title="Click to view all covers">
            {stackImages.slice().reverse().map((img, i) => {
                const sourceIndex = stackImages.length - 1 - i;
                const imageSrc = getDisplaySource(sourceIndex);
                const isPrimaryVisibleImage = i === 0;
                return (
                    <div key={`${sourceIndex}-${img}`} className={`stack-item stack-pos-${i}`}>
                        {imageSrc ? (
                            <Image
                                src={imageSrc}
                                referrerPolicy="no-referrer"
                                alt={`Cover art ${sourceIndex + 1}`}
                                fill
                                sizes="(max-width: 768px) 60vw, 272px"
                                quality={75}
                                loading={heroPriority && isPrimaryVisibleImage ? 'eager' : 'lazy'}
                                fetchPriority={heroPriority && isPrimaryVisibleImage ? 'high' : 'auto'}
                                onError={() => handleImgError(sourceIndex)}
                            />
                        ) : (
                            <div className="stack-item-fallback" />
                        )}
                    </div>
                );
            })}
            <div className="stack-badge">{displayedImages.length}</div>
        </div>
    );
};
