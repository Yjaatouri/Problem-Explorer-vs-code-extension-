import { Uri } from 'vscode';
import { FolderStatusManager } from '../../folder/folderStatusManager';
import { TelemetryReporter } from '../../telemetry';
import { generateTraceId } from '../../telemetry';

/** Structured event payload for updateAncestors */
export interface FolderUpdateAncestorsEventData {
  readonly type: 'folder.updateAncestors';
  readonly uri: string;
  readonly changedCount: number;
  readonly indexSize: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for rebuildAll */
export interface FolderRebuildAllEventData {
  readonly type: 'folder.rebuildAll';
  readonly changedCount: number;
  readonly indexSize: number;
  readonly executionTimeMs: number;
}

/** Union of all folder monitor event types */
export type FolderMonitorEvent =
  | FolderUpdateAncestorsEventData
  | FolderRebuildAllEventData;

/** Monitors FolderStatusManager by wrapping updateAncestors and rebuildAll */
export class FolderMonitor {
  private readonly originalUpdateAncestors: (fileUri: Uri) => Uri[];
  private readonly originalRebuildAll: () => Uri[];
  private disposed = false;

  constructor(
    private readonly folderManager: FolderStatusManager,
    private readonly reporter: TelemetryReporter
  ) {
    this.originalUpdateAncestors = folderManager.updateAncestors.bind(folderManager);
    this.originalRebuildAll = folderManager.rebuildAll.bind(folderManager);

    const self = this;

    folderManager.updateAncestors = function (fileUri: Uri): Uri[] {
      if (self.disposed) return self.originalUpdateAncestors(fileUri);
      const start = Date.now();
      const changed = self.originalUpdateAncestors(fileUri);

      self.reporter.report({
        type: 'folder.updateAncestors',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        uri: fileUri.toString(),
        changedCount: changed.length,
        indexSize: (self.folderManager as any).childIndex?.size ?? 0,
        executionTimeMs: Date.now() - start,
      } as any);

      return changed;
    };

    folderManager.rebuildAll = function (): Uri[] {
      if (self.disposed) return self.originalRebuildAll();
      const start = Date.now();
      const changed = self.originalRebuildAll();

      self.reporter.report({
        type: 'folder.rebuildAll',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'FolderMonitor',
        changedCount: changed.length,
        indexSize: (self.folderManager as any).childIndex?.size ?? 0,
        executionTimeMs: Date.now() - start,
      } as any);

      return changed;
    };
  }

  /** Restore original methods and stop monitoring */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.folderManager.updateAncestors = this.originalUpdateAncestors;
    this.folderManager.rebuildAll = this.originalRebuildAll;
  }
}

/** Create a FolderMonitor attached to the given FolderStatusManager and reporter */
export function createFolderMonitor(
  folderManager: FolderStatusManager,
  reporter: TelemetryReporter
): FolderMonitor {
  return new FolderMonitor(folderManager, reporter);
}