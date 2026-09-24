#!/usr/bin/env node
/**
 * Run the production copy of the tool — the one scripts/deploy.js keeps on main — with the
 * arguments given, e.g. `node scripts/production.js setup --port 4720` for the real setup
 * page. Development work uses scripts/demo.js instead, and never real data.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const prod = process.env.CARE_ALBUM_PRODUCTION ?? join(homedir(), 'Applications', 'care-album-saver');
const cli = join(prod, 'packages', 'care-album-saver', 'dist', 'cli.js');
if (!existsSync(join(prod, '.care-album-saver-production')) || !existsSync(cli)) {
  process.stderr.write(`\n  There is no production copy at ${prod} yet. Run: node scripts/deploy.js\n`);
  process.exit(1);
}
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: prod, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
