// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
// mobile/apps/app -> mobile/ (the yarn workspace root that contains
// both apps/* and packages/*, per mobile/package.json's "workspaces").
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Without this, Metro only watches `projectRoot` (mobile/apps/app) by
// default, so it never crawls mobile/packages/api-client -- the
// package resolves via the node_modules symlink yarn workspaces
// creates, but Metro can't see the files *inside* it (including
// index.ts's own relative imports like "./client"), which is exactly
// what produces "Unable to resolve module ./client from .../index.ts"
// even though the file is right there on disk.
config.watchFolders = [workspaceRoot];

// Let Metro fall back to the workspace root's node_modules (where
// yarn workspaces hoists shared deps) after checking the app's own.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
