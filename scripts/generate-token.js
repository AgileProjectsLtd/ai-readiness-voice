#!/usr/bin/env node

/**
 * Token generator CLI for AI Readiness Voice Interview
 *
 * Usage:
 *   node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd"
 *   node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd" --env prod
 *   node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd" --expires 2026-06-30 --portfolio "Fund IV" --region APAC
 *   node scripts/generate-token.js --batch tokens.csv
 *   node scripts/generate-token.js --list
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const envFile = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const TOKEN_LENGTH = 12;
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HOSTED_ZONE_DOMAIN = process.env.HOSTED_ZONE_DOMAIN || 'example.com';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const ENV = args.env || process.env.DEPLOY_ENV || 'dev';
const CUSTOM_DOMAIN = `ai-readiness-${ENV}.${HOSTED_ZONE_DOMAIN}`;
const BASE_URL = process.env.BASE_URL || `https://${CUSTOM_DOMAIN}`;
const DATA_BUCKET = `ai-readiness-${ENV}-data`;
const ALLOWLIST_FILE = path.join(PROJECT_ROOT, 'allowlist.json');

function generateToken() {
  const bytes = crypto.randomBytes(TOKEN_LENGTH);
  let token = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    token += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  }
  return token;
}

function loadAllowlist() {
  if (fs.existsSync(ALLOWLIST_FILE)) {
    const raw = fs.readFileSync(ALLOWLIST_FILE, 'utf-8');
    return JSON.parse(raw);
  }
  return { entries: [] };
}

function saveAllowlist(data) {
  fs.writeFileSync(ALLOWLIST_FILE, JSON.stringify(data, null, 2));
}

function createEntry(name, company, options = {}) {
  const token = generateToken();
  const now = new Date().toISOString();

  const entry = {
    token,
    respondentName: name,
    companyName: company,
    status: 'active',
    createdAt: now,
  };

  if (options.expires) {
    entry.expiresAt = new Date(options.expires).toISOString();
  }

  const metadata = {};
  if (options.portfolio) metadata.portfolio = options.portfolio;
  if (options.region) metadata.region = options.region;
  if (Object.keys(metadata).length > 0) {
    entry.metadata = metadata;
  }

  return entry;
}

function revokeExisting(entries, name, company) {
  let count = 0;
  for (const existing of entries) {
    if (
      existing.respondentName === name &&
      existing.companyName === company &&
      existing.status === 'active'
    ) {
      existing.status = 'revoked';
      existing.revokedAt = new Date().toISOString();
      existing.revokedReason = 'replaced';
      count++;
    }
  }
  return count;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function handleBatch(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/);
  const header = lines[0].toLowerCase();
  const hasHeader = header.includes('name') || header.includes('company');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const allowlist = loadAllowlist();
  const results = [];
  let totalRevoked = 0;

  for (const line of dataLines) {
    if (!line.trim()) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 2) continue;

    const [name, company, expires, portfolio, region] = parts;
    if (!name || !company) continue;

    totalRevoked += revokeExisting(allowlist.entries, name, company);
    const entry = createEntry(name, company, { expires, portfolio, region });
    allowlist.entries.push(entry);
    results.push({ name, company, token: entry.token, url: `${BASE_URL}/r/${entry.token}` });
  }

  saveAllowlist(allowlist);

  console.log(`\nEnvironment: ${ENV}`);
  if (totalRevoked > 0) {
    console.log(`Revoked ${totalRevoked} previous token(s) for duplicate name/company pairs`);
  }
  console.log(`Generated ${results.length} tokens:\n`);
  results.forEach(r => {
    console.log(`  ${r.name} (${r.company})`);
    console.log(`    URL: ${r.url}\n`);
  });

  console.log(`Allowlist saved to: ${ALLOWLIST_FILE}`);
  console.log(`Total entries: ${allowlist.entries.length} (${allowlist.entries.filter(e => e.status === 'active').length} active)`);
  console.log(`\nUpload to S3:`);
  console.log(`  aws s3 cp ${ALLOWLIST_FILE} s3://${DATA_BUCKET}/allowlist/allowlist.json`);
}

function handleList() {
  const allowlist = loadAllowlist();
  if (allowlist.entries.length === 0) {
    console.log('No entries in allowlist.');
    return;
  }

  console.log(`\nAllowlist (${allowlist.entries.length} entries) — env: ${ENV}\n`);
  allowlist.entries.forEach(e => {
    const status = e.status === 'active' ? '\x1b[32mactive\x1b[0m' : `\x1b[31m${e.status}\x1b[0m`;
    console.log(`  ${e.respondentName} (${e.companyName}) [${status}]`);
    console.log(`    Token: ${e.token.substring(0, 12)}...`);
    console.log(`    URL:   ${BASE_URL}/r/${e.token}`);
    if (e.expiresAt) console.log(`    Expires: ${e.expiresAt}`);
    console.log('');
  });
}

// ─── Main ───
if (args.list) {
  handleList();
} else if (args.batch) {
  handleBatch(args.batch);
} else if (args.name && args.company) {
  const entry = createEntry(args.name, args.company, {
    expires: args.expires,
    portfolio: args.portfolio,
    region: args.region,
  });

  const allowlist = loadAllowlist();
  const revokedCount = revokeExisting(allowlist.entries, args.name, args.company);

  allowlist.entries.push(entry);
  saveAllowlist(allowlist);

  console.log(`\nEnvironment: ${ENV}`);
  if (revokedCount > 0) {
    console.log(`Revoked ${revokedCount} previous token(s) for ${args.name} (${args.company})`);
  }
  console.log(`Token generated for ${args.name} (${args.company})`);
  console.log(`  Token:  ${entry.token}`);
  console.log(`  URL:    ${BASE_URL}/r/${entry.token}`);
  if (entry.expiresAt) console.log(`  Expires: ${entry.expiresAt}`);
  console.log(`\nAllowlist saved to: ${ALLOWLIST_FILE}`);
  console.log(`Total entries: ${allowlist.entries.length} (${allowlist.entries.filter(e => e.status === 'active').length} active)`);
  console.log(`\nUpload to S3:`);
  console.log(`  aws s3 cp ${ALLOWLIST_FILE} s3://${DATA_BUCKET}/allowlist/allowlist.json`);
} else {
  console.log(`
AI Readiness Voice Interview — Token Generator

Usage:
  node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd"
  node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd" --env prod
  node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd" --expires 2026-06-30
  node scripts/generate-token.js --name "Jane Doe" --company "Acme Ltd" --portfolio "Fund IV" --region APAC
  node scripts/generate-token.js --batch tokens.csv
  node scripts/generate-token.js --list

Options:
  --name       Respondent name (required for single)
  --company    Company name (required for single)
  --env        Environment: dev, staging, prod (default: dev)
  --expires    Expiry date (ISO or YYYY-MM-DD)
  --portfolio  Portfolio/fund name (metadata)
  --region     Region (metadata)
  --batch      Path to CSV file (name,company,expires,portfolio,region)
  --list       List all entries in local allowlist

Environment variables:
  DEPLOY_ENV   Environment override (same as --env)
  BASE_URL     Full override for generated URLs
`);
}
