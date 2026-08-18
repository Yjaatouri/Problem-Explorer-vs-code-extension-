import type { ProblemTotals } from '@pe/api';

/** The vscode StatusBarItem surface (implemented in extension.ts). */
export interface StatusBarItemLike {
  readonly name?: string;
  command?: unknown;
  tooltip?: unknown;
  text?: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** Live engine reader so rebuilds don't stale the bar. */
export interface TotalsProvider {
  getTotals(): ProblemTotals;
}

/** Status bar mirroring engine totals + scan state. No vscode imports. */
export class StatusBarManager {
  private enabled = true;
  private scanning = false;

  constructor(
    private readonly totals: TotalsProvider,
    private readonly item: StatusBarItemLike,
  ) {
    this.item.command = 'problemExplorer.scanWorkspace';
    this.item.tooltip = 'Problem Explorer — click to scan workspace';
  }

  /** Re-render from the current engine totals. */
  update(): void {
    if (!this.enabled) {
      this.item.hide();
      return;
    }

    if (this.scanning) {
      this.item.text = '$(sync~spin) Scanning...';
      this.item.tooltip = 'Auto-scan in progress';
      this.item.show();
      return;
    }

    const totals = this.totals.getTotals();
    const parts: string[] = [];
    if (totals.errors > 0) {
      parts.push(`$(error)${totals.errors}`);
    }
    if (totals.warnings > 0) {
      parts.push(`$(warning)${totals.warnings}`);
    }
    if (totals.info > 0) {
      parts.push(`$(info)${totals.info}`);
    }

    if (parts.length > 0) {
      this.item.text = parts.join('  ');
    } else {
      this.item.text = '$(search) Scan';
    }
    this.item.tooltip = 'Problem Explorer — click to scan workspace';
    this.item.show();
  }

  setScanning(scanning: boolean): void {
    this.scanning = scanning;
    this.update();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.update();
    } else {
      this.item.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
  }

  /** Current item text (observability/tests). */
  get text(): string | undefined {
    return this.item.text;
  }
}