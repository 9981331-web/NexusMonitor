import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/^\uFEFF/u, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) throw new Error('Invalid line in .env file');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function assertSafeEnvPath(envPath) {
  const segments = path.resolve(envPath).toLowerCase().split(/[\\/]+/u);
  if (segments.some((part) => part === 'onedrive' || part.startsWith('onedrive -')) ||
      segments.includes('base_obsidian') || segments.includes('base_obsidian_old')) {
    throw new Error('The .env file must be outside OneDrive and Obsidian vaults');
  }
}

export function loadConfig(options = {}) {
  const baseEnv = options.processEnv ?? process.env;
  const envPath = path.resolve(options.envPath ?? baseEnv.NEXUS_COURT_ENV_FILE ?? path.join(projectRoot, '.env'));
  assertSafeEnvPath(envPath);
  const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const env = { ...fileEnv, ...baseEnv };
  const caseUrls = [env.COURT_CASE_URL?.trim(), env.COURT_CASE_URL_2?.trim()].filter(Boolean);
  const caseNumbers = [env.COURT_CASE_NUMBER?.trim(), env.COURT_CASE_NUMBER_2?.trim()];
  return {
    envPath,
    token: env.TELEGRAM_BOT_TOKEN?.trim() || '',
    chatId: env.TELEGRAM_CHAT_ID?.trim() || '',
    caseUrl: caseUrls[0] || '',
    caseNumber: caseNumbers[0] || '',
    cases: caseUrls.map((url, index) => ({ url, caseNumber: caseNumbers[index] || '' })),
    timeZone: env.COURT_TIME_ZONE?.trim() || 'Europe/Moscow',
    pollTimes: env.COURT_POLL_TIMES?.trim() || '12:00,18:00',
    statePath: path.resolve(options.statePath ?? path.join(projectRoot, 'data', 'state.json')),
    aggregateStatePath: path.resolve(options.aggregateStatePath ?? path.join(projectRoot, 'data', 'daily.json'))
  };
}

export function configurationIssues(config) {
  const issues = [];
  if (!config.cases.length) issues.push('COURT_CASE_URL is missing');
  for (const item of config.cases) {
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol)) issues.push('COURT_CASE_URL must use HTTP or HTTPS');
    } catch {
      issues.push('COURT_CASE_URL is not a valid URL');
    }
  }
  if (!config.token) issues.push('TELEGRAM_BOT_TOKEN is missing');
  if (!config.chatId) issues.push('TELEGRAM_CHAT_ID is missing');
  if (config.timeZone !== 'Europe/Moscow') issues.push('COURT_TIME_ZONE must be Europe/Moscow');
  if (config.pollTimes !== '12:00,18:00') issues.push('COURT_POLL_TIMES must be 12:00,18:00');
  return issues;
}

export { parseEnv, assertSafeEnvPath, projectRoot };
