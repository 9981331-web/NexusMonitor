import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyRussianPostState,
  formatRussianPostMessage,
  isTerminalDelivery,
  processRussianPostSnapshot,
  splitTelegramMessage
} from '../src/russian-post-domain.js';
import { runRussianPostMonitor } from '../src/russian-post-monitor.js';
import { readRussianPostState, writeRussianPostState } from '../src/russian-post-state.js';
import { isRussianPostRunWindow, moscowParts } from '../src/russian-post-schedule.js';
import { extractTrackingPayloadSnapshot, RussianPostAuthError, RussianPostParseError } from '../src/russian-post-browser.js';
import { loadRussianPostConfig } from '../src/russian-post-config.js';

const day1 = new Date('2026-08-13T11:00:00.000Z');
const day2 = new Date('2026-08-14T11:00:00.000Z');

function incoming(trackingId, overrides = {}) {
  return { trackingId, direction: 'incoming', type: 'Заказное письмо', status: 'Прибыло', ...overrides };
}

function outgoing(trackingId, status, overrides = {}) {
  return { trackingId, direction: 'outgoing', type: 'Письмо', status, ...overrides };
}

function process(previous, snapshot, now = day2) {
  return processRussianPostSnapshot({ previous, snapshot, now, dateKey: moscowParts(now).dateKey });
}

function baseline(snapshot) {
  return process(emptyRussianPostState(), snapshot, day1).state;
}

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'russian-post-monitor-'));
  return {
    root,
    token: 'test-token', chatId: 'test-chat',
    statePath: path.join(root, 'state.json'),
    lockPath: path.join(root, 'run.lock')
  };
}

test('new incoming registered shipment is detected once', () => {
  const previous = baseline({ incoming: [], outgoing: [] });
  const first = process(previous, { incoming: [incoming('12345678901234')], outgoing: [] });
  assert.deepEqual(first.newIncoming.map((item) => item.trackingId), ['12345678901234']);
  const nextDay = new Date('2026-08-15T11:00:00.000Z');
  const second = processRussianPostSnapshot({ previous: first.state, snapshot: { incoming: [incoming('12345678901234')], outgoing: [] }, now: nextDay, dateKey: moscowParts(nextDay).dateKey });
  assert.equal(second.newIncoming.length, 0);
});

test('multiple new incoming shipments stay in one summary', () => {
  const result = process(baseline({ incoming: [], outgoing: [] }), {
    incoming: [incoming('12345678901234'), incoming('AB123456789RU')], outgoing: []
  });
  const message = formatRussianPostMessage(result, '2026-08-14');
  assert.match(message, /Новая корреспонденция: 2/u);
  assert.equal(splitTelegramMessage(message).length, 1);
});

test('first successful account read creates a quiet baseline for old shipments', () => {
  const result = process(emptyRussianPostState(), {
    incoming: [incoming('12345678901234')],
    outgoing: [outgoing('AB123456789RU', 'Вручено адресату', { deliveredAt: '13.08.2026 10:00' })]
  }, day1);
  assert.equal(result.outcome, 'baseline-created');
  assert.equal(result.newIncoming.length, 0);
  assert.equal(result.deliveredOutgoing.length, 0);
  assert.match(formatRussianPostMessage(result, '2026-08-13'), /Исходное состояние сохранено/u);
});

test('intermediate outgoing statuses are not terminal delivery', () => {
  for (const status of ['Принято', 'Покинуло отделение', 'Сортировка', 'Ожидает адресата', 'Передано курьеру']) {
    assert.equal(isTerminalDelivery(outgoing('12345678901234', status)), false, status);
  }
});

test('arrival at delivery office is not terminal delivery', () => {
  assert.equal(isTerminalDelivery(outgoing('12345678901234', 'Прибыло в место вручения')), false);
});

test('structured or explicit terminal delivery produces one occurrence', () => {
  const previous = baseline({ incoming: [], outgoing: [outgoing('12345678901234', 'В пути')] });
  const delivered = outgoing('12345678901234', 'Вручено адресату', { eventCode: 'DELIVERED_TO_ADDRESSEE', deliveredAt: '14.08.2026 11:42' });
  const first = process(previous, { incoming: [], outgoing: [delivered] });
  assert.equal(first.deliveredOutgoing.length, 1);
  const nextDay = new Date('2026-08-15T11:00:00.000Z');
  const second = processRussianPostSnapshot({ previous: first.state, snapshot: { incoming: [], outgoing: [delivered] }, now: nextDay, dateKey: moscowParts(nextDay).dateKey });
  assert.equal(second.deliveredOutgoing.length, 0);
});

