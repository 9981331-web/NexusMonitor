import { extractCourtSnapshot } from './extract.js';
import fs from 'node:fs';
import path from 'node:path';
import { readState, writeState } from './state.js';
import { sendTelegram } from './telegram.js';
import { moscowDateKey } from './schedule.js';

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function checkOnce(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const notify = dependencies.notify ?? ((details) => sendTelegram({ ...details, fetchImpl }));
  const now = dependencies.now ?? new Date();
  const slot = dependencies.slot ?? 'manual';
  const today = moscowDateKey(now);
  const response = await fetchImpl(config.caseUrl, {
    headers: { 'user-agent': 'NexusCourtMonitor/1.0 (local change monitor)' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`Court page request failed with HTTP ${response.status}`);
  const html = await response.text();
  const snapshot = extractCourtSnapshot(html, config.caseNumber);
  const previous = readState(config.statePath);
  const caseKey = config.caseNumber || redactUrl(config.caseUrl);

  if (!previous || previous.caseKey !== caseKey) {
    writeState(config.statePath, {
      version: 1,
      caseKey,
      fingerprint: snapshot.fingerprint,
      observedAt: now.toISOString(),
      lastChangeAlertDate: null,
      lastHeartbeatDate: null
    });
    return { outcome: 'baseline-created', notified: false };
  }

  if (previous.fingerprint === snapshot.fingerprint) {
    if (!dependencies.skipHeartbeat && slot === 'evening' && previous.lastChangeAlertDate !== today && previous.lastHeartbeatDate !== today) {
      const heartbeat = [
        'Ежедневная проверка судебного дела: изменений не обнаружено.',
        config.caseNumber ? `Дело: ${config.caseNumber}` : '',
        `Дата проверки: ${today}`
      ].filter(Boolean).join('\n');
      await notify({ token: config.token, chatId: config.chatId, text: heartbeat });
      writeState(config.statePath, { ...previous, lastHeartbeatDate: today });
      return { outcome: 'unchanged-heartbeat', notified: true };
    }
    return { outcome: 'unchanged', notified: false };
  }

  const message = [
    'Изменение в судебном деле обнаружено.',
    config.caseNumber ? `Дело: ${config.caseNumber}` : '',
    `Страница: ${redactUrl(config.caseUrl)}`,
    '',
    snapshot.text.slice(0, 3000)
  ].filter((part) => part !== '').join('\n');
  await notify({ token: config.token, chatId: config.chatId, text: message });
  writeState(config.statePath, {
    version: 1,
    caseKey,
    fingerprint: snapshot.fingerprint,
    observedAt: now.toISOString(),
    lastChangeAlertDate: today,
    lastHeartbeatDate: previous.lastHeartbeatDate ?? null
  });
  return { outcome: 'changed', notified: true };
}

function itemStatePath(basePath, index) {
  const extension = path.extname(basePath) || '.json';
  return path.join(path.dirname(basePath), `${path.basename(basePath, extension)}-${index + 1}${extension}`);
}

function readDaily(pathname) {
  if (!fs.existsSync(pathname)) return {};
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

function writeDaily(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function checkAll(config, dependencies = {}) {
  const cases = config.cases?.length ? config.cases : [{ url: config.caseUrl, caseNumber: config.caseNumber }];
  const slot = dependencies.slot ?? 'manual';
  const now = dependencies.now ?? new Date();
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    results.push(await checkOnce({
      ...config,
      caseUrl: cases[index].url,
      caseNumber: cases[index].caseNumber,
      statePath: cases.length > 1 ? itemStatePath(config.statePath, index) : config.statePath
    }, { ...dependencies, now, slot, skipHeartbeat: cases.length > 1 }));
  }
  if (cases.length > 1 && slot === 'evening' && !results.some((result) => result.outcome === 'changed')) {
    const today = moscowDateKey(now);
    const daily = readDaily(config.aggregateStatePath);
    if (daily.lastHeartbeatDate !== today) {
      const notify = dependencies.notify ?? ((details) => sendTelegram({ ...details, fetchImpl: dependencies.fetchImpl ?? fetch }));
      await notify({ token: config.token, chatId: config.chatId, text: `Ежедневная проверка двух судебных дел: изменений не обнаружено.\nДата проверки: ${today}` });
      writeDaily(config.aggregateStatePath, { lastHeartbeatDate: today });
      return { outcome: 'unchanged-heartbeat', notified: true, results };
    }
  }
  return { outcome: results.some((result) => result.outcome === 'changed') ? 'changed' : 'unchanged', notified: results.some((result) => result.notified), results };
}
