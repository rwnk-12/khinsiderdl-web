import React from 'react';

type TabHeaderProps = {
    title: string;
    subtitle?: React.ReactNode;
    density?: 'default' | 'compact';
    actions?: React.ReactNode;
    className?: string;
};

export const TabHeader: React.FC<TabHeaderProps> = ({
    title,
    subtitle,
    density = 'default',
    actions,
    className,
}) => {
    const classes = ['liked-view-header'];
    if (density === 'compact') {
        classes.push('tab-view-header-compact');
    }
    if (className) {
        classes.push(className);
    }

    return (
        <div className={classes.join(' ')}>
            <h1 className="f-header tab-view-title">{title}</h1>
            {subtitle !== undefined && subtitle !== null && subtitle !== '' ? (
                <div className="f-ui tab-view-subtitle">{subtitle}</div>
            ) : null}
            {actions}
        </div>
    );
};

