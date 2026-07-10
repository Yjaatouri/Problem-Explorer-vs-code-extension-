export interface BatchCollector<T> {
  add(item: T): void;
  flush(): void;
  cancel(): void;
}

export function batch<T>(
  fn: (items: T[]) => void,
  delay: number,
): BatchCollector<T> {
  const items: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (items.length > 0) {
      const snapshot = items.splice(0, items.length);
      fn(snapshot);
    }
  }

  return {
    add(item: T): void {
      items.push(item);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, delay);
    },
    flush,
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      items.splice(0, items.length);
    },
  };
}
