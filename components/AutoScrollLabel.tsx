import React, { useState, useEffect, useRef, useCallback } from 'react';

export const AutoScrollLabel = React.memo(({ text, className, style, forceHover }: any) => {
    const [isOverflowing, setIsOverflowing] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLSpanElement>(null);
    const measureRafRef = useRef<number | null>(null);

    const measureOverflow = useCallback(() => {
        if (!containerRef.current || !textRef.current) return;
        const containerWidth = containerRef.current.clientWidth;
        const textWidth = textRef.current.scrollWidth;
        setIsOverflowing(textWidth > containerWidth + 1);
    }, []);

    const scheduleMeasure = useCallback(() => {
        if (measureRafRef.current !== null) return;
        measureRafRef.current = requestAnimationFrame(() => {
            measureRafRef.current = null;
            measureOverflow();
        });
    }, [measureOverflow]);

    useEffect(() => {
        return () => {
            if (measureRafRef.current !== null) {
                cancelAnimationFrame(measureRafRef.current);
                measureRafRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        scheduleMeasure();
    }, [forceHover, scheduleMeasure, text]);

    useEffect(() => {
        const supportsObserver = typeof ResizeObserver !== 'undefined';
        const observer = supportsObserver ? new ResizeObserver(() => scheduleMeasure()) : null;
        if (observer) {
            if (containerRef.current) observer.observe(containerRef.current);
            return () => {
                observer.disconnect();
            };
        }

        const onResize = () => scheduleMeasure();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [scheduleMeasure]);

    const active = Boolean(forceHover) || isHovered;
    const showMarquee = active && isOverflowing;
    const underlineActive = !!isHovered && /(?:^|\s)(home-album-card-title|liked-album-card-title|playlists-track-album-label)(?:\s|$)/.test(String(className || ''));
    const duration = textRef.current ? (textRef.current.offsetWidth / 30 + 5) : 5;
    const gap = '2rem';
    const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);

    const maskValue = showMarquee && !isFirefox
        ? 'linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%)'
        : 'none';

    return (
        <div
            ref={containerRef}
            className={className}
            style={{
                ...style,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                position: 'relative',
                display: 'block',
                maskImage: maskValue,
                WebkitMaskImage: maskValue,
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div
                style={{
                    display: 'inline-flex',
                    width: showMarquee ? 'max-content' : '100%',
                    transform: 'translate3d(0, 0, 0)',
                    willChange: showMarquee ? 'transform' : undefined,
                    animation: showMarquee ? `marquee-scroll ${duration}s linear infinite` : 'none',
                    '--marquee-end': textRef.current ? `calc(-1 * (${textRef.current.offsetWidth}px + ${gap}))` : '0px'
                } as React.CSSProperties}
            >
                <span
                    ref={textRef}
                    style={{
                        display: 'block',
                        textOverflow: showMarquee ? 'clip' : 'ellipsis',
                        overflow: showMarquee ? 'visible' : 'hidden',
                        textDecorationLine: underlineActive ? 'underline' : 'none',
                        textUnderlineOffset: '0.14em',
                        textDecorationThickness: '1px',
                    }}
                >
                    {text}
                </span>
                {showMarquee && (
                    <>
                        <span style={{ display: 'inline-block', width: gap, flexShrink: 0 }}></span>
                        <span
                            style={{
                                textDecorationLine: underlineActive ? 'underline' : 'none',
                                textUnderlineOffset: '0.14em',
                                textDecorationThickness: '1px',
                            }}
                        >
                            {text}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
});
