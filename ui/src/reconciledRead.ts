/** Share reads while preserving one fresh check after an in-flight read. */
export class ReconciledRead<T> {
  private pending: Promise<T> | null = null;
  private trailing: { after: Promise<T>; result: Promise<T> } | null = null;

  get active() { return this.pending !== null || this.trailing !== null; }

  read(fetch: () => Promise<T>, reconcile = false): Promise<T> {
    const pending = this.pending;
    if (pending) {
      if (!reconcile) return pending;
      if (this.trailing?.after === pending) return this.trailing.result;
      // All events during this read share a single subsequent check. An event
      // during that subsequent check can request one more, so a revocation in
      // the gap is never swallowed by deduplication.
      const next = () => this.pending ?? this.read(fetch);
      const result = pending.then(next, next).finally(() => {
        if (this.trailing?.result === result) this.trailing = null;
      });
      this.trailing = { after: pending, result };
      return result;
    }
    const request = Promise.resolve().then(fetch).finally(() => {
      if (this.pending === request) this.pending = null;
    });
    this.pending = request;
    return request;
  }
}
