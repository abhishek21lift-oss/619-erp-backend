module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  // A local worktree holds a whole second copy of src/, tests included. Jest
  // would run every test twice and OOM the heap doing it.
  testPathIgnorePatterns: ['/node_modules/', '/.worktrees/'],
  // testPathIgnorePatterns only filters test files; the haste map still scans
  // a worktree's package.json and reports a duplicate module name.
  modulePathIgnorePatterns: ['<rootDir>/.worktrees/'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  verbose: true,
  forceExit: true,
  // detectOpenHandles is a debugging aid, not a test setting: it tracks every
  // async resource for the whole run and was pushing the main process past the
  // 2 GB heap. --forceExit is the production behaviour; turn this on locally
  // when a specific suite hangs.
  // Workers hold a whole test file's module graph; recycle one that has grown
  // past this instead of letting the run creep toward the heap limit.
  workerIdleMemoryLimit: '512MB',
};
