import fs from 'node:fs';
import path from 'node:path';
import { processRussianPostSnapshot, formatRussianPostFailure, formatRussianPostMessage, splitTelegramMessage } from './russian-post-domain.js';
import { readRussianPostState, writeRussianPostState } from './russian-post-state.js';
import { readRussianPostAccount, RussianPostAuthError } from './russian-post-browser.js';
import { moscowParts } from './russian-post-schedule.js';
import { sendTelegram } from './telegram.js';

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(handle, String(process.pid));
    return () => {
      try { fs.closeSync(handle); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    };
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
}

async function retryRead(readAccount, config, delay, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readAccount(config);
    } catch (error) {
      lastError = error;
      if (error instanceof RussianPostAuthError || attempt === attempts) throw error;
      await delay(attempt * 2_000);
    }
  }
  throw lastError;
}

export async function runRussianPostMonitor(config, dependencies = {}) {
  const release = acquireLock(config.lockPath);
  if (!release) return { outcome: 'already-running', notified: false };
  const now = dependencies.now ?? new Date();
  const dateKey = moscowParts(now).dateKey;
  const notify = dependencies.notify ?? ((details) => sendTelegram({ ...details, fetchImpl: dependencies.fetchImpl ?? fetch }));
  const readAccount = dependencies.readAccount ?? readRussianPostAccount;
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  try {
    let previous;
    try {
      previous = readRussianPostState(config.statePath);
    } catch (error) {
      await notify({ token: config.token, chatId: config.chatId, text: formatRussianPostFailure('read') });
      throw error;
    }
    if (previous.lastSuccessfulDate === dateKey) return { outcome: 'already-processed', notified: false };
    let snapshot;
    try {
      snapshot = await retryRead(readAccount, config, delay, dependencies.attempts ?? 3);
    } catch (error) {
      const kind = error instanceof RussianPostAuthError ? 'auth' : 'read';
      if (previous.lastFailureNoticeDate !== dateKey) {
        await notify({ token: config.token, chatId: config.chatId, text: formatRussianPostFailure(kind) });
        writeRussianPostState(config.statePath, { ...previous, lastFailureNoticeDate: dateKey });
      }
      throw error;
    }
    const result = processRussianPostSnapshot({ previous, snapshot, now, dateKey });
    const deliveries = [];
    if (result.shouldNotify) {
      for (const text of splitTelegramMessage(formatRussianPostMessage(result, dateKey))) {
        deliveries.push(await notify({ token: config.token, chatId: config.chatId, text }));
      }
    }
    writeRussianPostState(config.statePath, result.state);
    return {
      outcome: result.outcome,
      notified: result.shouldNotify,
      incoming: result.newIncoming.length,
      delivered: result.deliveredOutgoing.length,
      messageId: deliveries[0]?.messageId ?? null,
      sentAt: deliveries[0]?.sentAt ?? null
    };
  } finally {
    release();
  }
}

export { acquireLock, retryRead };
