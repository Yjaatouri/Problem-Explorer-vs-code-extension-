/* ------------------------------------------------------------------ */
/*  Monitoring T11 — FileLogger                                        */
/*  Persists all telemetry to disk for offline forensic analysis       */
/* ------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetrySubscription } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';
import { SnapshotSystem } from './SnapshotSystem';
import { TimelineGenerator } from './TimelineGenerator';

/* ------------------------------------------------------------------ */
/*  Log Session ID                                                     */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const LogSessionIdBrand: unique symbol;
export type LogSessionId = string & { readonly __brand: typeof LogSessionIdBrand };

export function generateLogSessionId(): LogSessionId {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` as LogSessionId;
}

/* ------------------------------------------------------------------ */
/*  Log Level                                                          */
/* ------------------------------------------------------------------ */

export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

/* ------------------------------------------------------------------ */
/*  Log Entry                                                          */
/* ------------------------------------------------------------------ */

export interface LogEntry {
  readonly seq: number;
  readonly sessionId: LogSessionId;
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly source: string;
  readonly type: string;
  readonly data: unknown;
  readonly traceId?: string;
  readonly pipelineId?: string;
  readonly uri?: string;
  readonly provider?: string;
  readonly durationMs?: number;
}

/* ------------------------------------------------------------------ */
/*  Log Session                                                        */
/* ------------------------------------------------------------------ */

export interface LogSession {
  readonly id: LogSessionId;
  readonly startTime: number;
  endTime?: number;
  durationMs?: number;
  entryCount: number;
  readonly filePath: string;
  readonly workspaceRoot?: string;
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly entryCountByType: Map<string, number>;
}

/* ------------------------------------------------------------------ */
/*  Log Writer (abstracts file I/O)                                    */
/* ------------------------------------------------------------------ */

export interface LogWriter {
  write(entry: LogEntry): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly bytesWritten: number;
  readonly path: string;
}

/* ------------------------------------------------------------------ */
/*  Log Statistics                                                     */
/* ------------------------------------------------------------------ */

export interface LogStatistics {
  totalSessions: number;
  activeSession: boolean;
  totalEntries: number;
  entriesBySource: Record<string, number>;
  entriesByLevel: Record<string, number>;
  totalBytesWritten: number;
  averageWriteLatencyMs: number;
  peakWriteLatencyMs: number;
  writesPerSecond: number;
  queuedWrites: number;
  droppedWrites: number;
  flushCount: number;
  averageFlushDurationMs: number;
  logFileCount: number;
  currentLogSizeBytes: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; /* 5 MB */
const DEFAULT_MAX_LOG_FILES = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_WRITE_SIZE = 50;

/* ------------------------------------------------------------------ */
/*  FileLogger                                                         */
/* ------------------------------------------------------------------ */

export class FileLogger {
  protected currentSession: LogSession | undefined;
  protected writer: LogWriter | undefined;
  protected readonly sessions: LogSession[] = [];
  protected readonly sessionOrder: LogSessionId[] = [];
  protected disposed = false;
  protected seq = 0;
  protected flushTimer: ReturnType<typeof setInterval> | undefined;
  protected writeQueue: LogEntry[] = [];
  protected flushing = false;

  /* Performance tracking */
  protected totalWriteLatencyMs = 0;
  protected writeCount = 0;
  protected peakWriteLatencyMs = 0;
  protected totalFlushDurationMs = 0;
  protected flushCount = 0;
  protected droppedWrites = 0;
  protected totalBytesWritten = 0;
  protected writeStartTime = Date.now();
  protected entriesBySource = new Map<string, number>();
  protected entriesByLevel = new Map<string, number>();
  protected readonly eventSub: TelemetrySubscription;
  protected readonly pipelineIndex = new Map<string, Set<string>>();

  constructor(
    protected readonly reporter: TelemetryReporter,
    protected readonly logDir: string,
    protected readonly maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
    protected readonly maxLogFiles: number = DEFAULT_MAX_LOG_FILES,
    protected readonly extensionVersion: string = 'unknown',
    protected readonly vscodeVersion: string = 'unknown',
    protected readonly workspaceRoot?: string,
  ) {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.eventSub = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      const pipelineId = (event as any).pipelineId as string | undefined;
      if (pipelineId) {
        const sessionSet = this.pipelineIndex.get(pipelineId);
        if (sessionSet) {
          if (this.currentSession) sessionSet.add(this.currentSession.id);
        } else {
          this.pipelineIndex.set(pipelineId, new Set(this.currentSession ? [this.currentSession.id] : []));
        }
      }
      this.write({
        level: this.eventLevel(event),
        source: event.source ?? 'unknown',
        type: event.type,
        data: event,
        traceId: event.traceId,
        uri: (event as any).uri ?? (event as any).fileUri,
        provider: (event as any).provider ?? (event as any).providerName,
        pipelineId,
        durationMs: (event as any).durationMs,
      }).catch(() => {});
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Session Management                                                 */
  /* ------------------------------------------------------------------ */

  async startSession(): Promise<LogSessionId> {
    const id = generateLogSessionId();
    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(this.logDir, `session-${id}`);
    const dateDir = path.join(sessionDir, dateStr);
    if (!fs.existsSync(dateDir)) {
      fs.mkdirSync(dateDir, { recursive: true });
    }
    const filePath = path.join(dateDir, 'events.jsonl');
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    this.writer = this.createWriter(stream, filePath);
    this.currentSession = {
      id,
      startTime: Date.now(),
      entryCount: 0,
      filePath,
      workspaceRoot: this.workspaceRoot,
      extensionVersion: this.extensionVersion,
      vscodeVersion: this.vscodeVersion,
      entryCountByType: new Map(),
    };

    this.sessions.push(this.currentSession);
    this.sessionOrder.push(id);

    /* Write session metadata */
    const metaPath = path.join(sessionDir, 'session.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      id, startTime: this.currentSession.startTime,
      workspaceRoot: this.workspaceRoot,
      extensionVersion: this.extensionVersion,
      vscodeVersion: this.vscodeVersion,
    }, null, 2), 'utf8');

    /* Write workspace info at top level */
    if (this.workspaceRoot) {
      const infoPath = path.join(this.logDir, 'workspace.json');
      fs.writeFileSync(infoPath, JSON.stringify({ root: this.workspaceRoot, updatedAt: Date.now() }, null, 2), 'utf8');
    }

    /* Start flush timer */
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        this.flushSync();
      }, DEFAULT_FLUSH_INTERVAL_MS);
    }

    return id;
  }

  async endSession(): Promise<void> {
    if (!this.currentSession || !this.writer) return;
    await this.flush();
    this.currentSession.endTime = Date.now();
    this.currentSession.durationMs = this.currentSession.endTime - this.currentSession.startTime;
    const sessionId = this.currentSession.id;
    await this.writer.close();
    this.writer = undefined;
    this.currentSession = undefined;

    /* Write pipeline index */
    const indexDir = path.join(this.logDir, `session-${sessionId}`);
    if (fs.existsSync(indexDir)) {
      const index: Record<string, string[]> = {};
      for (const [pid, sessions] of this.pipelineIndex) {
        index[pid] = [...sessions];
      }
      fs.writeFileSync(path.join(indexDir, 'pipelines.json'), JSON.stringify(index, null, 2), 'utf8');
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  getCurrentSession(): LogSession | undefined {
    return this.currentSession;
  }

  getSessions(): readonly LogSession[] {
    return [...this.sessions];
  }

  /* ------------------------------------------------------------------ */
  /*  Write API                                                          */
  /* ------------------------------------------------------------------ */

  async write(entry: Omit<LogEntry, 'seq' | 'sessionId' | 'timestamp'>): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.seq;

    const logEntry: LogEntry = {
      ...entry,
      seq,
      sessionId: this.currentSession?.id ?? ('' as LogSessionId),
      timestamp: Date.now(),
    };

    if (this.currentSession) {
      this.currentSession.entryCount++;
      this.currentSession.entryCountByType.set(entry.type, (this.currentSession.entryCountByType.get(entry.type) ?? 0) + 1);
    }

    this.entriesBySource.set(entry.source, (this.entriesBySource.get(entry.source) ?? 0) + 1);
    this.entriesByLevel.set(entry.level, (this.entriesByLevel.get(entry.level) ?? 0) + 1);

    if (this.writer) {
      this.writeQueue.push(logEntry);
      this.checkRotation();
      if (this.writeQueue.length >= MAX_BATCH_WRITE_SIZE) {
        await this.flush();
      }
    }
  }

  async close(): Promise<void> {
    await this.dispose();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.writeQueue.length === 0 || !this.writer) return;
    this.flushing = true;
    const flushStart = Date.now();
    const batch = this.writeQueue.splice(0, this.writeQueue.length);

    for (const entry of batch) {
      const writeStart = Date.now();
      try {
        await this.writer.write(entry);
        const latency = Date.now() - writeStart;
        this.totalWriteLatencyMs += latency;
        this.writeCount++;
        if (latency > this.peakWriteLatencyMs) this.peakWriteLatencyMs = latency;
        this.totalBytesWritten += Buffer.byteLength(JSON.stringify(entry) + '\n');
      } catch {
        this.droppedWrites++;
      }
    }

    try {
      await this.writer.flush();
    } catch {
      /* non-critical */
    }

    this.totalFlushDurationMs += Date.now() - flushStart;
    this.flushCount++;
    this.flushing = false;
  }

  protected flushSync(): void {
    if (!this.flushing && this.writeQueue.length > 0 && this.writer) {
      this.flush().catch(() => {});
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Log Rotation                                                       */
  /* ------------------------------------------------------------------ */

  async rotate(): Promise<void> {
    if (!this.writer) return;
    const oldPath = this.writer.path;
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    const base = path.basename(oldPath, ext);

    await this.flush();
    await this.writer.close();

    for (let i = this.maxLogFiles - 1; i >= 0; i--) {
      const src = i === 0 ? oldPath : path.join(dir, `${base}.${i}${ext}`);
      const dst = path.join(dir, `${base}.${i + 1}${ext}`);
      if (fs.existsSync(src)) {
        if (i >= this.maxLogFiles - 1) {
          fs.unlinkSync(src);
        } else {
          fs.renameSync(src, dst);
        }
      }
    }

    const stream = fs.createWriteStream(oldPath, { flags: 'a' });
    this.writer = this.createWriter(stream, oldPath);
  }

  cleanupOldSessions(maxSessions?: number): number {
    const keep = maxSessions ?? this.maxLogFiles;
    const sessionDirs: { name: string; mtime: Date }[] = [];

    try {
      for (const entry of fs.readdirSync(this.logDir)) {
        if (entry.startsWith('session-')) {
          const full = path.join(this.logDir, entry);
          try {
            sessionDirs.push({ name: entry, mtime: fs.statSync(full).mtime });
          } catch { /* skip */ }
        }
      }
    } catch { return 0; }

    sessionDirs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    let removed = 0;
    while (sessionDirs.length > keep) {
      const oldest = sessionDirs.pop()!;
      const full = path.join(this.logDir, oldest.name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch { /* skip */ }
    }
    return removed;
  }

  private createWriter(stream: fs.WriteStream, filePath: string): LogWriter {
    return {
      write: (entry: LogEntry): Promise<void> => {
        return new Promise((resolve, reject) => {
          const line = JSON.stringify(entry) + '\n';
          stream.write(line, (err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      flush: (): Promise<void> => {
        return new Promise((resolve) => stream.write('', () => resolve()));
      },
      close: (): Promise<void> => {
        return new Promise((resolve) => stream.end(() => resolve()));
      },
      get bytesWritten(): number { return stream.bytesWritten; },
      get path(): string { return filePath; },
    };
  }

  protected checkRotation(): void {
    if (this.writer && this.writer.bytesWritten > this.maxFileSize) {
      this.rotate().catch(() => {});
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Export                                                             */
  /* ------------------------------------------------------------------ */

  async exportAll(targetDir: string): Promise<{ exported: number; path: string }> {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    let exported = 0;

    /* Copy all log directories */
    for (const dirEntry of fs.readdirSync(this.logDir)) {
      const src = path.join(this.logDir, dirEntry);
      if (fs.statSync(src).isDirectory()) {
        const dst = path.join(targetDir, dirEntry);
        this.copyDirSync(src, dst);
        exported++;
      }
    }

    return { exported, path: targetDir };
  }

  async exportTimelines(timelineGenerator: TimelineGenerator, targetDir: string): Promise<string> {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, 'timelines.jsonl');
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    for (const tl of timelineGenerator.listTimelines()) {
      const report = timelineGenerator.reconstructTimeline(tl.id);
      stream.write(JSON.stringify({ timelineId: tl.id, status: tl.status, events: tl.events.length, report }) + '\n');
    }

    return new Promise((resolve) => {
      stream.end(() => resolve(filePath));
    });
  }

  async exportSnapshots(snapshotSystem: SnapshotSystem, targetDir: string): Promise<string> {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, 'snapshots.jsonl');
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    const stats = (snapshotSystem as any).getStatistics?.();
    stream.write(JSON.stringify({ type: 'snapshot.statistics', stats }) + '\n');
    return new Promise((resolve) => {
      stream.end(() => resolve(filePath));
    });
  }

  async exportAssertionFailures(targetDir: string): Promise<string> {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, 'assertions.jsonl');
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    return new Promise((resolve) => {
      stream.end(() => resolve(filePath));
    });
  }

  async exportPerformance(targetDir: string): Promise<string> {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, 'performance.json');
    const data = JSON.stringify({
      totalSessions: this.sessions.length,
      totalEntries: this.seq,
      entriesBySource: Object.fromEntries(this.entriesBySource),
      entriesByLevel: Object.fromEntries(this.entriesByLevel),
      totalBytesWritten: this.totalBytesWritten,
      averageWriteLatencyMs: this.writeCount > 0 ? Math.round(this.totalWriteLatencyMs / this.writeCount) : 0,
      peakWriteLatencyMs: this.peakWriteLatencyMs,
      droppedWrites: this.droppedWrites,
      flushCount: this.flushCount,
      averageFlushDurationMs: this.flushCount > 0 ? Math.round(this.totalFlushDurationMs / this.flushCount) : 0,
    }, null, 2);
    fs.writeFileSync(filePath, data, 'utf8');
    return filePath;
  }

  /* ------------------------------------------------------------------ */
  /*  Statistics                                                         */
  /* ------------------------------------------------------------------ */

  getStatistics(): LogStatistics {
    const elapsedSec = (Date.now() - this.writeStartTime) / 1000;

    let logFileCount = 0;
    if (fs.existsSync(this.logDir)) {
      try {
        for (const entry of fs.readdirSync(this.logDir)) {
          const full = path.join(this.logDir, entry);
          if (fs.statSync(full).isDirectory() || entry.endsWith('.jsonl') || entry.endsWith('.json')) {
            logFileCount++;
          }
        }
      } catch { /* ignore */ }
    }

    let currentLogSizeBytes = 0;
    if (this.writer) {
      try { currentLogSizeBytes = fs.statSync(this.writer.path).size; } catch { /* ignore */ }
    }

    return {
      totalSessions: this.sessions.length,
      activeSession: this.currentSession !== undefined,
      totalEntries: this.seq,
      entriesBySource: Object.fromEntries(this.entriesBySource),
      entriesByLevel: Object.fromEntries(this.entriesByLevel),
      totalBytesWritten: this.totalBytesWritten,
      averageWriteLatencyMs: this.writeCount > 0 ? Math.round(this.totalWriteLatencyMs / this.writeCount) : 0,
      peakWriteLatencyMs: this.peakWriteLatencyMs,
      writesPerSecond: elapsedSec > 0 ? Math.round(this.writeCount / elapsedSec) : 0,
      queuedWrites: this.writeQueue.length,
      droppedWrites: this.droppedWrites,
      flushCount: this.flushCount,
      averageFlushDurationMs: this.flushCount > 0 ? Math.round(this.totalFlushDurationMs / this.flushCount) : 0,
      logFileCount,
      currentLogSizeBytes,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private eventLevel(event: TelemetryEvent): LogLevel {
    const data = event as any;
    if (data.phase === 'error' || event.type === 'assertion.failure' || event.type === 'pipeline.execution.failed') return LogLevel.Error;
    if (data.phase === 'cancelled' || data.phase === 'warn') return LogLevel.Warn;
    if (event.type.startsWith('timeline.') || event.type.startsWith('snapshot.')) return LogLevel.Debug;
    return LogLevel.Info;
  }

  private copyDirSync(src: string, dst: string): void {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const srcPath = path.join(src, entry);
      const dstPath = path.join(dst, entry);
      if (fs.statSync(srcPath).isDirectory()) {
        this.copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.eventSub.dispose();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
    if (this.currentSession && this.writer) {
      this.currentSession.endTime = Date.now();
      this.currentSession.durationMs = this.currentSession.endTime - this.currentSession.startTime;
      await this.writer.close();
      this.writer = undefined;
      this.currentSession = undefined;
    }
    this.writeQueue.length = 0;
    this.sessions.length = 0;
    this.sessionOrder.length = 0;
  }
}

/** Create a FileLogger that writes to the given directory */
export function createFileLogger(
  reporter: TelemetryReporter,
  logDir: string,
  maxFileSize?: number,
  maxLogFiles?: number,
  extensionVersion?: string,
  vscodeVersion?: string,
  workspaceRoot?: string,
): FileLogger {
  return new FileLogger(reporter, logDir, maxFileSize, maxLogFiles, extensionVersion, vscodeVersion, workspaceRoot);
}
