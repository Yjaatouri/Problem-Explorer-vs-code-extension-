import {
  commands,
  Disposable,
  StatusBarAlignment,
  StatusBarItem,
  window,
} from 'vscode';
import { ProblemStore } from '../store/ProblemStore';

export class StatusBarManager implements Disposable {
  private readonly item: StatusBarItem;
  private readonly store: ProblemStore;
  private enabled = true;

  constructor(store: ProblemStore) {
    this.store = store;
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 0);
    this.item.name = 'Problem Explorer';
    this.item.command = 'problemExplorer.showStatus';
    this.item.tooltip = 'Problem Explorer — click to open Problems panel';
  }

  update(): void {
    if (!this.enabled) {
      this.item.hide();
      return;
    }

    const totals = this.store.computeTotals();
    const hasAny = totals.errorCount + totals.warningCount + totals.infoCount > 0;

    if (!hasAny) {
      this.item.hide();
      return;
    }

    const parts: string[] = [];
    if (totals.errorCount > 0) {
      parts.push(`$(error)${totals.errorCount}`);
    }
    if (totals.warningCount > 0) {
      parts.push(`$(warning)${totals.warningCount}`);
    }
    if (totals.infoCount > 0) {
      parts.push(`$(info)${totals.infoCount}`);
    }
    this.item.text = parts.join('  ');
    this.item.show();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.update();
    } else {
      this.item.hide();
    }
  }

  registerCommand(): Disposable {
    // Intentionally internal — not declared in package.json contributes.commands.
    // This is a status bar click handler (opens Problems panel), not a user-facing palette command.
    return commands.registerCommand('problemExplorer.showStatus', () => {
      commands.executeCommand('workbench.actions.view.problems');
    });
  }

  dispose(): void {
    this.item.dispose();
  }
}
