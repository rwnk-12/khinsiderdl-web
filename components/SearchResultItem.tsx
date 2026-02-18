import React, { useState } from 'react';
import { AutoScrollLabel } from './AutoScrollLabel';

export const SearchResultItem = ({ item, isSelected, onSelect, toTitleCase, deferLoading }: any) => {
    const [isHovered, setIsHovered] = useState(false);
    const [displayedIcon, setDisplayedIcon] = useState(item.icon);

    React.useEffect(() => {
        if (!deferLoading && item.icon !== displayedIcon) {
            setDisplayedIcon(item.icon);
        }
    }, [item.icon, deferLoading, displayedIcon]);

    React.useEffect(() => {
        if (!deferLoading && !displayedIcon && item.icon) {
            setDisplayedIcon(item.icon);
        }
    }, [item.icon]);

    const handleImgError = (e: any) => {
        e.target.style.display = 'none';
    };

    return (
        <div
            onClick={() => onSelect(item)}
            className={`index-item ${isSelected ? 'active' : ''}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {displayedIcon && (
                <img
                    src={displayedIcon}
                    referrerPolicy="no-referrer"
                    className="thumb"
                    onError={handleImgError}
                    alt=""
                    loading="lazy"
                />
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <AutoScrollLabel
                    text={toTitleCase(item.title) || "Unknown Title"}
                    className="f-body"
                    forceHover={isHovered}
                    style={{
                        fontWeight: 'bold',
                        fontSize: '1rem',
                        lineHeight: '1.2',
                        color: '#e2d6b5',
                    }}
                />
            </div>
        </div>
    );

};
