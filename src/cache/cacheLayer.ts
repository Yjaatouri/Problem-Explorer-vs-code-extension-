import { Uri } from 'vscode';
import { ProblemStatus } from '../core/types';
import { PER_FOLDER_CACHE_LIMIT } from '../core/constants';
import { LruCache } from './lruCache';

export type IgnorePredicate = (uri: Uri) => boolean;

export class ProblemCache {
  private readonly folders: Map<string, LruCache<string, ProblemStatus>>;
  private ignorePredicate: IgnorePredicate | undefined;

  constructor() {
    this.folders = new Map();
  }

  setIgnorePredicate(predicate: IgnorePredicate | undefined): void {
    this.ignorePredicate = predicate;
  }

  get(uri: Uri, folderUri: Uri): ProblemStatus | undefined {
    const cache = this.folders.get(folderUri.toString());
    if (!cache) {
      return undefined;
    }
    return cache.get(uri.toString());
  }

  set(uri: Uri, status: ProblemStatus, folderUri: Uri): boolean {
    if (this.ignorePredicate?.(uri)) {
      return false;
    }

    const uriKey = uri.toString();
    const folderKey = folderUri.toString();
    let cache = this.folders.get(folderKey);

    if (!cache) {
      cache = new LruCache<string, ProblemStatus>(PER_FOLDER_CACHE_LIMIT);
      this.folders.set(folderKey, cache);
      cache.set(uriKey, status);
      return true;
    }

    const old = cache.get(uriKey);
    if (old !== undefined && !hasChanged(old, status)) {
      return false;
    }

    cache.set(uriKey, status);
    return true;
  }

  delete(uri: Uri, folderUri: Uri): void {
    this.folders.get(folderUri.toString())?.delete(uri.toString());
  }

  clear(): void {
    this.folders.clear();
  }

  clearFolder(folderUri: Uri): void {
    this.folders.delete(folderUri.toString());
  }

  getFolderSize(folderUri: Uri): number {
    return this.folders.get(folderUri.toString())?.size ?? 0;
  }
}

function hasChanged(a: ProblemStatus, b: ProblemStatus): boolean {
  return (
    a.severity !== b.severity ||
    a.errorCount !== b.errorCount ||
    a.warningCount !== b.warningCount ||
    a.infoCount !== b.infoCount
  );
}
