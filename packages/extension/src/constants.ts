export const EXTENSION_ID = 'problem-explorer';
export const EXTENSION_NAME = 'Problem Explorer';

export const SETTINGS_SECTION = 'problemExplorer';

export const COMMANDS = {
  REFRESH: 'problemExplorer.refresh',
  TOGGLE: 'problemExplorer.toggle',
  SCAN_WORKSPACE: 'problemExplorer.scanWorkspace',
  SHOW_STATUS: 'problemExplorer.showStatus',
} as const;

export const COLORS = {
  ERROR_FOREGROUND: 'problemExplorer.errorForeground',
  WARNING_FOREGROUND: 'problemExplorer.warningForeground',
  INFO_FOREGROUND: 'problemExplorer.infoForeground',
} as const;

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

export const BADGE_DOT = '\u25CF';