test('official operation 2 addressee attributes are terminal but sender return is not', () => {
  assert.equal(isTerminalDelivery(outgoing('12345678901234', '', { eventCode: 'OP_2_1' })), true);
  assert.equal(isTerminalDelivery(outgoing('12345678901234', '', { eventCode: 'OP_2_25' })), true);
  assert.equal(isTerminalDelivery(outgoing('12345678901234', '', { eventCode: 'OP_2_7' })), false);
  assert.equal(isTerminalDelivery(outgoing('12345678901234', '', { eventCode: 'OP_2_0' })), false);
});

test('tracking payload classifies direction using the unique shared account party', () => {
  const payload = {
    trackingsDto: {
      trackings: [
        { trackingItem: { barcode: '12345678901234', sender: 'Account Owner', recipient: 'Recipient A', mailTypeText: 'Письмо', commonStatus: 'Вручено', lastOperationType: 2, lastOperationAttr: 1, lastOperationDate: 1_786_600_000_000 } },
        { trackingItem: { barcode: 'AB123456789RU', sender: 'Sender B', recipient: 'Account Owner', mailTypeText: 'Посылка', commonStatus: 'Прибыло', lastOperationType: 8, lastOperationAttr: 2, lastOperationDate: 1_786_500_000_000 } }
      ]
    }
  };
  const snapshot = extractTrackingPayloadSnapshot(payload);
  assert.deepEqual(snapshot.outgoing.map((item) => item.trackingId), ['12345678901234']);
  assert.deepEqual(snapshot.incoming.map((item) => item.trackingId), ['AB123456789RU']);
  assert.equal(snapshot.outgoing[0].eventCode, 'OP_2_1');
  assert.equal(snapshot.outgoing[0].sender, '');
});

test('tracking payload fails closed when account owner cannot be identified', () => {
  assert.throws(() => extractTrackingPayloadSnapshot({
    trackingsDto: { trackings: [{ trackingItem: { barcode: '12345678901234', sender: 'A', recipient: 'B' } }] }
  }), RussianPostParseError);
});

test('same successful daily occurrence is not repeated after restart', () => {
  const first = process(baseline({ incoming: [], outgoing: [] }), { incoming: [], outgoing: [] });
  const repeated = process(first.state, { incoming: [incoming('12345678901234')], outgoing: [] });
  assert.equal(repeated.outcome, 'already-processed');
  assert.equal(repeated.shouldNotify, false);
});

test('Moscow date and bounded recovery window are deterministic', () => {
  assert.equal(moscowParts(new Date('2026-08-13T21:30:00.000Z')).dateKey, '2026-08-14');
  assert.equal(isRussianPostRunWindow(new Date('2026-08-13T11:00:00.000Z')), true);
  assert.equal(isRussianPostRunWindow(new Date('2026-08-13T12:59:59.000Z')), true);
  assert.equal(isRussianPostRunWindow(new Date('2026-08-13T13:00:00.000Z')), false);
  assert.equal(isRussianPostRunWindow(new Date('2026-08-13T20:00:00.000Z')), false);
});

test('auth failure sends an explicit failure and never a no-mail summary', async () => {
  const config = tempConfig();
  const messages = [];
  await assert.rejects(() => runRussianPostMonitor(config, {
    now: day1,
    readAccount: async () => { throw new RussianPostAuthError(); },
    notify: async ({ text }) => messages.push(text),
    delay: async () => {}
  }), RussianPostAuthError);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /проверка не выполнена/u);
  assert.doesNotMatch(messages[0], /корреспонденции нет/u);
});

test('parse failure preserves the previous good shipment state', async () => {
  const config = tempConfig();
  const previous = baseline({ incoming: [incoming('12345678901234')], outgoing: [] });
  writeRussianPostState(config.statePath, previous);
  await assert.rejects(() => runRussianPostMonitor(config, {
    now: day2,
    readAccount: async () => { throw new RussianPostParseError(); },
    notify: async () => {},
    delay: async () => {}, attempts: 1
  }), RussianPostParseError);
  const after = readRussianPostState(config.statePath);
  assert.ok(after.incoming['12345678901234']);
  assert.equal(after.lastSuccessfulDate, previous.lastSuccessfulDate);
});

