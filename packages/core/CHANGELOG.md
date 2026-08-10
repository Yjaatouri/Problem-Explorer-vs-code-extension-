# @pe/core

## 1.0.0

### Major Changes

- Release v1.0.0: workspace diagnostics engine for the Problem Explorer family.

  Engine pipeline (M1–M7): `WorkspaceIndex` → `ImpactAnalyzer` → `ScanScheduler` →
  `ProblemStore`, exposed via `DiagnosticsAPI`; provider SDK/base with tsc, eslint,
  ruff, and vscode-realtime adapters. Performance-validated at 50k files with
  linear scaling (see docs/benchmarks.md).
