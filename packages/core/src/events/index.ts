// Typed event system: an `Event<T>` property pattern (VS Code style),
// backed by a small synchronous emitter. No `vscode` dependency.

/** Something that can be cleaned up when no longer needed */
export interface Disposable {
  dispose(): void;
}

type EventHandler<T> = (data: T) => void;

/**
 * Type-safe event channel.
 * Subscription returns a Disposable — the engine never leaks listeners
 * when consumers dispose (see agentRead §7.4.5).
 */
export type Event<T> = {
  (listener: (data: T) => void): Disposable;
};

/** Synchronous emitter with fire/once/clear + listener accounting */
export class TypedEventEmitter<T> {
  private readonly handlers = new Set<EventHandler<T>>();

  on(handler: EventHandler<T>): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  once(handler: EventHandler<T>): Disposable {
    const wrapper: EventHandler<T> = (data) => {
      this.handlers.delete(wrapper);
      handler(data);
    };
    this.handlers.add(wrapper);
    return {
      dispose: () => {
        this.handlers.delete(wrapper);
      },
    };
  }

  /** Fire to all subscribers synchronously. One bad handler never breaks the rest. */
  fire(data: T): void {
    for (const handler of this.handlers) {
      try {
        handler(data);
      } catch (error) {
        // A subscriber throwing must not break the engine (rule 5: engine never crashes)
        console.error('[TypedEventEmitter] handler error:', error);
      }
    }
  }

  get listenerCount(): number {
    return this.handlers.size;
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Helper to create an `Event` property + fire methods */
export function createEvent<T>(): {
  event: Event<T>;
  fire: (data: T) => void;
} {
  const emitter = new TypedEventEmitter<T>();
  return {
    event: (listener) => emitter.on(listener),
    fire: (data) => emitter.fire(data),
  };
}
