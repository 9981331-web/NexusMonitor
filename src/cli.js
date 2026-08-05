import { loadConfig, configurationIssues } from './config.js';
import { checkAll } from './monitor.js';
import { nextScheduledCheck } from './schedule.js';

const command = process.argv[2] || 'check';

function log(level, message, details = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...details })}\n`);
}

function safeErrorMessage(error, currentConfig) {
  let message = error instanceof Error ? error.message : 'Unknown error';
  for (const secret of [currentConfig?.token, currentConfig?.chatId]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

let config;
try {
  config = loadConfig();
} catch (error) {
  log('error', error.message);
  process.exitCode = 1;
}

if (config) {
  const issues = configurationIssues(config);
  if (command === 'check') {
    if (issues.length) {
      log('info', 'not-configured', { issues, monitoringStarted: false });
    } else {
      log('info', 'configuration-ready', { monitoringStarted: false, schedule: 'weekdays 12:08,18:08 Europe/Moscow' });
    }
  } else if (!['once', 'monitor', 'midday', 'evening'].includes(command)) {
    log('error', 'Usage: node src/cli.js check|once|midday|evening|monitor');
    process.exitCode = 1;
  } else if (issues.length) {
    log('error', 'monitoring-refused', { issues, monitoringStarted: false });
    process.exitCode = 1;
  } else {
    const run = async (slot = 'manual') => {
      try {
        const result = await checkAll(config, { slot });
        log('info', result.outcome, { notified: result.notified });
      } catch (error) {
        log('error', safeErrorMessage(error, config));
        if (command === 'once') process.exitCode = 1;
      }
    };

    if (['once', 'midday', 'evening'].includes(command)) {
      await run(command === 'once' ? 'manual' : command);
    } else {
      log('info', 'monitor-started', { schedule: 'weekdays 12:08,18:08 Europe/Moscow' });
      const schedule = () => {
        const next = nextScheduledCheck();
        const delay = Math.max(0, next.at.getTime() - Date.now());
        log('info', 'next-check-scheduled', { at: next.at.toISOString(), slot: next.kind });
        setTimeout(async () => {
          await run(next.kind);
          schedule();
        }, delay);
      };
      schedule();
    }
  }
}
