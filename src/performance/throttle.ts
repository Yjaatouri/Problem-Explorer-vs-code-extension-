export interface ThrottleOptions {
  leading?: boolean;
  trailing?: boolean;
}

export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  interval: number,
  options?: ThrottleOptions,
): {
  (...args: Args): void;
  cancel(): void;
} {
  const { leading = true, trailing = true } = options ?? {};
  let lastCallTime = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Args | undefined;

  const throttled = function (this: unknown, ...args: Args): void {
    const now = Date.now();
    const elapsed = now - lastCallTime;

    if (lastCallTime === 0 && !leading) {
      lastCallTime = now;
    }

    lastArgs = args;

    if (elapsed >= interval) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      lastCallTime = now;
      fn.apply(this, args);
      return;
    }

    if (trailing && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        lastCallTime = Date.now();
        if (lastArgs !== undefined) {
          fn(...lastArgs);
          lastArgs = undefined;
        }
      }, interval - elapsed);
    }
  };

  throttled.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastArgs = undefined;
    lastCallTime = 0;
  };

  return throttled as typeof throttled & { cancel(): void };
}
