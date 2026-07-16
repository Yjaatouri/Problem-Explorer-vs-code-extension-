export const EXTENSION_ID = 'problem-explorer';
export const EXTENSION_NAME = 'Problem Explorer';

export const SETTINGS_SECTION = 'problemExplorer';

export const COMMANDS = {
  REFRESH: 'problemExplorer.refresh',
  TOGGLE: 'problemExplorer.toggle',
  SCAN_TS: 'problemExplorer.scanTypeScript',
  CANCEL_SCAN: 'problemExplorer.cancelScan',
  SCAN_ALL: 'problemExplorer.scanAll',
} as const;

export const COLORS = {
  ERROR_FOREGROUND: 'problemExplorer.errorForeground',
  WARNING_FOREGROUND: 'problemExplorer.warningForeground',
  INFO_FOREGROUND: 'problemExplorer.infoForeground',
} as const;

export const PROCESSING_DEBOUNCE_MS = 50;
export const AUTO_SCAN_DEBOUNCE_MS = 2000;
export const AUTO_SCAN_EXTENSIONS_TSC = ['.ts', '.tsx'];
export const AUTO_SCAN_EXTENSIONS_ESLINT = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'];

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',
  '**/__pycache__/**',
  '**/vendor/**',
  '**/.tox/**',
];

export const BADGE_LETTERS: Record<string, string> = {
  error: 'E',
  warning: 'W',
  info: 'I',
} as const;

export const BADGE_DOT = '\u25CF';

export const TREND_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_TREND_SNAPSHOTS = 100;
export const TREND_STORAGE_KEY = 'problemExplorer.trendHistory';
