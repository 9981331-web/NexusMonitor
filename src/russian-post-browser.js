import { chromium } from 'playwright-core';
import { isTrackingId, normalizeTrackingId } from './russian-post-domain.js';

export class RussianPostAuthError extends Error {
  constructor(message = 'Russian Post authorization is required') {
    super(message);
    this.name = 'RussianPostAuthError';
  }
}

export class RussianPostParseError extends Error {
  constructor(message = 'Russian Post account data could not be read reliably') {
    super(message);
    this.name = 'RussianPostParseError';
  }
}

function firstOwn(object, names) {
  if (!object || typeof object !== 'object') return '';
  const entries = Object.entries(object);
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match && ['string', 'number'].includes(typeof match[1])) return String(match[1]);
  }
  return '';
}

function directionOf(object, context = '') {
  const raw = firstOwn(object, ['direction', 'shipmentDirection', 'mailDirection', 'flow', 'role']).toLowerCase();
  if (/^(incoming|inbound|received|recipient|to_me)$/u.test(raw)) return 'incoming';
  if (/^(outgoing|outbound|sent|sender|from_me)$/u.test(raw)) return 'outgoing';
  if (/входящ|получаю|мне/iu.test(raw) || /incoming|inbound/iu.test(context)) return 'incoming';
  if (/исходящ|отправил|мои отправления/iu.test(raw) || /outgoing|outbound/iu.test(context)) return 'outgoing';
  return '';
}

function shipmentFromObject(object, context) {
  const trackingId = normalizeTrackingId(firstOwn(object, [
    'trackingId', 'trackingNumber', 'barcode', 'trackNumber', 'rpoId', 'rpo', 'mailId'
  ]));
  if (!isTrackingId(trackingId)) return null;
  const direction = directionOf(object, context);
  if (!direction) return null;
  const latest = object.latestEvent ?? object.lastEvent ?? object.currentEvent ?? {};
  return {
    trackingId,
    direction,
    type: firstOwn(object, ['mailTypeText', 'shipmentTypeName', 'typeName', 'mailType', 'category', 'name']) || 'Отправление',
    sender: firstOwn(object, ['senderName', 'sender', 'fromName']),
    status: firstOwn(object, ['statusText', 'statusName', 'humanStatus', 'status']) || firstOwn(latest, ['name', 'description', 'statusText']),
    eventCode: firstOwn(object, ['eventCode', 'statusCode', 'operationCode']) || firstOwn(latest, ['code', 'eventCode', 'operationCode']),
    eventType: firstOwn(object, ['eventType', 'operationType']) || firstOwn(latest, ['type', 'eventType', 'operationType']),
    lastEventAt: firstOwn(object, ['lastEventAt', 'eventDate', 'updatedAt', 'operationDate']) || firstOwn(latest, ['date', 'timestamp', 'eventDate']),
    deliveredAt: firstOwn(object, ['deliveredAt', 'deliveryDate']) || firstOwn(latest, ['deliveredAt', 'deliveryDate'])
  };
}

function party(value) {
  return typeof value === 'string'
    ? value.toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    : '';
}

function operationDate(value) {
  if (!Number.isFinite(value)) return '';
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(date);
}

export function extractTrackingPayloadSnapshot(payload) {
  const entries = payload?.trackingsDto?.trackings;
  if (!Array.isArray(entries)) throw new RussianPostParseError('Tracking payload has an unsupported shape');
  const senderCounts = new Map();
  const recipientCounts = new Map();
  for (const entry of entries) {
    const sender = party(entry?.trackingItem?.sender);
    const recipient = party(entry?.trackingItem?.recipient);
    if (sender) senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1);
    if (recipient) recipientCounts.set(recipient, (recipientCounts.get(recipient) ?? 0) + 1);
  }
  const candidates = [...senderCounts.keys()]
    .filter((value) => recipientCounts.has(value))
    .sort((left, right) => ((senderCounts.get(right) + recipientCounts.get(right)) - (senderCounts.get(left) + recipientCounts.get(left))));
  if (!candidates.length) throw new RussianPostParseError('Account owner could not be identified from shipment parties');
  if (candidates.length > 1) {
    const best = senderCounts.get(candidates[0]) + recipientCounts.get(candidates[0]);
    const second = senderCounts.get(candidates[1]) + recipientCounts.get(candidates[1]);
    if (best === second) throw new RussianPostParseError('Account owner identity is ambiguous');
  }
  const owner = candidates[0];
  const incoming = [];
  const outgoing = [];
  for (const entry of entries) {
    const item = entry?.trackingItem ?? {};
    const trackingId = normalizeTrackingId(item.barcode);
    if (!isTrackingId(trackingId)) continue;
    const sender = party(item.sender);
    const recipient = party(item.recipient);
    const direction = sender === owner && recipient !== owner
      ? 'outgoing'
      : recipient === owner && sender !== owner
        ? 'incoming'
        : '';
    if (!direction) continue;
    const operationType = Number.isFinite(item.lastOperationType) ? item.lastOperationType : null;
    const operationAttr = Number.isFinite(item.lastOperationAttr) ? item.lastOperationAttr : null;
    const eventCode = operationType == null || operationAttr == null ? '' : `OP_${operationType}_${operationAttr}`;
    const shipment = {
      trackingId,
      direction,
      type: typeof item.mailTypeText === 'string' && item.mailTypeText.trim() ? item.mailTypeText : 'Отправление',
      sender: direction === 'incoming' && typeof item.sender === 'string' ? item.sender : '',
      status: typeof item.commonStatus === 'string' && item.commonStatus.trim() ? item.commonStatus : (item.globalStatus || ''),
      eventCode,
      eventType: operationType == null ? '' : String(operationType),
      lastEventAt: operationDate(item.lastOperationDate),
      deliveredAt: operationType === 2 ? operationDate(item.lastOperationDate) : ''
    };
    (direction === 'incoming' ? incoming : outgoing).push(shipment);
  }
  return { incoming, outgoing };
}

