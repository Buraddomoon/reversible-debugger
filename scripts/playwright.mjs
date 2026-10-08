import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, '.playwright-browsers') },
});
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
