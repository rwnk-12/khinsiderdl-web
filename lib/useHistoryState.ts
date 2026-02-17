import { useEffect, useRef } from 'react';

const historyStack: string[] = [];
let suppressedPopEvents = 0;
type TaggedPopStateEvent = PopStateEvent & { __khHandled?: boolean; __khSuppressed?: boolean };

export function consumeSuppressedPopStateEvent(event?: PopStateEvent) {
    const taggedEvent = event as TaggedPopStateEvent | undefined;
    if (taggedEvent?.__khSuppressed) {
        return true;
    }
    if (suppressedPopEvents > 0) {
        suppressedPopEvents -= 1;
        if (taggedEvent) {
            taggedEvent.__khSuppressed = true;
        }
        return true;
    }
    return false;
}

export function useHistoryState(
    key: string,
    isOpen: boolean,
    onClose: () => void
) {
    const isClosingViaBack = useRef(false);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const isPushed = useRef(false);

    useEffect(() => {
        if (isOpen && !isPushed.current) {
            const baseState = (window.history.state && typeof window.history.state === 'object')
                ? window.history.state
                : {};
            window.history.pushState({ ...baseState, historyStateKey: key }, '');
            historyStack.push(key);
            isPushed.current = true;
            return;
        }

        if (!isOpen && isPushed.current) {
            const wasTop = historyStack.length > 0 && historyStack[historyStack.length - 1] === key;

            const idx = historyStack.lastIndexOf(key);
            if (idx !== -1) {
                historyStack.splice(idx, 1);
            }

            if (
                !isClosingViaBack.current &&
                wasTop &&
                window.history.state?.historyStateKey === key
            ) {
                suppressedPopEvents += 1;
                window.history.back();
            }

            isPushed.current = false;
            isClosingViaBack.current = false;
        }
    }, [isOpen, key]);

    useEffect(() => {
        const handlePopState = (e: PopStateEvent) => {
            const taggedEvent = e as TaggedPopStateEvent;
            if (consumeSuppressedPopStateEvent(taggedEvent)) {
                return;
            }

            if (taggedEvent.__khHandled) {
                return;
            }

            if (isPushed.current && historyStack.length > 0 && historyStack[historyStack.length - 1] === key) {
                isClosingViaBack.current = true;
                isPushed.current = false;
                historyStack.pop();
                taggedEvent.__khHandled = true;
                onCloseRef.current();
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, [key]);

    useEffect(() => {
        return () => {
            if (isPushed.current) {
                const wasTop = historyStack.length > 0 && historyStack[historyStack.length - 1] === key;
                const idx = historyStack.lastIndexOf(key);
                if (idx !== -1) {
                    historyStack.splice(idx, 1);
                }

                if (wasTop && window.history.state?.historyStateKey === key) {
                    suppressedPopEvents += 1;
                    window.history.back();
                }

                isPushed.current = false;
                isClosingViaBack.current = false;
            }
        };
    }, [key]);
}
