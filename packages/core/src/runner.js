import { setMaxListeners } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeConfig } from './config.js';
import { Metrics, redactHeaders, redactUrl } from './stats.js';

export async function runLoadTest(input, { outputDir = 'loadtesting-logs', signal, onProgress, onRequest, captureResponse = false } = {}) {
  const config = normalizeConfig(input);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`;
  const directory = path.resolve(outputDir, runId);
  await mkdir(directory, { recursive: true });
  const detailsPath = path.join(directory, 'requests.ndjson');
  const summaryPath = path.join(directory, 'summary.json');
  const details = await open(detailsPath, 'wx', 0o600);
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  const budgetController = new AbortController();
  const waitSignal = AbortSignal.any([controller.signal, budgetController.signal]);
  setMaxListeners(0, waitSignal);
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = config.duration ? started + config.duration * 1000 : Infinity;
  const overall = new Metrics();
  const metrics = config.endpoints.map(() => new Metrics());
  let nextRequest = 0, active = 0, peakConcurrency = 0, nextSlot = started;
  let writeQueue = Promise.resolve(), fatalError;
  function snapshot() {
    const elapsedSeconds = (performance.now() - started) / 1000;
    return { runId, name: config.name, startedAt, elapsedSeconds, active, peakConcurrency,
      ...overall.snapshot(elapsedSeconds),
      endpoints: config.endpoints.map((e,i) => ({ id: e.id, name: e.name, method: e.method, url: redactUrl(e.url), ...metrics[i].snapshot(elapsedSeconds) })) };
  }
  const interval = onProgress ? setInterval(() => onProgress(snapshot()), 250) : null;
  interval?.unref();
  async function pause(ms) {
    if (ms <= 0) return;
    try { await delay(ms, undefined, { signal: waitSignal }); } catch (e) { if (!waitSignal.aborted) throw e; }
  }
  async function request(endpoint, index, worker, number) {
    const begun = performance.now();
    const headers = new Headers(endpoint.headers);
    let body = endpoint.body;
    if (endpoint.bodyType === 'multipart') {
      const form = new FormData();
      for (const [key,value] of Object.entries(body ?? {})) form.append(key, value);
      body = form;
    } else if (endpoint.bodyType === 'binary' && body !== undefined) body = Buffer.from(body, 'base64');
    const result = { sequence: number + 1, user: worker + 1, endpointId: endpoint.id,
      timestamp: new Date().toISOString(), method: endpoint.method, url: redactUrl(endpoint.url),
      requestHeaders: redactHeaders(endpoint.headers), status: null, success: false, bytes: 0, latencyMs: 0 };
    active++; peakConcurrency = Math.max(peakConcurrency, active);
    const timeout = AbortSignal.timeout(endpoint.timeout);
    let responseBody, responseTruncated;
    try {
      const response = await fetch(endpoint.url, { method: endpoint.method, headers, body,
        redirect: endpoint.redirect, signal: AbortSignal.any([controller.signal, timeout]) });
      result.status = response.status;
      result.responseHeaders = redactHeaders(Object.fromEntries(response.headers));
      // Always consume the full response for end-to-end latency and connection reuse.
      // Keep a bounded prefix only when assertions need it.
      const needsText = captureResponse || endpoint.assertions.contains !== undefined || endpoint.assertions.json !== undefined;
      let chunks = [], sampleBytes = 0;
      if (response.body) for await (const chunk of response.body) {
        result.bytes += chunk.length;
        if (needsText && sampleBytes < 1048576) {
          const piece = chunk.subarray(0, 1048576 - sampleBytes);
          chunks.push(piece); sampleBytes += piece.length;
        }
      }
      result.success = endpoint.expectedStatus.length ? endpoint.expectedStatus.includes(response.status) : response.status >= 200 && response.status < 300;
      if (!result.success) { result.errorType = 'http'; result.error = `Unexpected HTTP status ${response.status}`; }
      if (needsText) {
        const text = Buffer.concat(chunks).toString('utf8');
        if (captureResponse) { responseBody = Buffer.concat(chunks).subarray(0,16384).toString('utf8'); responseTruncated = result.bytes > 16384; }
        if (endpoint.assertions.contains !== undefined && !text.includes(endpoint.assertions.contains)) {
          result.success = false; result.errorType = 'assertion'; result.error = 'Response does not contain expected text';
        }
        if (endpoint.assertions.json !== undefined) {
          try {
            if (result.bytes > 1048576) throw new Error('JSON assertions support responses up to 1 MiB');
            const parsed = JSON.parse(text);
            for (const [key, expected] of Object.entries(endpoint.assertions.json)) {
              const actual = key.split('.').reduce((v,k) => v?.[k], parsed);
              if (!isDeepStrictEqual(actual, expected)) throw new Error(`JSON assertion failed at ${key}`);
            }
          } catch (e) { result.success = false; result.errorType = 'assertion'; result.error = e.message; }
        }
      }
    } catch {
      result.success = false;
      result.errorType = controller.signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network';
      result.error = result.errorType === 'timeout' ? `Request exceeded ${endpoint.timeout} ms` : result.errorType === 'cancelled' ? 'Run cancelled' : 'Network request failed';
    } finally { active--; result.latencyMs = Math.round((performance.now() - begun) * 1000) / 1000; }
    overall.add(result); metrics[index].add(result);
    if (config.requests !== null && overall.total >= config.requests) budgetController.abort();
    writeQueue = writeQueue.then(() => details.writeFile(JSON.stringify(result) + '\n')).catch(error => {
      fatalError = error; controller.abort(); throw error;
    });
    await writeQueue;
    onRequest?.(captureResponse ? { ...result, responseBody, responseTruncated } : result);
  }
  async function worker(index) {
    await pause(Math.min(config.rampUp * 1000 * index / config.users, Math.max(0, deadline - performance.now())));
    while (!controller.signal.aborted && performance.now() < deadline) {
      if (config.requests !== null && nextRequest >= config.requests) return;
      let number;
      if (config.maxRps) {
        const slot = Math.max(nextSlot, performance.now());
        nextSlot = slot + 1000 / config.maxRps;
        if (slot >= deadline) return;
        number = nextRequest++;
        await pause(Math.min(slot - performance.now(), Math.max(0, deadline - performance.now())));
        if (controller.signal.aborted || performance.now() >= deadline) return;
      } else number = nextRequest++;
      const endpointIndex = number % config.endpoints.length;
      await request(config.endpoints[endpointIndex], endpointIndex, index, number);
      if (config.thinkTime) await pause(Math.min(config.thinkTime, Math.max(0, deadline - performance.now())));
    }
  }
  let errors;
  try { errors = await Promise.allSettled(Array.from({ length: Math.min(config.users, config.requests ?? config.users) }, (_,i) => worker(i))); }
  finally {
    if (interval) clearInterval(interval);
    signal?.removeEventListener('abort', abort);
    await details.close();
  }
  const failedWorker = errors.find(e => e.status === 'rejected');
  if (fatalError || failedWorker) throw fatalError ?? failedWorker.reason;
  const summary = { ...snapshot(), endedAt: new Date().toISOString(), cancelled: controller.signal.aborted,
    settings: { users: config.users, duration: config.duration, requests: config.requests, timeout: config.timeout, thinkTime: config.thinkTime, rampUp: config.rampUp, maxRps: config.maxRps },
    percentileMethod: 'Logarithmic histogram upper bounds, within 1% or 0.01 ms; includes all completed attempts',
    files: { details: detailsPath, summary: summaryPath },
    thresholds: Object.entries(config.thresholds).map(([metric, limit]) => {
      const actual = metric === 'p95' ? overall.percentile(95) : (overall.total ? overall.failed / overall.total * 100 : 0);
      return { metric, limit, actual: Math.round(actual * 100) / 100, passed: actual <= limit };
    }) };
  summary.passed = !summary.cancelled && summary.total > 0 && summary.thresholds.every(t => t.passed);
  await writeFile(summaryPath + '.tmp', JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  await rename(summaryPath + '.tmp', summaryPath);
  onProgress?.(summary);
  return summary;
}
