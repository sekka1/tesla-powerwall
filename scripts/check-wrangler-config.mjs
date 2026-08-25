#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findPlaceholders } from './config-placeholders.mjs';

const configPath = path.join(process.cwd(), 'wrangler.jsonc');
const contents = readFileSync(configPath, 'utf8');
const placeholders = findPlaceholders(contents);

if (placeholders.length > 0) {
  console.error('wrangler.jsonc still contains placeholder values that must be replaced before deploying:');
  for (const placeholder of placeholders) {
    console.error(`  - ${placeholder}`);
  }
  console.error(
    '\nRun the "Setup Cloudflare D1 Database" GitHub Actions workflow (workflow_dispatch) to create the D1 ' +
      'database, then copy the printed database_id into wrangler.jsonc. See README.md > "Cloudflare D1 setup ' +
      '(one-time)" for details.'
  );
  process.exit(1);
}

console.log('wrangler.jsonc looks good — no placeholder values found.');
