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
    '\nReplace the `REPLACE_WITH_*` placeholders in wrangler.jsonc before deploying (e.g. D1 database_id, TESLA_CLIENT_ID, TESLA_PUBLIC_KEY). ' +
      'If the D1 database_id is still a placeholder, run the "Setup Cloudflare D1 Database" workflow first to create the database and copy the printed database_id into wrangler.jsonc. ' +
      'See README.md > "Configuration" and "Cloudflare D1 setup (one-time)" for details.'
  );
  process.exit(1);
}

console.log('wrangler.jsonc looks good — no placeholder values found.');
