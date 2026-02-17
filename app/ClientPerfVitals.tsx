'use client';

import { useEffect, useRef } from 'react';
import { useReportWebVitals } from 'next/web-vitals';

type VitalName = 'INP' | 'LCP' | 'CLS';

const INTERESTING_VITALS = new Set<VitalName>(['INP', 'LCP', 'CLS']);
const LONG_TASK_WARN_MS = 120;
const PERF_SAMPLER_INTERVAL_MS = 10_000;
const PERF_SAMPLER_HEAP_DELTA_WARN_BYTES = 18 * 1024 * 1024;
const PERF_SAMPLER_RENDERED_CARD_WARN_COUNT = 950;
const PERF_SAMPLER_SEARCH_RESULT_WARN_COUNT = 5_000;
const PERF_SAMPLER_BROWSE_ITEM_WARN_COUNT = 1_500;

const PERF_BUDGET_MS: Record<string, number> = {
    perf_queue_toggle_to_visible: 220,
    perf_queue_close_to_hidden: 220,
    perf_queue_enqueue_commit: 180,
    perf_queue_visible_to_first_row: 220,
    perf_gallery_open_to_visible: 240,
    perf_gallery_visible_to_first_image: 350,
};

type MemoryWithJsHeap = {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
};

export type PerfSamplerMetrics = {
    renderedCardCount: number;
    searchResultCount: number;
    browseItemCount: number;
    albumCacheSize: number;
    resolveCacheSize: number;
    view: string;
    isSearchMode: boolean;
};

type ClientPerfVitalsProps = {
    samplerMetrics?: PerfSamplerMetrics;
};

export function ClientPerfVitals({ samplerMetrics }: ClientPerfVitalsProps) {
    const samplerMetricsRef = useRef<PerfSamplerMetrics | undefined>(samplerMetrics);
    const lastHeapSampleRef = useRef<number | null>(null);
    samplerMetricsRef.current = samplerMetrics;

    useReportWebVitals((metric) => {
        if (process.env.NODE_ENV !== 'development') return;
        if (!INTERESTING_VITALS.has(metric.name as VitalName)) return;
        const value = typeof metric.value === 'number' ? metric.value.toFixed(2) : String(metric.value);
        console.info(`[perf:vital] ${metric.name}=${value}`, metric);
    });

    useEffect(() => {
        if (process.env.NODE_ENV !== 'development') return;
        if (typeof window === 'undefined') return;
        if (!('PerformanceObserver' in window)) return;

        const PerfObserver = window.PerformanceObserver as typeof PerformanceObserver | undefined;
        if (!PerfObserver) return;

        let observer: PerformanceObserver | null = null;
        try {
            observer = new PerfObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.entryType !== 'longtask') continue;
                    if (entry.duration < LONG_TASK_WARN_MS) continue;
                    console.warn(`[perf:longtask] ${entry.duration.toFixed(1)}ms`, entry);
                }
            });
            observer.observe({ type: 'longtask', buffered: true as any });
        } catch {
        }

        let measureObserver: PerformanceObserver | null = null;
        try {
            measureObserver = new PerfObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.entryType !== 'measure') continue;
                    const budgetMs = PERF_BUDGET_MS[entry.name];
                    if (!budgetMs) continue;
                    if (entry.duration <= budgetMs) continue;
                    console.warn(`[perf:budget] ${entry.name} ${entry.duration.toFixed(1)}ms > ${budgetMs}ms`, entry);
                }
            });
            measureObserver.observe({ type: 'measure', buffered: true as any });
        } catch {
        }

        return () => {
            observer?.disconnect();
            measureObserver?.disconnect();
        };
    }, []);

    useEffect(() => {
        if (process.env.NODE_ENV !== 'development') return;
        if (typeof window === 'undefined') return;

        const tick = () => {
            const metrics = samplerMetricsRef.current;
            if (!metrics) return;

            const perfMemory = (window.performance as Performance & { memory?: MemoryWithJsHeap }).memory;
            const usedJsHeap = typeof perfMemory?.usedJSHeapSize === 'number'
                ? perfMemory.usedJSHeapSize
                : null;
            const previousHeap = lastHeapSampleRef.current;
            if (usedJsHeap !== null) {
                lastHeapSampleRef.current = usedJsHeap;
            }
            const heapDelta = (usedJsHeap !== null && previousHeap !== null) ? (usedJsHeap - previousHeap) : null;
            const heapDeltaMb = heapDelta !== null ? (heapDelta / (1024 * 1024)) : null;
            const usedHeapMb = usedJsHeap !== null ? (usedJsHeap / (1024 * 1024)) : null;

            const payload = {
                view: metrics.view,
                isSearchMode: metrics.isSearchMode,
                renderedCardCount: metrics.renderedCardCount,
                searchResultCount: metrics.searchResultCount,
                browseItemCount: metrics.browseItemCount,
                albumCacheSize: metrics.albumCacheSize,
                resolveCacheSize: metrics.resolveCacheSize,
                usedJsHeapMb: usedHeapMb !== null ? Number(usedHeapMb.toFixed(1)) : null,
                heapDeltaMb: heapDeltaMb !== null ? Number(heapDeltaMb.toFixed(1)) : null,
            };

            console.info('[perf:sampler]', payload);

            if (metrics.renderedCardCount > PERF_SAMPLER_RENDERED_CARD_WARN_COUNT) {
                console.warn(`[perf:sampler] rendered cards high: ${metrics.renderedCardCount}`);
            }
            if (metrics.searchResultCount > PERF_SAMPLER_SEARCH_RESULT_WARN_COUNT) {
                console.warn(`[perf:sampler] search results high: ${metrics.searchResultCount}`);
            }
            if (metrics.browseItemCount > PERF_SAMPLER_BROWSE_ITEM_WARN_COUNT) {
                console.warn(`[perf:sampler] browse items high: ${metrics.browseItemCount}`);
            }
            if (heapDelta !== null && heapDelta > PERF_SAMPLER_HEAP_DELTA_WARN_BYTES) {
                const mb = (heapDelta / (1024 * 1024)).toFixed(1);
                console.warn(`[perf:sampler] heap increased by ${mb}MB in ${PERF_SAMPLER_INTERVAL_MS / 1000}s`);
            }
        };

        tick();
        const intervalId = window.setInterval(tick, PERF_SAMPLER_INTERVAL_MS);
        return () => window.clearInterval(intervalId);
    }, []);

    return null;
}
