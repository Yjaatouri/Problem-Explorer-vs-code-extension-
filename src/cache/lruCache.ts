/** Least-recently-used cache backed by a `Map` (insertion order). O(1) get/set/delete. */
export class LruCache<K, V> {
  private readonly map: Map<K, V>;
  private readonly capacity: number;

  /**
   * @param capacity — maximum entries before eviction. Must be >= 1.
   */
  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error(`LRU capacity must be >= 1, got ${capacity}`);
    }
    this.map = new Map();
    this.capacity = capacity;
  }

  /** Retrieve a value, promoting it to most-recently-used. Returns `undefined` if missing. */
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Insert or update a key. Evicts the least-recently-used entry if at capacity. */
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
  }

  /** Check existence without affecting recency order */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Remove a single entry. Returns `true` if the key existed. */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Remove all entries */
  clear(): void {
    this.map.clear();
  }

  /** Iterate entries in recency order (least-recent first) */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  /** Current number of entries */
  get size(): number {
    return this.map.size;
  }
}
