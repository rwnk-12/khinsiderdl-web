import React from 'react';

type PlaylistSurfaceCardProps = React.HTMLAttributes<HTMLDivElement> & {
    as?: 'div' | 'section';
};

export const PlaylistSurfaceCard: React.FC<PlaylistSurfaceCardProps> = ({
    as = 'section',
    className,
    children,
    ...rest
}) => {
    const Tag = as;
    return (
        <Tag
            className={`playlist-surface-card ${className || ''}`.trim()}
            {...rest}
        >
            {children}
        </Tag>
    );
};

