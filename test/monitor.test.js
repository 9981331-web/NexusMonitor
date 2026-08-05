import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configurationIssues, loadConfig } from '../src/config.js';
import { extractCourtSnapshot } from '../src/extract.js';
import { checkOnce } from '../src/monitor.js';
import { nextScheduledCheck } from '../src/schedule.js';

function response(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => new TextEncoder().encode(html).buffer };
}

test('missing configuration refuses monitoring', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'court-config-'));
  const config = loadConfig({ processEnv: {}, envPath: path.join(temp, '.env') });
  assert.deepEqual(configurationIssues(config).slice(0, 3), [
    'COURT_CASE_URL is missing',
    'TELEGRAM_BOT_TOKEN is missing',
    'TELEGRAM_CHAT_ID is missing'
  ]);
});

test('env file inside OneDrive is rejected before reading', () => {
  assert.throws(
    () => loadConfig({ processEnv: {}, envPath: 'C:\\Users\\Person\\OneDrive\\vault\\.env' }),
    /outside OneDrive/u
  );
});

test('local env file loads without exposing values in configuration issues', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'court-env-'));
  const envPath = path.join(temp, '.env');
  fs.writeFileSync(envPath, [
    'TELEGRAM_BOT_TOKEN=test-only-token',
    'TELEGRAM_CHAT_ID=test-only-chat',
    'COURT_CASE_URL=https://court.example/case',
    'COURT_CASE_NUMBER=A-1'
  ].join('\n'));
  const config = loadConfig({ processEnv: {}, envPath });
  assert.deepEqual(configurationIssues(config), []);
  assert.equal(config.timeZone, 'Europe/Moscow');
  assert.equal(config.pollTimes, '12:00,18:00');
});

test('extractor fingerprints the case card but ignores content outside main', () => {
  const first = extractCourtSnapshot('<p>Реклама A</p><main><div>Судебное заседание назначено на 12.08.2026 10:30</div></main>');
  const second = extractCourtSnapshot('<p>Реклама B</p><main><div>Судебное заседание назначено на 12.08.2026 10:30</div></main>');
  assert.equal(first.fingerprint, second.fingerprint);
  const changed = extractCourtSnapshot('<main><div>Судебное заседание назначено на 12.08.2026 10:30</div><div>Судья: Иванов</div></main>');
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test('weekday schedule uses 12:00 and 18:00 Moscow and skips weekends', () => {
  assert.equal(nextScheduledCheck(new Date('2026-08-05T08:00:00Z')).at.toISOString(), '2026-08-05T09:00:00.000Z');
  assert.equal(nextScheduledCheck(new Date('2026-08-05T09:01:00Z')).at.toISOString(), '2026-08-05T15:00:00.000Z');
  assert.equal(nextScheduledCheck(new Date('2026-08-07T15:01:00Z')).at.toISOString(), '2026-08-10T09:00:00.000Z');
});

test('evening sends exactly one heartbeat only if no change alert was sent that day', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'court-heartbeat-'));
  const config = {
    caseUrl: 'https://court.example/case', caseNumber: 'H-1',
    token: 'test-token', chatId: 'test-chat', statePath: path.join(temp, 'state.json')
  };
  let html = '<main><p>Статус: заседание назначено на 06.08.2026</p></main>';
  const notices = [];
  const fetchImpl = async () => response(html);
  const notify = async (notice) => notices.push(notice);
  await checkOnce(config, { fetchImpl, notify, now: new Date('2026-08-05T09:00:00Z'), slot: 'midday' });
  await checkOnce(config, { fetchImpl, notify, now: new Date('2026-08-05T15:00:00Z'), slot: 'evening' });
  await checkOnce(config, { fetchImpl, notify, now: new Date('2026-08-05T15:05:00Z'), slot: 'evening' });
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /изменений не обнаружено/iu);

  html = '<main><p>Статус: заседание перенесено на 07.08.2026</p></main>';
  await checkOnce(config, { fetchImpl, notify, now: new Date('2026-08-06T09:00:00Z'), slot: 'midday' });
  await checkOnce(config, { fetchImpl, notify, now: new Date('2026-08-06T15:00:00Z'), slot: 'evening' });
  assert.equal(notices.length, 2);
  assert.match(notices[1].text, /Изменение/iu);
});

test('first observation creates baseline; only a later change notifies', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'court-monitor-'));
  const config = {
    caseUrl: 'https://court.example/case?secret-query-is-redacted',
    caseNumber: 'A-123', token: 'test-token', chatId: 'test-chat',
    statePath: path.join(temp, 'state.json')
  };
  let html = '<div>Статус дела: заседание назначено на 12.08.2026 10:30</div>';
  const notices = [];
  const dependencies = {
    fetchImpl: async () => response(html),
    notify: async (notice) => notices.push(notice)
  };

  assert.deepEqual(await checkOnce(config, dependencies), { outcome: 'baseline-created', notified: false });
  assert.equal(notices.length, 0);
  assert.deepEqual(await checkOnce(config, dependencies), { outcome: 'unchanged', notified: false });
  assert.equal(notices.length, 0);

  html = '<div>Статус дела: заседание перенесено на 19.08.2026 14:00</div>';
  assert.deepEqual(await checkOnce(config, dependencies), { outcome: 'changed', notified: true });
  assert.equal(notices.length, 1);
  assert.ok(!notices[0].text.includes('secret-query'));
});

test('failed notification does not advance state', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'court-retry-'));
  const config = {
    caseUrl: 'https://court.example/case', caseNumber: 'B-456',
    token: 'test-token', chatId: 'test-chat', statePath: path.join(temp, 'state.json')
  };
  let html = '<p>Статус: заседание назначено на 01.09.2026</p>';
  const fetchImpl = async () => response(html);
  await checkOnce(config, { fetchImpl, notify: async () => {} });
  const before = fs.readFileSync(config.statePath, 'utf8');
  html = '<p>Статус: заседание отложено до 05.09.2026</p>';
  await assert.rejects(
    checkOnce(config, { fetchImpl, notify: async () => { throw new Error('offline'); } }),
    /offline/u
  );
  assert.equal(fs.readFileSync(config.statePath, 'utf8'), before);
});
