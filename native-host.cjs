#!/usr/bin/env node
'use strict';

/**
 * Neo MCP - Chrome Native Messaging Host
 *
 * Chrome launches this process when the Neo Bridge extension starts.
 * It spawns the MCP HTTP server and keeps it alive for the browser session.
 *
 * Protocol: Chrome Native Messaging (4-byte LE length prefix + JSON)
 * Server:   MCP HTTP on localhost:3100
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname);
const SERVER = path.join(ROOT, 'dist', 'server.js');
const PORT = parseInt(process.env.NEO_HTTP_PORT || '3100', 10);

let serverProcess = null;
let serverReady = false;

// ── Chrome Native Messaging Protocol ─────────────────────────────────────────

function sendMessage(obj) {
    const json = JSON.stringify(obj);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length);
    try {
        process.stdout.write(header);
        process.stdout.write(json);
    } catch (e) {
        // stdout closed — Chrome disconnected
        cleanup();
    }
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('readable', () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
        inputBuffer = Buffer.concat([inputBuffer, chunk]);
        while (inputBuffer.length >= 4) {
            const len = inputBuffer.readUInt32LE(0);
            if (inputBuffer.length < 4 + len) break;
            try {
                const msg = JSON.parse(inputBuffer.slice(4, 4 + len).toString('utf8'));
                inputBuffer = inputBuffer.slice(4 + len);
                handleMessage(msg);
            } catch {
                inputBuffer = inputBuffer.slice(4 + len);
            }
        }
    }
});

function handleMessage(msg) {
    switch (msg.type) {
        case 'ping':
            sendMessage({ type: 'pong', serverRunning: serverReady, port: PORT });
            break;
        case 'restart':
            restartServer();
            break;
        default:
            sendMessage({ type: 'unknown_message', received: msg.type });
    }
}

// ── MCP Server Management ────────────────────────────────────────────────────

function startServer() {
    if (serverProcess) return;

    serverProcess = spawn(process.execPath, [SERVER, '--http-only'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NEO_TRANSPORT: 'http', NEO_HTTP_PORT: String(PORT) },
    });

    serverProcess.stderr.on('data', (data) => {
        const line = data.toString();
        // Detect server ready message from server.ts
        if (line.includes('listening') && !serverReady) {
            serverReady = true;
            sendMessage({ type: 'server_ready', port: PORT });
        }
    });

    serverProcess.stdout.on('data', () => {
        // Server stdout (MCP stdio transport output) — ignore in HTTP-only mode
    });

    serverProcess.on('exit', (code) => {
        serverReady = false;
        serverProcess = null;
        sendMessage({ type: 'server_exited', code });
    });

    serverProcess.on('error', (err) => {
        serverReady = false;
        serverProcess = null;
        sendMessage({ type: 'server_error', message: err.message });
    });
}

function restartServer() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
        serverReady = false;
    }
    setTimeout(startServer, 500);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function cleanup() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
    process.exit(0);
}

process.stdin.on('end', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('uncaughtException', (err) => {
    sendMessage({ type: 'host_error', message: err.message });
    cleanup();
});

// ── Start ────────────────────────────────────────────────────────────────────

sendMessage({ type: 'host_started' });
startServer();
