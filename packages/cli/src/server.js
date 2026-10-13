import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoadTest, normalizeConfig, importPostman } from '../../core/src/index.js';

const webRoot = fileURLToPath(new URL('../../../apps/web/src/', import.meta.url));
export async function startServer({ port = 4310, outputDir = 'loadtesting-logs' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const session = randomBytes(32).toString('hex');
  const runs = new Map();
  let current, actualPort, closing = false;
  const origin = () => `http://127.0.0.1:${actualPort}`;
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2097152) throw new Error('Maximum request/config size is 2 MiB');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Expected valid JSON'); }
  }
  const server = http.createServer(async (req,res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) return json(res, 503, { error: 'Server is shutting down' });
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return json(res, 403, { error: 'Open the workspace using its printed 127.0.0.1 address' });
      const url = new URL(req.url, origin());
      if (url.pathname.startsWith('/api/')) {
        const authenticated = (req.headers.cookie ?? '').split(';').some(c => c.trim() === `loadtesting_session=${session}`);
        if (!authenticated || req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin())) return json(res, 403, { error: 'Open the local workspace to create a session' });
        if (req.method !== 'GET' && req.headers.origin !== origin()) return json(res, 403, { error: 'Same-origin requests required' });
        if (url.pathname === '/api/runs' && req.method === 'GET') return json(res, 200, [...runs.values()].map(r => ({ id: r.id, status: r.status, stats: r.stats, error: r.error })));
        if (url.pathname === '/api/import' && req.method === 'POST') {
          const data = await body(req);
          return json(res, 200, importPostman(data.collection, data.environment ?? {}));
        }
        if (url.pathname === '/api/runs' && req.method === 'POST') {
          if (current?.status === 'running') return json(res, 409, { error: 'Stop the active run before starting another' });
          const config = await body(req);
          normalizeConfig(config);
          const run = { id: randomUUID(), status: 'running', stats: null, recent: [], controller: new AbortController() };
          current = run; runs.set(run.id, run);
          while (runs.size > 20) runs.delete(runs.keys().next().value);
          run.promise = runLoadTest(config, {
            outputDir, signal: run.controller.signal,
            onProgress: s => { run.stats = s; },
            onRequest: r => { run.recent.push(r); if (run.recent.length > 200) run.recent.shift(); },
          }).then(summary => { run.stats = summary; run.status = summary.cancelled ? 'cancelled' : 'completed'; })
            .catch(e => { run.status = 'failed'; run.error = e.message; });
          return json(res, 202, { id: run.id });
        }
        const match = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(stop|details|summary))?$/);
        if (match) {
          const run = runs.get(match[1]);
          if (!run) return json(res, 404, { error: 'Run not found' });
          if (match[2] === 'stop' && req.method === 'POST') { run.controller.abort(); return json(res, 202, { stopped: true }); }
          if (!match[2] && req.method === 'GET') return json(res, 200, { id: run.id, status: run.status, stats: run.stats, error: run.error, recent: run.recent });
          if (['details', 'summary'].includes(match[2]) && req.method === 'GET') {
            if (!run.stats?.files) return json(res, 409, { error: 'Logs are available after the run finishes' });
            const file = run.stats.files[match[2]];
            const info = await stat(file);
            res.writeHead(200, { 'content-type': match[2] === 'details' ? 'application/x-ndjson' : 'application/json', 'content-length': info.size, 'content-disposition': `attachment; filename="${path.basename(file)}"` });
            const stream = createReadStream(file);
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            stream.pipe(res); return;
          }
        }
        return json(res, 404, { error: 'API route not found' });
      }
      if (url.pathname.startsWith('/demo/')) {
        if (url.pathname === '/demo/slow') await new Promise(resolve => setTimeout(resolve, 100));
        const code = url.pathname === '/demo/fail' ? 503 : 200;
        return json(res, code, { ok: code === 200, method: req.method, message: 'Local demo endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      const asset = assets[url.pathname];
      if (!asset) return json(res, 404, { error: 'Not found' });
      res.setHeader('set-cookie', `loadtesting_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', asset[1] + '; charset=utf-8');
      const data = await readFile(path.join(webRoot, asset[0]));
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); else res.destroy(); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve,reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  return { url: origin(), outputDir: path.resolve(outputDir), server,
    async close() {
      closing = true;
      if (current?.status === 'running') { current.controller.abort(); await current.promise; }
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
}