test('temporary network retries produce one summary and no duplicate', async () => {
  const config = tempConfig();
  let reads = 0;
  const messages = [];
  const dependencies = {
    now: day1,
    readAccount: async () => {
      reads += 1;
      if (reads < 3) throw new Error('temporary network failure');
      return { incoming: [], outgoing: [] };
    },
    notify: async ({ text }) => messages.push(text),
    delay: async () => {}
  };
  const first = await runRussianPostMonitor(config, dependencies);
  const second = await runRussianPostMonitor(config, { ...dependencies, readAccount: async () => { throw new Error('must not read again'); } });
  assert.equal(reads, 3);
  assert.equal(messages.length, 1);
  assert.equal(first.outcome, 'baseline-created');
  assert.equal(second.outcome, 'already-processed');
});

test('daily run with unchanged baseline sends one explicit no-new summary then dedupes restart', async () => {
  const config = tempConfig();
  const previous = baseline({ incoming: [incoming('12345678901234')], outgoing: [outgoing('AB123456789RU', 'В пути')] });
  writeRussianPostState(config.statePath, previous);
  const messages = [];
  const dependencies = {
    now: day2,
    readAccount: async () => ({ incoming: [incoming('12345678901234')], outgoing: [outgoing('AB123456789RU', 'В пути')] }),
    notify: async ({ text }) => { messages.push(text); return { messageId: 42, sentAt: day2.toISOString() }; },
    delay: async () => {}
  };
  const first = await runRussianPostMonitor(config, dependencies);
  const second = await runRussianPostMonitor(config, dependencies);
  assert.equal(first.outcome, 'daily-summary');
  assert.equal(first.messageId, 42);
  assert.match(messages[0], /Новой зарегистрированной корреспонденции нет/u);
  assert.match(messages[0], /Новых доставленных отправлений нет/u);
  assert.equal(second.outcome, 'already-processed');
  assert.equal(messages.length, 1);
});

test('Telegram failure does not advance state or emit a false read-error message', async () => {
  const config = tempConfig();
  const previous = baseline({ incoming: [], outgoing: [] });
  writeRussianPostState(config.statePath, previous);
  let notificationAttempts = 0;
  await assert.rejects(() => runRussianPostMonitor(config, {
    now: day2,
    readAccount: async () => ({ incoming: [], outgoing: [] }),
    notify: async () => { notificationAttempts += 1; throw new Error('Telegram unavailable'); },
    delay: async () => {}
  }), /Telegram unavailable/u);
  assert.equal(notificationAttempts, 1);
  assert.equal(readRussianPostState(config.statePath).lastSuccessfulDate, previous.lastSuccessfulDate);
});

test('DPAPI-backed config loads secrets through the protected secret reader', () => {
  const requested = [];
  const config = loadRussianPostConfig({
    processEnv: { LOCALAPPDATA: 'C:\\Local' },
    secretReader: (secretPath) => { requested.push(path.basename(secretPath)); return secretPath.includes('token') ? 'token-value' : 'chat-value'; }
  });
  assert.equal(config.token, 'token-value');
  assert.equal(config.chatId, 'chat-value');
  assert.deepEqual(requested.sort(), ['telegram-chat-id.dpapi', 'telegram-token.dpapi']);
});

test('atomic state write leaves no temporary file', () => {
  const config = tempConfig();
  writeRussianPostState(config.statePath, emptyRussianPostState());
  assert.equal(readRussianPostState(config.statePath).version, 1);
  assert.deepEqual(fs.readdirSync(config.root).filter((name) => name.endsWith('.tmp')), []);
});

test('formatter handles zero, one, and many events without technical JSON', () => {
  const previous = baseline({ incoming: [], outgoing: [outgoing('12345678901234', 'В пути')] });
  const zero = process(previous, { incoming: [], outgoing: [] });
  assert.match(formatRussianPostMessage(zero, '2026-08-14'), /Новой зарегистрированной корреспонденции нет/u);
  const one = process(previous, { incoming: [incoming('AB123456789RU')], outgoing: [] });
  assert.match(formatRussianPostMessage(one, '2026-08-14'), /Новая корреспонденция: 1/u);
  const many = process(previous, {
    incoming: [incoming('AB123456789RU'), incoming('CD123456789RU')],
    outgoing: [outgoing('12345678901234', 'Получено адресатом', { deliveredAt: '14.08.2026 11:42' })]
  });
  const message = formatRussianPostMessage(many, '2026-08-14');
  assert.match(message, /Новая корреспонденция: 2/u);
  assert.match(message, /Отправление доставлено/u);
  assert.doesNotMatch(message, /eventCode|direction|\{"/u);
});

test('long summaries are split within Telegram limit', () => {
  const parts = splitTelegramMessage(Array.from({ length: 400 }, (_, index) => `Строка ${index}: ${'x'.repeat(20)}`).join('\n'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 4000));
});
