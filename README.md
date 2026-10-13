# LoadTesting

A local HTTP load-testing workspace and an npm CLI. Configure requests like an API client, choose concurrent users, test multiple endpoints together, and save **two logs for every run**.

- CLI arguments, interactive setup, or a reusable JSON configuration.
- Local web UI with a request collection, live metrics, latency chart, endpoint breakdown, and log downloads.
- GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; headers, query parameters, cookies via headers, bearer/basic/API-key auth.
- JSON, raw text, URL-encoded forms, multipart text fields, and binary uploads.
- Environment variables, Postman v2 collection imports, expected statuses, text and JSON assertions.
- Duration or an exact request count, concurrency, ramp up, think time, request timeouts, and a global start-rate cap.
- Overall and per-endpoint success/failure counts, status codes, error categories, RPS, received bytes, min/mean/max latency, P50/P90/P95/P99.
- Optional performance thresholds for CI, cancellation with flushed logs, and no runtime dependencies.

Requires **Node.js 22 or newer**. Works on Windows, macOS, and Linux.

## Run from GitHub now

```sh
git clone https://github.com/Ankit-Silwal/LoadTesting.git
cd LoadTesting
npm install
npm run dev
```

Open the printed address, normally **http://127.0.0.1:4310**. The default collection targets built-in demo endpoints, so you can click **Run load test** immediately. Replace them with your own URLs, edit requests, and configure concurrency on the right. **Send** runs one attempt against the selected endpoint. Runs execute in Node on your machine, so browser CORS restrictions do not apply to target APIs.

The workspace has no remote backend or account. It binds to `127.0.0.1`, uses a browser session cookie and same-origin checks, and writes logs beneath the directory where you started it. Request configs stay in the page until you export them. Recent history keeps the latest 20 runs for the lifetime of the server; disk logs remain after restarting.

Run the CLI from the checkout:

```sh
npm run loadtest -- run --url http://127.0.0.1:4000/health --users 20 --duration 10
npm run loadtest -- run --config examples/multiple-endpoints.json
npm run loadtest -- init
npm run loadtest -- --help
```

For the example config, start the demo API in a second terminal with `npm run demo`.

You can also copy or clone the whole repository and run it directly **without installing dependencies**:

```sh
node packages/cli/src/index.js web
node packages/cli/src/index.js run --url http://127.0.0.1:4000/health --users 5 --requests 100
```

The source entry point needs the accompanying core and web directories; copying just one source file is insufficient. A packed npm package contains all of them.

## Run from npm after publication

The package is prepared as **`@ankit-silwal/loadtesting`** with a **`loadtesting`** executable. It has **not been published**. Once you publish that name (or rename it to a scope you own):

```sh
npx @ankit-silwal/loadtesting run --url https://your-api.example/health --users 20 --duration 30
npx @ankit-silwal/loadtesting web
npx @ankit-silwal/loadtesting run
npx @ankit-silwal/loadtesting init
npx @ankit-silwal/loadtesting run --config loadtest.json
```

The bare `run` command prompts for endpoints, users, duration, method, headers, and body in a terminal. All controls are also available through arguments/configuration.

Or install it:

```sh
npm install -g @ankit-silwal/loadtesting
loadtesting --help
loadtesting web --port 4310
```

### Multiple endpoints, headers, auth, and bodies

```sh
loadtesting run --url http://localhost:4000/health --url http://localhost:4000/slow --users 25 --requests 500 --timeout 5000
loadtesting run --url http://localhost:4000/echo --method POST --body-type json --data '{"hello":"world"}' --header 'Content-Type: application/json' --query 'page=1' --users 10 --duration 15
loadtesting run --url https://your-api.example/private --bearer '{{API_TOKEN}}' --users 10 --duration 10
loadtesting run --url https://your-api.example/upload --method POST --body-type binary --data-file ./payload.bin --header 'Content-Type: application/octet-stream' --requests 10
```

Shell quoting differs. On Windows PowerShell, prefer a JSON config or `--data-file payload.json` for complex bodies. Set variables using `$env:API_TOKEN='…'` in PowerShell or `export API_TOKEN='…'` in bash. Command-line secrets can appear in shell history; variable placeholders avoid putting the actual token in the command.