function walk(value, context, shipments, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 14) return;
  seen.add(value);
  const shipment = shipmentFromObject(value, context);
  if (shipment) shipments.push(shipment);
  for (const [key, child] of Object.entries(value)) {
    walk(child, `${context}/${key}`, shipments, seen, depth + 1);
  }
}

export function extractSnapshotFromStructuredData(values) {
  const trackingPayloads = values
    .filter((item) => item.context === '/api/tracking/api/v1/trackings/by-barcodes')
    .map((item) => item.value);
  if (trackingPayloads.length) {
    const snapshots = trackingPayloads.map(extractTrackingPayloadSnapshot);
    const incoming = snapshots.flatMap((item) => item.incoming);
    const outgoing = snapshots.flatMap((item) => item.outgoing);
    return {
      incoming: [...new Map(incoming.map((item) => [item.trackingId, item])).values()],
      outgoing: [...new Map(outgoing.map((item) => [item.trackingId, item])).values()]
    };
  }
  const found = [];
  for (const item of values) walk(item.value, item.context || '', found);
  const unique = new Map();
  for (const item of found) unique.set(`${item.direction}:${item.trackingId}`, { ...unique.get(`${item.direction}:${item.trackingId}`), ...item });
  const shipments = [...unique.values()];
  return {
    incoming: shipments.filter((item) => item.direction === 'incoming'),
    outgoing: shipments.filter((item) => item.direction === 'outgoing')
  };
}

function likelyAuthPage(url, text) {
  return /login|auth|id\.pochta/iu.test(url) || /войти|авторизац|номер телефона/iu.test(text.slice(0, 3000));
}

async function collectStructuredResponses(page) {
  const values = [];
  const pending = new Set();
  const listener = (response) => {
    const task = (async () => {
      const type = response.headers()['content-type'] || '';
      if (!response.ok() || !/json/iu.test(type) || !/(^|\.)pochta\.ru(?::\d+)?$/iu.test(new URL(response.url()).hostname)) return;
      const length = Number(response.headers()['content-length'] || 0);
      if (length > 5_000_000) return;
      try {
        values.push({ context: new URL(response.url()).pathname, value: await response.json() });
      } catch {}
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on('response', listener);
  return {
    values,
    async finish() {
      await Promise.allSettled([...pending]);
      page.off('response', listener);
    }
  };
}

async function openPersistent(config, headless) {
  return chromium.launchPersistentContext(config.profilePath, {
    channel: config.chromeChannel,
    headless,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false
  });
}

export async function openRussianPostLogin(config) {
  const context = await openPersistent(config, false);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.accountUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await context.close().catch(() => {});
}

export async function readRussianPostAccount(config, options = {}) {
  const context = await openPersistent(config, options.headless ?? config.headless);
  try {
    const page = await context.newPage();
    const collector = await collectStructuredResponses(page);
    await page.goto(config.accountUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await collector.finish();
    const text = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
    if (likelyAuthPage(page.url(), text)) throw new RussianPostAuthError();
    const scriptValues = await page.locator('script[type="application/json"]').evaluateAll((scripts) => scripts.flatMap((script) => {
      try { return [{ context: 'dom-script', value: JSON.parse(script.textContent || '') }]; } catch { return []; }
    }));
    const values = [...collector.values, ...scriptValues];
    const snapshot = extractSnapshotFromStructuredData(values);
    if (!values.length || (!snapshot.incoming.length && !snapshot.outgoing.length && !/отправлен|трек|почтов/iu.test(text))) {
      throw new RussianPostParseError();
    }
    if (options.probe) {
      return {
        snapshot,
        probe: {
          pageUrl: new URL(page.url()).origin + new URL(page.url()).pathname,
          responsePaths: [...new Set(values.map((item) => item.context))].sort(),
          structuredPayloadCount: values.length,
          incomingCount: snapshot.incoming.length,
          outgoingCount: snapshot.outgoing.length
        }
      };
    }
    return snapshot;
  } finally {
    await context.close().catch(() => {});
  }
}
