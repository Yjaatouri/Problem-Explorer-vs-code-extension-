import * as fs from 'fs';
import * as path from 'path';
import { TelemetryReporter } from '../../telemetry/TelemetryReporter';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_LOG_FILES = 3;

/** Writes all telemetry events to a rotating JSON-lines log file for offline forensic analysis */
export class TelemetryFileLogger {
  private stream: fs.WriteStream;
  private readonly logPath: string;
  private bytesWritten = 0;
  private disposed = false;
  private readonly sub: import('../../telemetry/TelemetryBus').TelemetrySubscription;

  constructor(
    reporter: TelemetryReporter,
    logDir: string,
    filename: string = 'telemetry.jsonl',
  ) {
    this.logPath = path.join(logDir, filename);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.rotateExisting();
    this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.bytesWritten = fs.statSync(this.logPath).size;

    this.sub = reporter.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;
      try {
        const line = JSON.stringify(event) + '\n';
        this.stream.write(line);
        this.bytesWritten += Buffer.byteLength(line);
        if (this.bytesWritten > MAX_LOG_SIZE) {
          this.rotate();
        }
      } catch {
        // silently drop write failures
      }
    });
  }

  private rotateExisting(): void {
    for (let i = MAX_LOG_FILES - 1; i >= 0; i--) {
      const oldPath = i === 0 ? this.logPath : this.logPath + `.${i}`;
      const newPath = this.logPath + `.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i >= MAX_LOG_FILES - 1) {
          fs.unlinkSync(oldPath);
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }
  }

  private rotate(): void {
    this.stream.end();
    this.rotateExisting();
    this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.bytesWritten = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sub.dispose();
    this.stream.end();
  }
}

/** Create a TelemetryFileLogger that writes to the given directory */
export function createTelemetryFileLogger(
  reporter: TelemetryReporter,
  logDir: string,
  filename?: string,
): TelemetryFileLogger {
  return new TelemetryFileLogger(reporter, logDir, filename);
}