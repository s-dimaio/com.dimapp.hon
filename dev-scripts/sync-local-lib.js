'use strict';

/**
 * sync-local-lib.js
 *
 * Copies the source files from the local JavahOn library workspace into
 * node_modules/java-hon without modifying package.json or package-lock.json.
 * This allows local development without using npm link (which can cause
 * module resolution issues).
 *
 * Usage (via npm scripts):
 *   npm run run:local    - sync + homey app run
 *   npm run run:github   - npm install + homey app run (uses the GitHub version)
 *
 * @module dev-scripts/sync-local-lib
 */

const fs = require('fs');
const path = require('path');

// Configuration

/**
 * Absolute path to the local JavahOn workspace.
 * CHANGE THIS to your absolute local JavahOn folder path for local development.
 * Example: 'D:\\Workspace\\VSCode\\JavahOn'
 */
const LOCAL_LIB_SRC = 'YOUR_LOCAL_PATH_TO_JAVAHON';

/** Absolute path to the java-hon folder inside node_modules */
const LOCAL_LIB_DEST = path.resolve(__dirname, '..', 'node_modules', 'java-hon');

/**
 * Files and directories to copy from the source workspace.
 * node_modules is intentionally excluded - we rely on the already-installed
 * dependencies in the Homey app's own node_modules.
 */
const ITEMS_TO_COPY = [
  'lib',
  'index.js',
  'package.json',
];

// Helpers

/**
 * Recursively copies a directory from src to dest.
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @returns {void}
 */
function _copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      _copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copies a single item (file or directory) from src to dest.
 * @param {string} name - The name of the item to copy (relative to LOCAL_LIB_SRC)
 * @returns {void}
 */
function _copyItem(name) {
  const srcPath = path.join(LOCAL_LIB_SRC, name);
  const destPath = path.join(LOCAL_LIB_DEST, name);

  if (!fs.existsSync(srcPath)) {
    console.warn('  Warning - Source not found, skipping: ' + srcPath);
    return;
  }

  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    _copyDir(srcPath, destPath);
  } else {
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(srcPath, destPath);
  }

  console.log('  OK  ' + name);
}

// Main

console.log('');
console.log('sync-local-lib - Syncing local JavahOn -> node_modules/java-hon');
console.log('   Source : ' + LOCAL_LIB_SRC);
console.log('   Dest   : ' + LOCAL_LIB_DEST);
console.log('');

if (LOCAL_LIB_SRC === 'YOUR_LOCAL_PATH_TO_JAVAHON' || !fs.existsSync(LOCAL_LIB_SRC)) {
  console.error('\x1b[31m%s\x1b[0m', '❌ ERROR: Local JavahOn source path not found or not configured.');
  console.error('\x1b[31m%s\x1b[0m', '   To fix this and use local development:');
  console.error('\x1b[31m%s\x1b[0m', '   1. Open dev-scripts/sync-local-lib.js');
  console.error('\x1b[31m%s\x1b[0m', '   2. Update the LOCAL_LIB_SRC constant to the absolute local path on your PC of JavahOn library.');
  console.error('\x1b[31m%s\x1b[0m', '   Otherwise, run "npm run run:github" to run using the GitHub version.');
  console.log('');
  process.exit(1);
}

if (!fs.existsSync(LOCAL_LIB_DEST)) {
  console.error('ERROR: node_modules/java-hon not found at: ' + LOCAL_LIB_DEST);
  console.error('Run "npm run run:github" first to install the original package, then retry.');
  process.exit(1);
}

for (const item of ITEMS_TO_COPY) {
  _copyItem(item);
}

console.log('');
console.log('Sync complete - starting Homey app...');
console.log('');

