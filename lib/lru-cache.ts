export class LruCache<K, V> {
    private readonly store: Map<K, V>;
    private readonly maxEntries: number;

    constructor(maxEntries: number) {
        const safeMax = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
        this.maxEntries = safeMax;
        this.store = new Map<K, V>();
    }

    get size() {
        return this.store.size;
    }

    has(key: K) {
        return this.store.has(key);
    }

    get(key: K): V | undefined {
        if (!this.store.has(key)) return undefined;
        const value = this.store.get(key) as V;
        this.store.delete(key);
        this.store.set(key, value);
        return value;
    }

    set(key: K, value: V) {
        if (this.store.has(key)) {
            this.store.delete(key);
        }
        this.store.set(key, value);
        this.prune();
    }

    delete(key: K) {
        return this.store.delete(key);
    }

    clear() {
        this.store.clear();
    }

    private prune() {
        while (this.store.size > this.maxEntries) {
            const oldest = this.store.keys().next();
            if (oldest.done) break;
            this.store.delete(oldest.value);
        }
    }
}
