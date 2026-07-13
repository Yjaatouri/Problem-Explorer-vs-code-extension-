/** Identifies which language server or linter produced a diagnostic. */
export enum ProblemSource {
  TypeScript = 'typescript',
  ESLint = 'eslint',
  Other = 'other',
}
