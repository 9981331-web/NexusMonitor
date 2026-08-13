const TRACKING_ID = /^(?:\d{14}|[A-Z]{2}\d{9}[A-Z]{2})$/u;

const TERMINAL_CODES = new Set([
  'DELIVERED',
  'DELIVERED_TO_ADDRESSEE',
  'GIVEN_TO_ADDRESSEE',
  'HANDED_TO_RECIPIENT',
  'RECEIVED_BY_ADDRESSEE'
]);

const TERMINAL_TEXT = [
  /^вручено адресату(?:\b|$)/iu,
  /^получено адресатом(?:\b|$)/iu,
  /^доставлено получателю(?:\b|$)/iu,
  /^вручение адресату(?:\b|$)/iu
];

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

export function normalizeTrackingId(value) {
  return clean(value).replace(/[\s-]+/gu, '').toUpperCase();
}

export function isTrackingId(value) {
  return TRACKING_ID.test(normalizeTrackingId(value));
}

export function normalizeShipment(raw, expectedDirection) {
  const trackingId = normalizeTrackingId(raw?.trackingId);
  if (!isTrackingId(trackingId)) throw new Error('Shipment has no valid tracking ID');
  const direction = raw?.direction ?? expectedDirection;
  if (!['incoming', 'outgoing'].includes(direction)) throw new Error('Shipment direction is not reliable');
  if (expectedDirection && direction !== expectedDirection) throw new Error('Shipment direction does not match its section');
  return {
    trackingId,
    direction,
    type: clean(raw.type) || 'Отправление',
    sender: clean(raw.sender),
    status: clean(raw.status),
    eventCode: clean(raw.eventCode).toUpperCase(),
    eventType: clean(raw.eventType).toUpperCase(),
    lastEventAt: clean(raw.lastEventAt),
    deliveredAt: clean(raw.deliveredAt)
  };
}

export function isTerminalDelivery(shipment) {
  const code = clean(shipment?.eventCode || shipment?.eventType).toUpperCase();
  if (TERMINAL_CODES.has(code)) return true;
  const operation = /^(?:OP_)?2[:_](\d+)$/u.exec(code);
  if (operation) {
    return new Set([1, 3, 5, 6, 8, 10, 11, 12, 13, 15, 17, 18, 19, 21, 23, 25, 26, 27]).has(Number(operation[1]));
  }
  const status = clean(shipment?.status);
  return TERMINAL_TEXT.some((pattern) => pattern.test(status));
}

export function deliveryOccurrence(shipment) {
  if (!isTerminalDelivery(shipment)) return '';
  const semantic = clean(shipment.eventCode || shipment.eventType || shipment.status).toUpperCase();
  return `${shipment.trackingId}:${semantic}:${clean(shipment.deliveredAt || shipment.lastEventAt)}`;
}

export function emptyRussianPostState() {
  return {
    version: 1,
    baselineComplete: false,
    lastSuccessfulDate: null,
    lastSuccessfulAt: null,
    lastFailureNoticeDate: null,
    incoming: {},
    outgoing: {}
  };
}

function validatedSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.incoming) || !Array.isArray(snapshot.outgoing)) {
    throw new Error('Russian Post account data is incomplete');
  }
  const incoming = snapshot.incoming.map((item) => normalizeShipment(item, 'incoming'));
  const outgoing = snapshot.outgoing.map((item) => normalizeShipment(item, 'outgoing'));
  const ids = new Set();
  for (const item of [...incoming, ...outgoing]) {
    const key = `${item.direction}:${item.trackingId}`;
    if (ids.has(key)) throw new Error('Russian Post account data contains duplicate shipments');
    ids.add(key);
  }
  return { incoming, outgoing };
}

function mapShipments(items, previous = {}) {
  const next = { ...previous };
  for (const item of items) next[item.trackingId] = { ...(previous[item.trackingId] ?? {}), ...item };
  return next;
}

