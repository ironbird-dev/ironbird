// Runs only the CommonJS smoke test, against the built output, with no transform (M4 design D9).
module.exports = {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['<rootDir>/jest/**/*.test.cjs'],
  moduleFileExtensions: ['js', 'cjs', 'json'],
};
