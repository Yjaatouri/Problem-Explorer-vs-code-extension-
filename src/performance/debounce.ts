/** Create a debounced version of `fn` that delays invocation until `delay` ms after the last call. Returns `cancel()` and `flush()` controls. */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): {
  (...args: Args): void;
  cancel(): void;
  flush(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Args | undefined;

  const debounced = function (this: unknown, ...args: Args): void {
    lastArgs = args;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      lastArgs = undefined;
      fn.apply(this, args);
    }, delay);
  };

  debounced.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      lastArgs = undefined;
    }
  };

  debounced.flush = (): void => {
    if (timer !== undefined && lastArgs !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      const args = lastArgs;
      lastArgs = undefined;
      fn(...args);
    }
  };

  return debounced as typeof debounced & { cancel(): void; flush(): void };
}