Repeated `--url` endpoints share method/body/header flags. **Use a config for different methods, headers, bodies, and assertions per endpoint.**

### Configuration

```json
{
  "name": "My API",
  "users": 20,
  "duration": 30,
  "timeout": 10000,
  "rampUp": 2,
  "thinkTime": 20,
  "maxRps": 100,
  "variables": {
    "baseUrl": "http://localhost:4000"
  },
  "endpoints": [
    {
      "id": "health",
      "name": "Health",
      "method": "GET",
      "url": "{{baseUrl}}/health",
      "headers": { "Accept": "application/json" },
      "query": { "region": "local" },
      "assertions": { "json": { "ok": true } }
    },
    {
      "id": "create",
      "name": "Create item",
      "method": "POST",
      "url": "{{baseUrl}}/echo",
      "auth": { "type": "bearer", "token": "{{API_TOKEN}}" },
      "bodyType": "json",
      "body": { "title": "Load test" },
      "expectedStatus": [200, 201],
      "assertions": { "contains": "title" },
      "redirect": "follow"
    }
  ],
  "thresholds": { "p95": 500, "errorRate": 1 }
}
```

`{{variables}}` resolve from process environment, then config `variables`, then CLI `--var key=value` overrides. Missing variables stop a run before sending traffic. Keep tokens in environment variables where possible.

Auth types:

| Type | Fields |
| --- | --- |
| `none` | No automatic auth header |
| `bearer` | `token` |
| `basic` | `username`, `password` |
| `apiKey` | `key`, `value`, `in`: `header` or `query` |

Body types:

| Type | Configuration |
| --- | --- |
| `none` | No body |
| `raw` | Text string, content type supplied through headers |
| `json` | JSON value or a JSON string; defaults content type to JSON |
| `urlencoded` | Object of text fields; supplies the content type |
| `multipart` | Object of text fields; generates a multipart boundary |
| `binary` | Base64 string; CLI can read a binary file with `--data-file` |

Binary uploads support arbitrary payload files. Multipart file attachments are not implemented; multipart supports text fields. Web file input is limited to 1 MiB; CLI files are read into memory. GET and HEAD bodies are rejected.

`expectedStatus` changes which statuses count as success. By default only 2xx succeeds. A timeout, network failure, unexpected status, or failed assertion counts as a failure. JSON assertions use dot paths with exact JSON value comparison and support response bodies up to 1 MiB. Contains assertions inspect the first 1 MiB. No response bodies are stored in normal load-test logs.

### Load model and metrics

- **Users:** maximum concurrent virtual users across the collection, not per endpoint. Each user waits for its request and log write before sending another.
- **Distribution:** global round-robin across endpoints; each attempt targets one endpoint. This is a closed-user load model, not an ordered workflow.
- **Duration:** seconds during which new requests may start. In-flight requests finish or reach their timeout, so total wall time can exceed the duration.
- **Requests:** exact total attempt count across all endpoints. Choose this or duration, not both.
- **Ramp up:** seconds over which users begin. **Think time:** milliseconds between each user's requests.
- **Max RPS:** globally paces request starts; achieved throughput can be lower due to latency, logging, and hardware. Zero disables the cap.
- **Latency:** time from sending to consuming the complete response, including redirects where followed. Failures and timeouts are included.
- **Percentiles:** bounded logarithmic histogram upper bounds, within 1% or 0.01 ms before display rounding. The chart shows cumulative P95 over time, not interval P95.
- **RPS/bytes per second:** completed attempts/received bytes divided by run wall time. Bytes count decoded response chunks, not wire bytes.
- **Thresholds:** maximum P95 in milliseconds and error rate in percent. Without thresholds, HTTP failures are reported but do not alone set a failing exit code.

Ctrl+C or the UI's **Stop run** cancels in-flight requests and flushes both log files. Cancelled attempts are included as failures.

