import { DiagnosticProviderManager } from '../providers/DiagnosticProviderManager';

export interface OwnershipQuery {
  /** Returns true if no scan provider owns this extension, meaning it falls to the realtime provider */
  isRealtimeExtension(ext: string): boolean;
}

/** Adapter that queries DiagnosticProviderManager ownership to determine realtime eligibility */
export class DpmOwnershipQuery implements OwnershipQuery {
  constructor(private readonly dpm: DiagnosticProviderManager) {}

  isRealtimeExtension(ext: string): boolean {
    return !this.dpm.getOwner(ext);
  }
}
