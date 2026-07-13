let logger: ((msg: string) => void) | undefined;

export function initForensicLogger(logFn: (msg: string) => void): void {
  logger = logFn;
}

export function forensicLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  logger?.(line);
  console.log(`[PE-FOR] ${line}`);
}
