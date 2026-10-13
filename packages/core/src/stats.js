// A bounded, logarithmic histogram: percentile upper bounds are within 1% (min 0.01 ms).
export class Metrics {
  constructor() {
    this.total = 0; this.successful = 0; this.failed = 0; this.bytes = 0;
    this.sum = 0; this.min = Infinity; this.max = 0;
    this.buckets = new Map(); this.statusCodes = {}; this.errors = {};
  }
  add(result) {
    this.total++; result.success ? this.successful++ : this.failed++;
    this.bytes += result.bytes; this.sum += result.latencyMs;
    this.min = Math.min(this.min, result.latencyMs); this.max = Math.max(this.max, result.latencyMs);
    const bucket = Math.ceil(Math.log(Math.max(0.01, result.latencyMs) / 0.01) / Math.log(1.01));
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
    const code = String(result.status ?? 'network');
    this.statusCodes[code] = (this.statusCodes[code] ?? 0) + 1;
    if (result.errorType) this.errors[result.errorType] = (this.errors[result.errorType] ?? 0) + 1;
  }
  percentile(p) {
    if (!this.total) return 0;
    let count = 0;
    for (const [bucket, n] of [...this.buckets].sort((a,b) => a[0]-b[0])) {
      count += n;
      if (count >= Math.ceil(this.total * p / 100)) return Math.min(this.max, 0.01 * 1.01 ** bucket);
    }
    return this.max;
  }
  snapshot(seconds) {
    const round = n => Math.round(n * 100) / 100;
    return { total: this.total, successful: this.successful, failed: this.failed,
      errorRate: round(this.total ? this.failed / this.total * 100 : 0),
      requestsPerSecond: round(seconds ? this.total / seconds : 0),
      bytesReceived: this.bytes, bytesPerSecond: round(seconds ? this.bytes / seconds : 0),
      latency: { min: round(this.total ? this.min : 0), mean: round(this.total ? this.sum / this.total : 0), max: round(this.max), p50: round(this.percentile(50)), p90: round(this.percentile(90)), p95: round(this.percentile(95)), p99: round(this.percentile(99)) },
      statusCodes: { ...this.statusCodes }, errors: { ...this.errors } };
  }
}
const secret = /authorization|cookie|token|secret|password|api.?key|credential|signature/i;
export function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k,v]) => [k, secret.test(k) ? '[REDACTED]' : v]));
}
export function redactUrl(raw) {
  const url = new URL(raw);
  for (const key of url.searchParams.keys()) if (secret.test(key)) url.searchParams.set(key, '[REDACTED]');
  return url.href;
}

