import { Disposable, Uri, workspace } from 'vscode';
import { ScanScheduler } from './ScanScheduler';

export class AutoScanController implements Disposable {
  private readonly disposables: Disposable[] = [];
  private readonly scheduler: ScanScheduler;
  private readonly log: (msg: string) => void;
  private _enabled = true;

  constructor(
    scheduler: ScanScheduler,
    log: (msg: string) => void,
    enabled: boolean = true,
  ) {
    this.scheduler = scheduler;
    this.log = log;
    this._enabled = enabled;
  }

  start(): void {
    this.disposables.push(
      workspace.onDidSaveTextDocument((doc) => {
        this.onFileSave(doc.uri);
      }),
      workspace.onDidCreateFiles((e) => {
        for (const uri of e.files) {
          this.onFileCreate(uri);
        }
      }),
      workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          this.onFileDelete(uri);
        }
      }),
      workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          this.onFileRename(oldUri, newUri);
        }
      }),
    );
  }

  updateConfig(enabled: boolean): void {
    this._enabled = enabled;
  }

  private async onFileSave(uri: Uri): Promise<void> {
    if (!this._enabled) {
      this.log(`[AUTO-SCAN] Skipped: global autoScan disabled`);
      return;
    }
    const result = await this.scheduler.routeFileSave(uri);
    if (result.submitted) {
      this.log(`[AUTO-SCAN] Queued ${result.providerNames.join(', ')} for ${result.reason}`);
    } else {
      this.log(`[AUTO-SCAN] Skipped save: ${result.skipReason}`);
    }
  }

  private async onFileCreate(uri: Uri): Promise<void> {
    if (!this._enabled) {
      this.log(`[AUTO-SCAN] Skipped create: global autoScan disabled`);
      return;
    }
    const result = await this.scheduler.routeFileCreate(uri);
    if (result.submitted) {
      this.log(`[AUTO-SCAN] Queued ${result.providerNames.join(', ')} for ${result.reason}`);
    } else {
      this.log(`[AUTO-SCAN] Skipped create: ${result.skipReason}`);
    }
  }

  private async onFileDelete(uri: Uri): Promise<void> {
    if (!this._enabled) {
      this.log(`[AUTO-SCAN] Skipped delete: global autoScan disabled`);
      return;
    }
    const result = await this.scheduler.routeFileDelete(uri);
    if (result.submitted) {
      this.log(`[AUTO-SCAN] Queued ${result.providerNames.join(', ')} for ${result.reason}`);
    } else {
      this.log(`[AUTO-SCAN] Skipped delete: ${result.skipReason}`);
    }
  }

  private async onFileRename(oldUri: Uri, newUri: Uri): Promise<void> {
    if (!this._enabled) {
      this.log(`[AUTO-SCAN] Skipped rename: global autoScan disabled`);
      return;
    }
    const result = await this.scheduler.routeFileRename(oldUri, newUri);
    if (result.submitted) {
      this.log(`[AUTO-SCAN] Queued ${result.providerNames.join(', ')} for ${result.reason}`);
    } else {
      this.log(`[AUTO-SCAN] Skipped rename: ${result.skipReason}`);
    }
  }

  dispose(): void {
    // No internal timers to clean up — scheduler handles debouncing
  }
}