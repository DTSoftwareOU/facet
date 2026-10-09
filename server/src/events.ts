export type ChangeListener = (cursor: number) => void;

/** In-process fan-out of "records changed" notifications, keyed by user id. */
export class ChangeBus {
  private readonly listeners = new Map<string, Set<ChangeListener>>();

  subscribe(userId: string, listener: ChangeListener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(userId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(userId);
    };
  }

  publish(userId: string, cursor: number): void {
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(cursor);
      } catch {
        // A broken stream must not affect others.
      }
    }
  }

  listenerCount(userId?: string): number {
    if (userId) return this.listeners.get(userId)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}
