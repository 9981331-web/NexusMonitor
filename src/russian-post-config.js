import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function defaultLocalRoot(env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Nexus', 'RussianPostMonitor');
}

function readDpapiSecret(filePath) {
  const escaped = filePath.replace(/'/gu, "''");
  const script = [
    `$value = Get-Content -Raw -LiteralPath '${escaped}'`,
    '$secure = ConvertTo-SecureString $value',
    '$credential = [System.Net.NetworkCredential]::new("", $secure)',
    '[Console]::Out.Write($credential.Password)'
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function loadRussianPostConfig(options = {}) {
  const env = options.processEnv ?? process.env;
  const localRoot = path.resolve(options.localRoot ?? env.RUSSIAN_POST_LOCAL_ROOT ?? defaultLocalRoot(env));
  const secretReader = options.secretReader ?? readDpapiSecret;
  const tokenPath = path.join(localRoot, 'secrets', 'telegram-token.dpapi');
  const chatIdPath = path.join(localRoot, 'secrets', 'telegram-chat-id.dpapi');
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || (options.skipSecrets ? '' : secretReader(tokenPath));
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || (options.skipSecrets ? '' : secretReader(chatIdPath));
  return {
    localRoot,
    profilePath: path.join(localRoot, 'profile'),
    statePath: path.join(localRoot, 'state', 'state.json'),
    lockPath: path.join(localRoot, 'state', 'run.lock'),
    token,
    chatId,
    accountUrl: env.RUSSIAN_POST_ACCOUNT_URL?.trim() || 'https://www.pochta.ru/tracking',
    recoveryEndHour: Number(env.RUSSIAN_POST_RECOVERY_END_HOUR || 16),
    headless: env.RUSSIAN_POST_HEADLESS !== 'false',
    chromeChannel: env.RUSSIAN_POST_CHROME_CHANNEL?.trim() || 'chrome'
  };
}

export function russianPostConfigurationIssues(config, options = {}) {
  const issues = [];
  if (!options.skipSecrets && !config.token) issues.push('local Telegram token is missing');
  if (!options.skipSecrets && !config.chatId) issues.push('local Telegram chat ID is missing');
  if (config.recoveryEndHour <= 14 || config.recoveryEndHour > 18) issues.push('recovery end hour must be from 15 to 18');
  try {
    const url = new URL(config.accountUrl);
    if (url.protocol !== 'https:' || !/(^|\.)pochta\.ru$/iu.test(url.hostname)) issues.push('account URL must be HTTPS on pochta.ru');
  } catch {
    issues.push('account URL is invalid');
  }
  return issues;
}

export { readDpapiSecret };
