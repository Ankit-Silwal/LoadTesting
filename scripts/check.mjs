import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await check(file);
    else if (/\.(mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status) process.exit(result.status);
    }
  }
}
for (const dir of ['packages/core/src', 'packages/cli/src', 'apps/web/src', 'scripts', 'tests', 'examples']) await check(dir);
console.log('JavaScript syntax checks passed.');
