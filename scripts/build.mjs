import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'packages/cli/dist');
await mkdir(target, { recursive: true });
await cp(path.join(root, 'packages/core/src'), path.join(target, 'core'), { recursive: true });
await cp(path.join(root, 'apps/web/src'), path.join(target, 'web'), { recursive: true });
for (const name of ['index.js', 'server.js']) {
  const code = await readFile(path.join(root, 'packages/cli/src', name), 'utf8');
  await writeFile(path.join(target, name), code.replaceAll('../../core/src/index.js', './core/index.js').replaceAll('../../../apps/web/src/', './web/'));
}
for (const name of ['README.md', 'LICENSE']) await cp(path.join(root, name), path.join(root, 'packages/cli', name));
console.log('Built standalone npm package with engine, CLI, and web assets.');
