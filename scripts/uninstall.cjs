#!/usr/bin/env node
'use strict';

/**
 * Neo MCP - Uninstall native messaging host
 *
 * Removes registry entries for both Chrome and Edge.
 * Run with: node scripts/uninstall.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST_NAME = 'com.neo.bridge';
const ROOT = path.resolve(__dirname, '..');
const MANIFEST_OUT = path.join(ROOT, HOST_NAME + '.json');

if (os.platform() !== 'win32') {
    console.log('[neo-mcp] Nothing to uninstall (not Windows).');
    process.exit(0);
}

const registryPaths = [
    `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];

for (const regPath of registryPaths) {
    try {
        execSync(`reg delete "${regPath}" /f`, { stdio: 'pipe' });
        const browser = regPath.includes('Google') ? 'Chrome' : 'Edge';
        console.log(`[neo-mcp] Removed native messaging host for ${browser}`);
    } catch {
        // Key didn't exist — that's fine
    }
}

try {
    if (fs.existsSync(MANIFEST_OUT)) {
        fs.unlinkSync(MANIFEST_OUT);
        console.log(`[neo-mcp] Removed manifest: ${MANIFEST_OUT}`);
    }
} catch {}

console.log('[neo-mcp] Uninstall complete. Restart your browser for changes to take effect.');