export function processRussianPostSnapshot({ previous, snapshot, now, dateKey }) {
  const state = previous ?? emptyRussianPostState();
  if (state.version !== 1) throw new Error('Russian Post state has an unsupported version');
  if (state.lastSuccessfulDate === dateKey) {
    return { outcome: 'already-processed', state, newIncoming: [], deliveredOutgoing: [], shouldNotify: false };
  }

  const current = validatedSnapshot(snapshot);
  const next = {
    ...state,
    version: 1,
    baselineComplete: true,
    lastSuccessfulDate: dateKey,
    lastSuccessfulAt: now.toISOString(),
    incoming: mapShipments(current.incoming, state.incoming),
    outgoing: mapShipments(current.outgoing, state.outgoing)
  };

  if (!state.baselineComplete) {
    for (const item of current.outgoing) {
      if (isTerminalDelivery(item)) {
        next.outgoing[item.trackingId] = {
          ...next.outgoing[item.trackingId],
          deliveryNotifiedOccurrence: deliveryOccurrence(item)
        };
      }
    }
    return {
      outcome: 'baseline-created',
      state: next,
      baselineCounts: { incoming: current.incoming.length, outgoing: current.outgoing.length },
      newIncoming: [],
      deliveredOutgoing: [],
      shouldNotify: true
    };
  }

  const newIncoming = current.incoming.filter((item) => !state.incoming[item.trackingId]);
  const deliveredOutgoing = current.outgoing.filter((item) => {
    const occurrence = deliveryOccurrence(item);
    return occurrence && state.outgoing[item.trackingId]?.deliveryNotifiedOccurrence !== occurrence;
  });
  for (const item of deliveredOutgoing) {
    next.outgoing[item.trackingId] = {
      ...next.outgoing[item.trackingId],
      deliveryNotifiedOccurrence: deliveryOccurrence(item)
    };
  }
  return {
    outcome: 'daily-summary',
    state: next,
    newIncoming,
    deliveredOutgoing,
    shouldNotify: true
  };
}

function shipmentLines(item, delivered = false) {
  const lines = [`${item.type}`, `Трек: ${item.trackingId}`];
  if (item.sender && !delivered) lines.push(`Отправитель: ${item.sender}`);
  if (item.status) lines.push(`Статус: ${item.status}`);
  const eventAt = delivered ? (item.deliveredAt || item.lastEventAt) : item.lastEventAt;
  if (eventAt) lines.push(`${delivered ? 'Получено адресатом' : 'Последнее событие'}: ${eventAt}`);
  return lines.join('\n');
}

export function formatRussianPostMessage(result, dateKey) {
  if (result.outcome === 'baseline-created') {
    return [
      '📬 Почта России подключена.',
      'Исходное состояние сохранено.',
      `Найдено активных входящих: ${result.baselineCounts.incoming}.`,
      `Найдено отслеживаемых исходящих: ${result.baselineCounts.outgoing}.`,
      'Следующая штатная проверка — завтра в 14:00.'
    ].join('\n');
  }
  if (result.outcome !== 'daily-summary') return '';
  const lines = [`📬 Почта России — ${dateKey.split('-').reverse().join('.')}`, '', 'Входящие'];
  if (!result.newIncoming.length) {
    lines.push('Новой зарегистрированной корреспонденции нет.');
  } else {
    lines.push(`Новая корреспонденция: ${result.newIncoming.length}`);
    result.newIncoming.forEach((item, index) => lines.push('', `${index + 1}. ${shipmentLines(item)}`));
  }
  lines.push('', 'Мои отправления');
  if (!result.deliveredOutgoing.length) {
    lines.push('Новых доставленных отправлений нет.');
  } else {
    result.deliveredOutgoing.forEach((item, index) => lines.push('', `${index + 1}. ✅ Отправление доставлено`, shipmentLines(item, true)));
  }
  lines.push('', 'Следующая проверка: завтра в 14:00.');
  return lines.join('\n');
}

export function formatRussianPostFailure(kind) {
  const reason = kind === 'auth'
    ? 'Требуется повторный вход в личный кабинет.'
    : 'Обнаружена ошибка чтения личного кабинета.';
  return `⚠️ Почта России: ежедневная проверка не выполнена. ${reason}`;
}

export function splitTelegramMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/u, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
