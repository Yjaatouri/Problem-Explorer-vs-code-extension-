// @pe/provider-base — reusable kit for building concrete providers (§7).
// Exposes the BaseProvider base class, the issue contract, and the
// executable runner. Concrete providers (tsc, eslint, ruff, realtime)
// are thin subclasses in sibling packages.

export { BaseProvider } from './base-provider.js';
export type { BaseProviderOptions, ParsedIssue, ScanCommandBuilder } from './base-provider.js';
export type { ScanResult, ScanContext, ScanErrorInfo, ProviderConfig, Uri } from '@pe/provider-sdk';
export { runExecutable, disposeAllChildren, activeChildCount } from './runner.js';
export type { RunResult, RunOptions } from './runner.js';
