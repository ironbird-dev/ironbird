const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// exercise:begin-remove
// This app lives in the ironbird monorepo. pnpm links its dependencies into the workspace root's
// node_modules/.pnpm and links the ironbird packages to packages/*/dist, so Metro watches both
// folders and falls back to this app's node_modules for helpers that compiled package code
// imports, such as @babel/runtime. react and react-native always resolve to this app's copies:
// @ironbird/react-native's own development install links another react-native (0.86.3, for the
// checkout example), and two copies in one bundle break the app. zod always resolves to its CommonJS
// build: its "import" condition points at ESM source that uses `export * as`, which the React Native
// Babel preset doesn't transform inside node_modules.
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const singletons = ['react', 'react-native'];
const isSingleton = (name) => singletons.some((singleton) => name === singleton || name.startsWith(`${singleton}/`));
const isZod = (name) => name === 'zod' || name.startsWith('zod/');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [path.join(workspaceRoot, 'node_modules'), path.join(workspaceRoot, 'packages')],
  resolver: {
    nodeModulesPaths: [path.join(projectRoot, 'node_modules'), path.join(workspaceRoot, 'node_modules')],
    // The generated exercise copy is a second app inside this one; Metro must not crawl it.
    blockList: [/[/\\]integration-exercise[/\\]/],
    resolveRequest: (context, moduleName, platform) => {
      if (isZod(moduleName)) return context.resolveRequest({ ...context, isESMImport: false }, moduleName, platform);
      return context.resolveRequest(isSingleton(moduleName) ? { ...context, originModulePath: path.join(projectRoot, 'index.js') } : context, moduleName, platform);
    },
  },
};
// exercise:else
// /**
//  * Metro configuration
//  * https://reactnative.dev/docs/metro
//  *
//  * @type {import('@react-native/metro-config').MetroConfig}
//  */
// const config = {};
// exercise:end

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