This is an HTTP performance tool with familiar request-building controls. It does not execute Postman scripts, implement OAuth token acquisition, a cookie jar, WebSocket/gRPC tests, or sequential dependent workflows. Supply cookies using a `Cookie` header and OAuth tokens using bearer auth. Use targets you control or are authorized to test.

### Postman import

Export a Postman v2 collection, then:

```sh
loadtesting import collection.json --env environment.json --file imported-loadtest.json
loadtesting run --config imported-loadtest.json
```

Imports nested folders, inherited auth, active headers, collection/environment variables, and supported bodies. The web UI also accepts a collection through **Import config / Postman**; edit environment values in the Variables tab afterward. Scripts and Postman tests are not imported; add load-test assertions explicitly. Unsupported auth and Postman file uploads are rejected with an actionable message.

### Logs

Default output:

```text
your-current-directory/
  loadtesting-logs/
    2026-10-14T00-00-00-000Z-ab12cd34/
      requests.ndjson
      summary.json
```

Each run has its own directory, so repeated tests do not overwrite logs. Change the parent directory with `--out ./reports`.

`requests.ndjson` contains one JSON record per completed attempt: sequence, virtual user, timestamp, endpoint ID, method, URL, redacted request/response headers, status, success, latency, received bytes, and any error category/message.

`summary.json` contains global and per-endpoint metrics, settings, timestamps, peak concurrency, status/error counts, percentile method, threshold results, and both file paths.

Known secret headers/query names (authorization, cookie, token, password, secret, API key, signature, credentials) are redacted. Bodies are excluded. URLs, endpoint names, and custom fields can still contain sensitive data; redaction cannot infer every secret. Exported configuration includes its literal values. Generated logs and packages are gitignored.

### CLI options and exit codes

`loadtesting --help` lists every option. Useful CI usage:

```sh
loadtesting run --config loadtest.json --p95 500 --error-rate 1 --json --out ./reports
```

| Exit | Meaning |
| --- | --- |
| 0 | Run completed and configured thresholds passed |
| 1 | Invalid arguments/configuration or runtime/logging error |
| 2 | Threshold failed or no requests completed |
| 130 | Run cancelled |

`--json` writes only the final summary to stdout; errors go to stderr. Config values can be overridden using CLI load-control flags. `init` and `import` refuse to overwrite an existing file.

## Monorepo

```text
apps/web/src/         Browser request builder and live dashboard
packages/core/src/   Config validation/import, load runner, bounded metrics
packages/cli/src/    CLI and localhost web server
scripts/             Build and syntax checks
tests/               Engine, CLI, and local-server integration tests
examples/            Standalone demo API and multi-endpoint config
```

The root uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces/). The public package's build copies the shared engine and static web assets into one standalone distribution; consumers do not need unpublished workspace packages. The engine uses Node's [built-in fetch](https://nodejs.org/docs/latest/api/globals.html#fetch).

```sh
npm ci
npm run check
npm test
npm run build
npm run pack
```

CI verifies Node 22/24 on Windows and Linux. To test the actual tarball before publication, install the resulting `.tgz` in a temporary directory and run its `loadtesting --help` and `loadtesting web` commands.

The published module also exposes the engine:

```js
import { runLoadTest } from '@ankit-silwal/loadtesting';
const summary = await runLoadTest({
  users: 5,
  requests: 50,
  endpoints: [{ url: 'http://localhost:4000/health' }]
}, { outputDir: './reports' });
console.log(summary.latency.p95, summary.files);
```

## Publish later

1. Choose a package name/scope you own in `packages/cli/package.json`. Update the matching workspace references in root scripts/CI and the examples in this README if renamed.
2. Set the version in the public package. The existing repository license is retained as AGPL-3.0-only.
3. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, and `npm pack --workspace @ankit-silwal/loadtesting`. Inspect/install the tarball.
4. Sign in using `npm login`, then `npm publish --workspace @ankit-silwal/loadtesting --access public`.
5. Follow npm's account and authentication requirements in the [official publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages).

Only `packages/cli` is publishable; the core/web/root are private. The repository does not automatically publish to npm on push.

## License

[GNU Affero General Public License v3.0](LICENSE), matching the repository's original license.
