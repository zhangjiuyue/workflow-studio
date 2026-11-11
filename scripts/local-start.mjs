import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try { process.loadEnvFile('.local/server.env'); } catch { throw new Error('Run npm run local:setup first.'); }
const children = [
  spawn(process.execPath, ['scripts/local-api.mjs'], { cwd: root, env: process.env, stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/static-preview.mjs'], { cwd: root, env: process.env, stdio: 'inherit' }),
];
let stopping = false;
function stop() { if (stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
children.forEach(child => { child.on('error', stop); child.on('exit', code => { if (code) process.exitCode = code; stop(); }); });
