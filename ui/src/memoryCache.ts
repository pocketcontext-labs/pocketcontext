/** Bounded private, in-memory LRU with shared reads and invalidation fencing. */
export class MemoryCache<T> {
  private values = new Map<string, { value: T; bytes: number }>();
  private pending = new Map<string, Promise<T>>();
  private bytes = 0;
  private generation = 0;

  constructor(private maxEntries: number, private maxBytes: number) {}

  clear() {
    this.generation++;
    this.values.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  read(key: string, fetch: () => Promise<T>, retain: (value: T) => boolean = () => true): Promise<T> {
    const cached = this.values.get(key);
    if (cached) {
      this.values.delete(key);
      this.values.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const request = fetch().then(value => {
      if (generation !== this.generation) throw new Error("Reader access changed");
      // Bound serialized UTF-16 content as well as retained result count.
      // This is a content budget, not an exact JS heap measurement. Oversized
      // reads still work without being retained.
      const bytes = JSON.stringify(value).length * 2;
      if (retain(value) && bytes <= this.maxBytes) {
        // Overflow reads of the same key can finish independently.
        const previous = this.values.get(key);
        if (previous) {
          this.values.delete(key);
          this.bytes -= previous.bytes;
        }
        while (this.values.size && (this.values.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)) {
          const oldest = this.values.keys().next().value!;
          this.bytes -= this.values.get(oldest)!.bytes;
          this.values.delete(oldest);
        }
        this.values.set(key, { value, bytes });
        this.bytes += bytes;
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    // Rapid navigation cannot grow the deduplication registry without bound.
    // Overflow reads still complete and remain subject to the same byte budget
    // and access fence; only their pending-promise retention is skipped.
    if (this.pending.size < this.maxEntries) this.pending.set(key, request);
    return request;
  }
}
