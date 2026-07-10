export function measure(
  label: string,
  fn: () => void,
  iterations: number,
): { label: string; totalMs: number; avgUs: number; ops: number } {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const totalMs = performance.now() - start;
  return {
    label,
    totalMs,
    avgUs: (totalMs / iterations) * 1000,
    ops: Math.round(iterations / (totalMs / 1000)),
  };
}

export function formatResult(r: { label: string; totalMs: number; avgUs: number; ops: number }): string {
  const opsStr = r.ops >= 1000 ? `${(r.ops / 1000).toFixed(1)}k` : String(r.ops);
  return `${r.label}: ${r.totalMs.toFixed(2)}ms total, ${r.avgUs.toFixed(3)}µs avg, ${opsStr} ops/sec`;
}
