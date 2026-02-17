import React from 'react';

export const ViewPanel = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => {
    const mergedClassName = className ? `view-fill-height ${className}` : 'view-fill-height';
    return <div className={mergedClassName}>{children}</div>;
};
