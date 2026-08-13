import fs from 'node:fs';
import path from 'node:path';
import { loadRussianPostConfig, russianPostConfigurationIssues } from './russian-post-config.js';
import { openRussianPostLogin, readRussianPostAccount, RussianPostAuthError } from './russian-post-browser.js';
import { runRussianPostMonitor } from './russian-post-monitor.js';
import { isRussianPostRunWindow, moscowParts } from './russian-post-schedule.js';

const command = process.argv[2] || 'check';

function log(level, message, details = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...details })}\n`);
}

function secretFilesPresent(localRoot) {
  return ['telegram-token.dpapi', 'telegram-chat-id.dpapi']
    .every((name) => fs.existsSync(path.join(localRoot, 'secrets', name)));
}

try {
  if (command === 'check') {
    const config = loadRussianPostConfig({ skipSecrets: true });
    const issues = russianPostConfigurationIssues(config, { skipSecrets: true });
    if (!secretFilesPresent(config.localRoot)) issues.push('local DPAPI Telegram configuration is missing');
    log(issues.length ? 'info' : 'info', issues.length ? 'not-configured' : 'configuration-ready', {
      issues,
      monitoringStarted: false,
      schedule: 'daily 14:00 Europe/Moscow; recovery until 16:00'
    });
  } else if (command === 'login') {
    const config = loadRussianPostConfig({ skipSecrets: true });
    const issues = russianPostConfigurationIssues(config, { skipSecrets: true });
    if (issues.length) throw new Error('Russian Post local configuration is invalid');
    log('info', 'login-window-opened', { instruction: 'Complete login manually and close the browser window' });
    await openRussianPostLogin(config);
    log('info', 'login-window-closed');
  } else if (command === 'probe') {
    const config = loadRussianPostConfig({ skipSecrets: true });
    const result = await readRussianPostAccount(config, { headless: false, probe: true });
    log('info', 'account-probe-complete', result.probe);
  } else if (command === 'once' || command === 'scheduled') {
    const config = loadRussianPostConfig();
    const issues = russianPostConfigurationIssues(config);
    if (issues.length) throw new Error('Russian Post local configuration is incomplete');
    if (command === 'scheduled' && !isRussianPostRunWindow(new Date(), config.recoveryEndHour)) {
      log('info', 'outside-run-window', { localDate: moscowParts(new Date()).dateKey });
    } else {
      const result = await runRussianPostMonitor(config);
      log('info', result.outcome, {
        notified: result.notified,
        incoming: result.incoming ?? 0,
        delivered: result.delivered ?? 0,
        messageId: result.messageId ?? null,
        sentAt: result.sentAt ?? null
      });
    }
  } else {
    log('error', 'Usage: node src/russian-post-cli.js check|login|probe|once|scheduled');
    process.exitCode = 1;
  }
} catch (error) {
  const kind = error instanceof RussianPostAuthError ? 'authorization-required' : 'operation-failed';
  log('error', kind);
  process.exitCode = 1;
}
