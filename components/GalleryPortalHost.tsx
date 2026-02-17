'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { createPortal } from 'react-dom';
import { LoadingIndicator } from './LoadingIndicator';

const GalleryModal = dynamic(
    () => import('./GalleryModal').then((mod) => mod.GalleryModal),
    {
        ssr: false,
        loading: () => (
            <div className="gallery-modal-loading">
                <LoadingIndicator />
            </div>
        ),
    }
);

const GALLERY_CLOSE_FALLBACK_MS = 220;

type GalleryPhase = 'closed' | 'opening' | 'open' | 'closing';

type GalleryPayload = {
    images: string[];
    thumbs?: string[];
    initialIndex?: number;
};

export type GalleryPortalHostHandle = {
    open: (payload: GalleryPayload) => void;
    close: () => void;
};

type GalleryPortalHostProps = {
    onVisibilityApplied?: (visible: boolean) => void;
    onFirstImageLoaded?: () => void;
};

export const GalleryPortalHost = React.memo(forwardRef<GalleryPortalHostHandle, GalleryPortalHostProps>(function GalleryPortalHost(
    { onVisibilityApplied, onFirstImageLoaded },
    ref
) {
    const [phase, setPhase] = useState<GalleryPhase>('closed');
    const [payload, setPayload] = useState<GalleryPayload | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const close = useCallback(() => {
        setPhase((prev) => {
            if (prev === 'closed' || prev === 'closing') return prev;
            onVisibilityApplied?.(false);
            return 'closing';
        });
    }, [onVisibilityApplied]);

    useImperativeHandle(ref, () => ({
        open: (nextPayload) => {
            const normalizedImages = Array.isArray(nextPayload?.images)
                ? nextPayload.images.map((value) => String(value || '').trim()).filter(Boolean)
                : [];
            const normalizedThumbs = Array.isArray(nextPayload?.thumbs)
                ? nextPayload.thumbs.map((value) => String(value || '').trim())
                : [];

            if (normalizedImages.length === 0 && normalizedThumbs.length === 0) return;

            setPayload({
                images: normalizedImages.length > 0 ? normalizedImages : normalizedThumbs,
                thumbs: normalizedThumbs,
                initialIndex: Number.isFinite(nextPayload?.initialIndex as number) ? Number(nextPayload.initialIndex) : 0,
            });
            setPhase('opening');
        },
        close,
    }), [close]);

    useEffect(() => {
        if (phase !== 'opening') return;
        const rafId = window.requestAnimationFrame(() => {
            onVisibilityApplied?.(true);
            setPhase('open');
        });
        return () => window.cancelAnimationFrame(rafId);
    }, [onVisibilityApplied, phase]);

    useEffect(() => {
        if (phase !== 'closing') return;
        const node = contentRef.current;
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            setPhase('closed');
            setPayload(null);
        };

        const onTransitionEnd = (event: TransitionEvent) => {
            if (event.target !== node) return;
            if (event.propertyName !== 'transform' && event.propertyName !== 'opacity') return;
            settle();
        };

        node?.addEventListener('transitionend', onTransitionEnd);
        const timeoutId = window.setTimeout(settle, GALLERY_CLOSE_FALLBACK_MS);

        return () => {
            node?.removeEventListener('transitionend', onTransitionEnd);
            window.clearTimeout(timeoutId);
        };
    }, [phase]);

    useEffect(() => {
        const shouldLockBody = phase !== 'closed';
        document.body.style.overflow = shouldLockBody ? 'hidden' : '';
        return () => {
            document.body.style.overflow = '';
        };
    }, [phase]);

    useEffect(() => {
        if (phase === 'closed') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [close, phase]);

    if (phase === 'closed' || !payload || typeof document === 'undefined') return null;

    const isVisible = phase === 'opening' || phase === 'open';

    return createPortal(
        <div className={`gallery-overlay ${isVisible ? 'visible' : ''}`} onClick={close}>
            <div className="gallery-content" ref={contentRef} onClick={(event) => event.stopPropagation()}>
                <GalleryModal
                    images={payload.images}
                    thumbs={payload.thumbs}
                    initialIndex={payload.initialIndex}
                    onClose={close}
                    onFirstImageLoaded={onFirstImageLoaded}
                />
            </div>
        </div>,
        document.body
    );
}));

GalleryPortalHost.displayName = 'GalleryPortalHost';
