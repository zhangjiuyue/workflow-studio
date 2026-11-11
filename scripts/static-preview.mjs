import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('out');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.woff2':'font/woff2', '.ico':'image/x-icon' };
await stat(resolve(root, 'index.html')).catch(() => { throw new Error('Run npm run build before npm run local:start.'); });
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolve(root, '.' + pathname);
    if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    for (const file of [target, target + '.html', resolve(target, 'index.html')]) {
      try {
        if (!(await stat(file)).isFile()) continue;
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : data); return;
      } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
    }
    res.writeHead(404); res.end('Not found');
  } catch { res.writeHead(400); res.end('Invalid request'); }
});
server.listen(13000, '127.0.0.1', () => console.log('Local frontend: http://127.0.0.1:13000'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
