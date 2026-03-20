#!/usr/bin/env node
'use strict';

/**
 * Neo MCP - Post-install setup
 *
 * Runs automatically after `npm install`. Registers the Chrome/Edge native
 * messaging host so the MCP server auto-launches when the browser opens.
 *
 * - Windows: Registers for both Chrome and Edge (separate registry keys)
 * - macOS/Linux: Skips (Claude Desktop manages the server via stdio)
 *
 * The extension ID is deterministic because manifest.json includes a fixed
 * "key" field. Every user who loads the unpacked extension gets the same ID.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ────────────────────────────────────────────────────────────────

// This ID is derived from the "key" in extension/manifest.json.
// It's the same on every machine because the key is fixed.
const EXTENSION_ID = 'oaicihkplkjiachimlgebekmjohcaaek';
const HOST_NAME = 'com.neo.bridge';
const ROOT = path.resolve(__dirname, '..');
const NATIVE_HOST_BAT = path.join(ROOT, 'native-host.bat');
const MANIFEST_OUT = path.join(ROOT, HOST_NAME + '.json');

// ── Platform detection ───────────────────────────────────────────────────────

const platform = os.platform();

if (platform !== 'win32') {
    console.log('[neo-mcp] Skipping native messaging setup (not Windows).');
    console.log('[neo-mcp] On macOS/Linux, Claude Desktop manages the server via stdio.');
    process.exit(0);
}

// ── Write native messaging manifest ──────────────────────────────────────────

const manifest = {
    name: HOST_NAME,
    description: 'Neo MCP Server - Auto-launches when the browser starts',
    path: NATIVE_HOST_BAT,
    type: 'stdio',
    allowed_origins: [
        `chrome-extension://${EXTENSION_ID}/`,
    ],
};

fs.writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 4) + '\n', 'utf8');
console.log(`[neo-mcp] Native messaging manifest written: ${MANIFEST_OUT}`);

// ── Register in Windows Registry ─────────────────────────────────────────────
// Register for BOTH Chrome and Edge so it works regardless of which browser
// the user loads the extension in. Edge is Chromium-based and uses the same
// native messaging protocol.

const registryPaths = [
    // Google Chrome
    `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    // Microsoft Edge
    `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];

let anySuccess = false;

for (const regPath of registryPaths) {
    try {
        execSync(
            `reg add "${regPath}" /ve /t REG_SZ /d "${MANIFEST_OUT}" /f`,
            { stdio: 'pipe' }
        );
        const browser = regPath.includes('Google') ? 'Chrome' : 'Edge';
        console.log(`[neo-mcp] Registered native messaging host for ${browser}`);
        anySuccess = true;
    } catch (err) {
        const browser = regPath.includes('Google') ? 'Chrome' : 'Edge';
        console.warn(`[neo-mcp] Warning: Could not register for ${browser}: ${err.message}`);
    }
}

if (anySuccess) {
    console.log('\n[neo-mcp] Setup complete! The MCP server will auto-start when your browser opens.');
    console.log('[neo-mcp] Just load the extension from the extension/ folder and you\'re good to go.');
} else {
    console.error('\n[neo-mcp] ERROR: Could not register native messaging host.');
    console.error('[neo-mcp] You may need to run this as administrator, or register manually.');
    process.exit(1);
}
