import { readFile } from 'node:fs/promises';

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export function interpolate(value, variables = {}) {
  if (typeof value === 'string') return value.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
    if (variables[key.trim()] === undefined) throw new Error(`Missing variable: ${key.trim()}`);
    return String(variables[key.trim()]);
  });
  if (Array.isArray(value)) return value.map(v => interpolate(v, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, interpolate(v, variables)]));
  return value;
}
function integer(value, fallback, min, max, label) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return n;
}
function pairs(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, String(v)]));
}
export function normalizeConfig(input, environment = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object');
  const variables = { ...environment, ...pairs(input.variables, 'variables') };
  const config = interpolate(input, variables);
  if (!Array.isArray(config.endpoints) || !config.endpoints.length) throw new Error('Provide at least one endpoint');
  if (config.endpoints.length > 100) throw new Error('Maximum 100 endpoints per run');
  const users = integer(config.users, 10, 1, 10000, 'users');
  const requests = config.requests === undefined ? null : integer(config.requests, null, 1, 10000000, 'requests');
  const duration = config.duration === undefined ? (requests ? null : 10) : Number(config.duration);
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 86400)) throw new Error('duration must be seconds greater than 0 and at most 86400');
  if (requests !== null && config.duration !== undefined) throw new Error('Choose requests or duration, not both');
  const timeout = integer(config.timeout, 10000, 1, 300000, 'timeout');
  const thinkTime = integer(config.thinkTime, 0, 0, 300000, 'thinkTime');
  const rampUp = Number(config.rampUp ?? 0);
  const maxRps = Number(config.maxRps ?? 0);
  if (!Number.isFinite(rampUp) || rampUp < 0 || rampUp > 86400) throw new Error('rampUp must be seconds from 0 to 86400');
  if (!Number.isFinite(maxRps) || maxRps < 0 || maxRps > 100000) throw new Error('maxRps must be from 0 to 100000');
  const thresholds = config.thresholds ?? {};
  for (const [key, value] of Object.entries(thresholds)) {
    if (!['p95', 'errorRate'].includes(key) || !Number.isFinite(value) || value < 0 || (key === 'errorRate' && value > 100)) throw new Error('Thresholds support p95 (ms) and errorRate (0–100 percent)');
  }
  const ids = new Set();
  const endpoints = config.endpoints.map((e, i) => {
    const id = String(e.id ?? `endpoint-${i+1}`);
    if (ids.has(id)) throw new Error(`Duplicate endpoint id: ${id}`);
    ids.add(id);
    let url;
    try { url = new URL(e.url); } catch { throw new Error(`Endpoint ${i+1}: provide a full HTTP URL`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS endpoints are supported');
    if (url.username || url.password) throw new Error('Use basic auth instead of credentials in URLs');
    for (const [key, value] of Object.entries(pairs(e.query, 'query'))) url.searchParams.set(key, value);
    const method = String(e.method ?? 'GET').toUpperCase();
    if (!methods.has(method)) throw new Error(`Unsupported method: ${method}`);
    const headers = pairs(e.headers, 'headers');
    const auth = e.auth ?? { type: 'none' };
    if (auth.type === 'bearer') headers.authorization = `Bearer ${auth.token ?? ''}`;
    else if (auth.type === 'basic') headers.authorization = `Basic ${Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')}`;
    else if (auth.type === 'apiKey') {
      if (!auth.key) throw new Error('API key auth requires a key name');
      if (auth.in === 'query') url.searchParams.set(auth.key, String(auth.value ?? ''));
      else headers[auth.key] = String(auth.value ?? '');
    } else if (auth.type !== 'none') throw new Error('Auth supports none, bearer, basic, or apiKey');
    let body = e.body;
    const bodyType = e.bodyType ?? (typeof body === 'object' ? 'json' : 'raw');
    if (!['none','raw','json','urlencoded','multipart','binary'].includes(bodyType)) throw new Error('Unsupported bodyType');
    if (bodyType === 'none') body = undefined;
    if (body !== undefined && ['GET', 'HEAD'].includes(method)) throw new Error(`${method} cannot have a request body`);
    if (bodyType === 'json' && body !== undefined) {
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw new Error(`Invalid JSON body for ${id}`); } }
      body = JSON.stringify(body);
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    } else if (bodyType === 'urlencoded') {
      body = new URLSearchParams(pairs(body, 'urlencoded body')).toString();
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (bodyType === 'multipart') {
      body = pairs(body, 'multipart body');
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
    } else if (bodyType === 'binary' && body !== undefined) {
      if (typeof body !== 'string') throw new Error('Binary body must be a base64 string');
    } else if (body !== undefined && typeof body !== 'string') throw new Error('Raw body must be a string');
    // Validate header names and values before starting any traffic.
    new Headers(headers);
    const expectedStatus = e.expectedStatus ?? [];
    if (!Array.isArray(expectedStatus) || expectedStatus.some(n => !Number.isInteger(n) || n < 100 || n > 599)) throw new Error('expectedStatus must be an array of HTTP status codes');
    const assertions = e.assertions ?? {};
    if (assertions.contains !== undefined && typeof assertions.contains !== 'string') throw new Error('assertions.contains must be a string');
    if (assertions.json !== undefined) pairs(assertions.json, 'assertions.json');
    if (e.redirect !== undefined && !['follow', 'manual', 'error'].includes(e.redirect)) throw new Error('redirect must be follow, manual, or error');
    return { id, name: String(e.name ?? id), url: url.href, method, headers, body, bodyType, expectedStatus, assertions, redirect: e.redirect ?? 'follow', timeout: integer(e.timeout, timeout, 1, 300000, 'endpoint timeout') };
  });
  return { name: String(config.name ?? 'Load test'), users, requests, duration, timeout, thinkTime, rampUp, maxRps, endpoints, thresholds };
}
export async function readConfig(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
export function importPostman(collection, environment = {}) {
  if (!Array.isArray(collection?.item)) throw new Error('Expected a Postman v2 collection');
  const variables = Object.fromEntries((collection.variable ?? []).map(v => [v.key, v.value ?? '']));
  Object.assign(variables, environment);
  const endpoints = [];
  function authValue(auth) {
    if (!auth || auth.type === 'noauth') return { type: 'none' };
    const values = Object.fromEntries((auth[auth.type] ?? []).map(v => [v.key, v.value]));
    if (auth.type === 'bearer') return { type: 'bearer', token: values.token };
    if (auth.type === 'basic') return { type: 'basic', username: values.username, password: values.password };
    if (auth.type === 'apikey') return { type: 'apiKey', key: values.key, value: values.value, in: values.in };
    throw new Error(`Postman auth "${auth.type}" is unsupported; supply the resulting token/header manually`);
  }
  function visit(items, inheritedAuth) {
    for (const item of items) {
      const auth = item.auth ?? inheritedAuth;
      if (item.item) { visit(item.item, auth); continue; }
      const r = typeof item.request === 'string' ? { url: item.request } : item.request;
      if (!r) continue;
      const body = r.body ?? {};
      const pairs = values => Object.fromEntries((values ?? []).filter(v => !v.disabled).map(v => [v.key, v.value ?? '']));
      if (body.mode === 'file' || (body.formdata ?? []).some(v => v.type === 'file')) throw new Error('Postman file uploads require adding the file manually after import');
      endpoints.push({
        name: item.name, method: r.method ?? 'GET', url: typeof r.url === 'string' ? r.url : r.url?.raw,
        headers: pairs(r.header), auth: authValue(r.auth ?? auth),
        bodyType: body.mode === 'raw' ? (body.options?.raw?.language === 'json' ? 'json' : 'raw') : body.mode === 'urlencoded' ? 'urlencoded' : body.mode === 'formdata' ? 'multipart' : 'none',
        body: body.mode === 'raw' ? body.raw : body.mode === 'urlencoded' ? pairs(body.urlencoded) : body.mode === 'formdata' ? pairs(body.formdata) : undefined,
      });
    }
  }
  visit(collection.item, collection.auth);
  return { name: collection.info?.name ?? 'Imported collection', users: 10, duration: 10, variables, endpoints };
}

