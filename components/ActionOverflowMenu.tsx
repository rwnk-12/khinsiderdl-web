import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export type ActionOverflowMenuItem = {
    id: string;
    label: string;
    onSelect: () => void;
    icon?: string;
    disabled?: boolean;
    destructive?: boolean;
};

type ActionOverflowMenuProps = {
    items: ActionOverflowMenuItem[];
    label?: string;
    className?: string;
    buttonClassName?: string;
    menuClassName?: string;
    align?: 'left' | 'right';
};

export const ActionOverflowMenu: React.FC<ActionOverflowMenuProps> = ({
    items,
    label = 'More actions',
    className,
    buttonClassName,
    menuClassName,
    align = 'right',
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        const onMouseDown = (event: MouseEvent) => {
            const root = rootRef.current;
            if (!root) return;
            if (root.contains(event.target as Node)) return;
            setIsOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        };
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('.action-overflow-item:not(:disabled)');
        firstItem?.focus();
    }, [isOpen]);

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const nodes = Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>('.action-overflow-item:not(:disabled)') || []
        );
        if (nodes.length === 0) return;
        event.preventDefault();
        const active = document.activeElement as HTMLButtonElement | null;
        const currentIndex = nodes.findIndex((node) => node === active);
        const nextIndex = event.key === 'ArrowDown'
            ? (currentIndex + 1 + nodes.length) % nodes.length
            : (currentIndex - 1 + nodes.length) % nodes.length;
        nodes[nextIndex]?.focus();
    };

    if (!items.length) return null;

    return (
        <div
            ref={rootRef}
            className={`action-overflow-root ${className || ''}`.trim()}
        >
            <button
                type="button"
                className={`btn-main album-hero-action-btn action-overflow-trigger ${buttonClassName || ''}`.trim()}
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={() => setIsOpen((prev) => !prev)}
            >
                <Icon name="dots" size={14} />
            </button>
            {isOpen ? (
                <div
                    ref={menuRef}
                    className={`action-overflow-menu action-overflow-menu-${align} ${menuClassName || ''}`.trim()}
                    role="menu"
                    aria-label={label}
                    onKeyDown={handleMenuKeyDown}
                >
                    {items.map((item) => {
                        const itemClassName = [
                            'action-overflow-item',
                            item.destructive ? 'is-destructive' : '',
                        ].join(' ').trim();
                        return (
                            <button
                                key={item.id}
                                type="button"
                                role="menuitem"
                                className={itemClassName}
                                disabled={item.disabled}
                                onClick={() => {
                                    if (item.disabled) return;
                                    item.onSelect();
                                    setIsOpen(false);
                                }}
                            >
                                {item.icon ? <Icon name={item.icon} size={13} /> : null}
                                <span>{item.label}</span>
                            </button>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
};
