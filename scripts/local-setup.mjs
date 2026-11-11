import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
await mkdir('.local', { recursive: true, mode: 0o700 });
const lines = ['NODE_ENV=production', 'HOST=127.0.0.1', 'PORT=18787', 'APP_ORIGIN=http://127.0.0.1:13000',
  'APP_ORIGINS=http://127.0.0.1:13000', 'API_PUBLIC_BASE_URL=http://127.0.0.1:18787', 'STORE_DRIVER=json',
  `DATA_DIR=${JSON.stringify(resolve('.local/data'))}`, 'STORAGE_PROVIDER=local',
  `SESSION_SECRET=${randomBytes(32).toString('hex')}`, `API_KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
  'BOOTSTRAP_ADMIN_EMAIL=admin@example.invalid', `BOOTSTRAP_ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`];
try {
  await writeFile('.local/server.env', lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created .local/server.env with unique local credentials. Read this local file to obtain the admin password. Do not commit or share it.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .local/server.env retained without changes.');
}
