import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the Vite server reuses the agent's TLS certificate (so phones that
 * trust the VoiceCode CA also trust the dev server) and proxies API and WebSocket
 * traffic to a locally running agent. The Host header is forwarded unchanged, so the
 * agent's Origin check accepts the dev server's origin without extra configuration.
 */
function agentHome(): string {
  if (process.env.VOICECODE_HOME) return path.resolve(process.env.VOICECODE_HOME);
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'voicecode-agent',
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'voicecode-agent',
  );
}

const tlsDir = path.join(agentHome(), 'tls');
const keyFile = path.join(tlsDir, 'server.key.pem');
const certFile = path.join(tlsDir, 'server.crt.pem');
const https = existsSync(keyFile)
  ? { key: readFileSync(keyFile), cert: readFileSync(certFile) }
  : undefined;
const agent = process.env.VOICECODE_AGENT_URL ?? 'https://127.0.0.1:8443';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    https,
    proxy: {
      '/api': { target: agent, secure: false },
      '/voicecode-ca.crt': { target: agent, secure: false },
      '/ws': { target: agent.replace(/^https/, 'wss'), ws: true, secure: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
