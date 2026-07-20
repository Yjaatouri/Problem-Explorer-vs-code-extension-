import { CancellationToken, FileDecoration, Uri } from 'vscode';
import { DecorationEngine } from '../../decoration/decorationEngine';
import { TelemetryReporter } from '../../telemetry';
import { TelemetryEvent, generateTraceId } from '../../telemetry';

/** Structured event payload for fireDidChange */
export interface DecorationFireDidChangeEventData extends TelemetryEvent {
  readonly type: 'decoration.fireDidChange';
  readonly callType: 'full' | 'array' | 'single';
  readonly uriCount: number;
  readonly executionTimeMs: number;
}

/** Structured event payload for provideFileDecoration */
export interface DecorationProvideEventData extends TelemetryEvent {
  readonly type: 'decoration.provideFileDecoration';
  readonly uri: string;
  readonly hit: boolean;
  readonly badge: string | undefined;
  readonly executionTimeMs: number;
}

/** Union of all decoration monitor event types */
export type DecorationMonitorEvent =
  | DecorationFireDidChangeEventData
  | DecorationProvideEventData;

/** Monitors DecorationEngine activity by wrapping fireDidChange and provideFileDecoration */
export class DecorationMonitor {
  private readonly originalFireDidChange: (uris: Uri | Uri[] | undefined) => void;
  private readonly originalProvideFileDecoration: (uri: Uri, token: CancellationToken) => FileDecoration | undefined;
  private disposed = false;

  constructor(
    private readonly engine: DecorationEngine,
    private readonly reporter: TelemetryReporter
  ) {
    this.originalFireDidChange = engine.fireDidChange.bind(engine);
    this.originalProvideFileDecoration = engine.provideFileDecoration.bind(engine);

    const self = this;

    engine.fireDidChange = function (uris: Uri | Uri[] | undefined): void {
      if (self.disposed) {
        self.originalFireDidChange(uris);
        return;
      }
      const start = Date.now();
      let callType: 'full' | 'array' | 'single';
      let uriCount: number;
      if (uris === undefined) {
        callType = 'full';
        uriCount = 0;
      } else if (Array.isArray(uris)) {
        callType = 'array';
        uriCount = uris.length;
      } else {
        callType = 'single';
        uriCount = 1;
      }

      self.originalFireDidChange(uris);

      const event: DecorationFireDidChangeEventData = {
        type: 'decoration.fireDidChange',
        timestamp: Date.now(),
        traceId: generateTraceId(),
        source: 'DecorationMonitor',
        callType,
        uriCount,
        executionTimeMs: Date.now() - start,
      };
      self.reporter.report(event);
    };

    engine.provideFileDecoration = function (
      uri: Uri,
      token: CancellationToken,
    ): FileDecoration | undefined {
      if (self.disposed) {
        return self.originalProvideFileDecoration(uri, token);
      }
      const start = Date.now();
      const result = self.originalProvideFileDecoration(uri, token);

      if (result instanceof Promise) {
        // original returned a Promise — pass through without wrapping (async timing not tracked)
        return result as unknown as FileDecoration | undefined;
      }

      self.reportProvide(uri, result, Date.now() - start);
      return result;
    };
  }

  private reportProvide(uri: Uri, result: FileDecoration | undefined | null, elapsed: number): void {
    const event: DecorationProvideEventData = {
      type: 'decoration.provideFileDecoration',
      timestamp: Date.now(),
      traceId: generateTraceId(),
      source: 'DecorationMonitor',
      uri: uri.toString(),
      hit: result !== undefined && result !== null,
      badge: result?.badge,
      executionTimeMs: elapsed,
    };
    this.reporter.report(event);
  }

  /** Restore original methods and stop monitoring */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.fireDidChange = this.originalFireDidChange;
    this.engine.provideFileDecoration = this.originalProvideFileDecoration;
  }
}

/** Create a DecorationMonitor attached to the given engine and reporter */
export function createDecorationMonitor(
  engine: DecorationEngine,
  reporter: TelemetryReporter
): DecorationMonitor {
  return new DecorationMonitor(engine, reporter);
}