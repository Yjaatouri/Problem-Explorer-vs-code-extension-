export class LruCache<K, V> {
  private readonly _map = new Map<K, V>();
  private readonly _maxSize: number;

  constructor(maxSize: number = 10_000) {
    if (maxSize < 1) throw new Error('maxSize must be >= 1');
    this._maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const val = this._map.get(key);
    if (val !== undefined) {
      this._map.delete(key);
      this._map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._maxSize) {
      const oldest = this._map.keys().next();
      if (!oldest.done) {
        this._map.delete(oldest.value);
      }
    }
    this._map.set(key, value);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  get maxSize(): number {
    return this._maxSize;
  }
}
