#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { normalizeConfig, readConfig, runLoadTest, importPostman } from '../../core/src/index.js';
import { startServer } from './server.js';

const help = `LoadTesting · local HTTP load testing
Usage:
  loadtesting run --url http://localhost:4000/health --users 20 --duration 10
  loadtesting run --config loadtest.json
  loadtesting run                         Interactive setup
  loadtesting web [--port 4310]           Local web workspace
  loadtesting init [--file loadtest.json] Write a starter config
  loadtesting import collection.json [--env environment.json] [--file loadtest.json]

Run options:
  --url, -u URL           Repeat to test multiple endpoints concurrently
  --method, -m METHOD     Default GET; applies to each --url
  --header, -H 'Key: val' Repeat for custom headers/cookies
  --query 'key=value'     Repeat for query parameters
  --bearer TOKEN         Bearer auth (prefer {{TOKEN}} with an environment variable)
  --basic 'user:pass'     Basic auth
  --data, -d BODY        Raw or JSON request body
  --data-file FILE       Read a body from file; use --body-type binary for uploads
  --body-type TYPE       raw, json, urlencoded, multipart, binary, none
  --users, -c N          Concurrent virtual users (default 10, shared across endpoints)
  --duration SECONDS     Run duration (default 10); cannot combine with --requests
  --requests, -n N       Exact total attempts, distributed round-robin
  --timeout MS           Per-request timeout (default 10000)
  --think-time MS        Delay per virtual user between requests
  --ramp-up SECONDS      Gradually start users
  --max-rps N            Global start-rate cap (0 means unlimited)
  --expect '200,201'     Expected success statuses (default any 2xx)
  --redirect MODE       follow, manual, error
  --var 'key=value'      Repeat to resolve {{variables}} in config/arguments
  --p95 MS               Fail if p95 latency exceeds this threshold
  --error-rate PERCENT   Fail if error rate exceeds this threshold
  --out DIRECTORY        Logs folder under current directory by default
  --json                 Print only the final JSON summary
  --help, -h             Show help
Exit codes: 0 complete / thresholds passed, 1 invalid input or runtime error,
            2 thresholds failed, 130 cancelled.
Each run writes requests.ndjson and summary.json in a unique run directory.
`;
const options = {
  url: { type: 'string', multiple: true, short: 'u' }, config: { type: 'string' },
  method: { type: 'string', short: 'm' }, header: { type: 'string', multiple: true, short: 'H' },
  query: { type: 'string', multiple: true }, bearer: { type: 'string' }, basic: { type: 'string' },
  data: { type: 'string', short: 'd' }, 'data-file': { type: 'string' }, 'body-type': { type: 'string' },
  users: { type: 'string', short: 'c' }, duration: { type: 'string' }, requests: { type: 'string', short: 'n' },
  timeout: { type: 'string' }, 'think-time': { type: 'string' }, 'ramp-up': { type: 'string' }, 'max-rps': { type: 'string' },
  expect: { type: 'string' }, redirect: { type: 'string' }, var: { type: 'string', multiple: true },
  p95: { type: 'string' }, 'error-rate': { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' },
  port: { type: 'string' }, file: { type: 'string' }, env: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};
function keyValues(values, separator) {
  return Object.fromEntries((values ?? []).map(value => {
    const at = value.indexOf(separator);
    if (at < 1) throw new Error(`Expected key${separator}value, received: ${value}`);
    return [value.slice(0, at).trim(), value.slice(at + 1).trim()];
  }));
}
export async function configFromArgs(v) {
  let config = v.config ? await readConfig(v.config) : {};
  config.variables = { ...config.variables, ...keyValues(v.var, '=') };
  for (const [flag, field] of Object.entries({ users:'users', duration:'duration', requests:'requests', timeout:'timeout', 'think-time':'thinkTime', 'ramp-up':'rampUp', 'max-rps':'maxRps' })) {
    if (v[flag] !== undefined) config[field] = Number(v[flag]);
  }
  if (v.requests !== undefined && v.duration === undefined) delete config.duration;
  if (v.duration !== undefined && v.requests === undefined) delete config.requests;
  config.thresholds = { ...config.thresholds };
  if (v.p95 !== undefined) config.thresholds.p95 = Number(v.p95);
  if (v['error-rate'] !== undefined) config.thresholds.errorRate = Number(v['error-rate']);
  if (v.url?.length) config.endpoints = v.url.map((url,i) => ({ id: `endpoint-${i+1}`, name: `Endpoint ${i+1}`, url }));
  if (!config.endpoints?.length) {
    if (!process.stdin.isTTY || v.json) throw new Error('Supply --url or --config (interactive setup requires a terminal)');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const urls = await rl.question('Endpoint URLs (comma separated): ');
      config.endpoints = urls.split(',').map(url => ({ url: url.trim() }));
      config.users ??= Number(await rl.question('Concurrent users [10]: ') || 10);
      if (!config.requests && !config.duration) config.duration = Number(await rl.question('Duration in seconds [10]: ') || 10);
      const method = await rl.question('Method [GET]: ') || 'GET';
      const headers = JSON.parse(await rl.question('Headers as JSON [{}]: ') || '{}');
      const data = await rl.question('Request body (leave empty for none): ');
      config.endpoints = config.endpoints.map(e => ({ ...e, method, headers, ...(data ? { body: data, bodyType: 'raw' } : {}) }));
    } finally { rl.close(); }
  }
  let body = v.data;
  if (v.data !== undefined && v['data-file']) throw new Error('Choose --data or --data-file');
  if (v['data-file']) {
    const bytes = await readFile(v['data-file']);
    body = v['body-type'] === 'binary' ? bytes.toString('base64') : bytes.toString('utf8');
  }
  if (body !== undefined && ['urlencoded', 'multipart'].includes(v['body-type'])) body = JSON.parse(body);
  if (v.bearer !== undefined && v.basic !== undefined) throw new Error('Choose --bearer or --basic');
  config.endpoints = config.endpoints.map(e => {
    const endpoint = { ...e, headers: { ...e.headers, ...keyValues(v.header, ':') }, query: { ...e.query, ...keyValues(v.query, '=') } };
    if (v.method) endpoint.method = v.method;
    if (body !== undefined) endpoint.body = body;
    if (v['body-type']) endpoint.bodyType = v['body-type'];
    if (v.expect) endpoint.expectedStatus = v.expect.split(',').map(Number);
    if (v.redirect) endpoint.redirect = v.redirect;
    if (v.bearer !== undefined) endpoint.auth = { type: 'bearer', token: v.bearer };
    if (v.basic !== undefined) {
      const at = v.basic.indexOf(':');
      if (at < 0) throw new Error('--basic must be username:password');
      endpoint.auth = { type: 'basic', username: v.basic.slice(0,at), password: v.basic.slice(at+1) };
    }
    return endpoint;
  });
  normalizeConfig(config);
  return config;
}
function printSummary(s) {
  console.log(`\n${s.cancelled ? 'Cancelled' : 'Completed'} · ${s.name}\n`);
  console.table(s.endpoints.map(e => ({ Endpoint: e.name, Requests: e.total, Success: e.successful, Failed: e.failed, 'RPS': e.requestsPerSecond, 'P50 ms': e.latency.p50, 'P95 ms': e.latency.p95, 'P99 ms': e.latency.p99 })));
  console.log(`Total ${s.total} · Success ${s.successful} · Failed ${s.failed} · Error ${s.errorRate}%\n${s.requestsPerSecond} req/s · P95 ${s.latency.p95} ms · Peak concurrency ${s.peakConcurrency}\nDetails: ${s.files.details}\nSummary: ${s.files.summary}`);
  for (const t of s.thresholds) console.log(`${t.passed ? 'PASS' : 'FAIL'} ${t.metric}: ${t.actual} <= ${t.limit}`);
}
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({ args, options, allowPositionals: true });
  const command = positionals[0] ?? 'run';
  if (v.help) { console.log(help); return; }
  if (command === 'web') {
    const port = v.port === undefined ? 4310 : Number(v.port);
    const app = await startServer({ port, outputDir: v.out });
    console.log(`\nLoadTesting workspace → ${app.url}\nLogs → ${app.outputDir}\nPress Ctrl+C to stop.`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (command === 'init') {
    const file = v.file ?? 'loadtest.json';
    await writeFile(file, JSON.stringify({ name: 'My API load test', users: 10, duration: 10, timeout: 10000, variables: { baseUrl: 'http://localhost:4000' }, endpoints: [{ name: 'Health', url: '{{baseUrl}}/health', method: 'GET', headers: {} }], thresholds: { errorRate: 1, p95: 500 } }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Created ${file}. Run: loadtesting run --config ${file}`);
    return;
  }
  if (command === 'import') {
    if (!positionals[1]) throw new Error('Provide a Postman collection JSON path');
    const env = v.env ? JSON.parse(await readFile(v.env, 'utf8')) : {};
    const environment = Array.isArray(env.values) ? Object.fromEntries(env.values.filter(v => v.enabled !== false).map(v => [v.key,v.value])) : env;
    const config = importPostman(JSON.parse(await readFile(positionals[1], 'utf8')), environment);
    const file = v.file ?? 'loadtest.json';
    await writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Imported ${config.endpoints.length} endpoints into ${file}. Review before running.`);
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command "${command}". Use --help`);
  if (positionals.length > 1) throw new Error('Unexpected positional arguments; use --url for endpoints');
  const config = await configFromArgs(v);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const progress = !v.json && process.stdout.isTTY ? s => process.stdout.write(`\r${s.total} requests · ${s.successful} success · ${s.failed} failed · ${s.active} active · P95 ${s.latency.p95} ms    `) : undefined;
  try {
    const summary = await runLoadTest(config, { outputDir: v.out, signal: controller.signal, onProgress: progress });
    if (v.json) console.log(JSON.stringify(summary)); else printSummary(summary);
    process.exitCode = summary.cancelled ? 130 : summary.passed ? 0 : 2;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`LoadTesting: ${e.message}`); process.exitCode = 1; });
}
