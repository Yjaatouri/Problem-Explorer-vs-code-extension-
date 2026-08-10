// Flat ESLint config for the fixture workspace. TypeScript files are
// deliberately ignored — this fixture has no @typescript-eslint parser.
// eslint.config.mjs itself is lintable and clean (no console calls).
export default [{ ignores: ['**/*.ts'] }, { rules: { 'no-console': 'warn' } }];
