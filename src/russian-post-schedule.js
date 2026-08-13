const TIME_ZONE = 'Europe/Moscow';

export function moscowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

export function isRussianPostRunWindow(date = new Date(), recoveryEndHour = 16) {
  const local = moscowParts(date);
  return local.hour >= 14 && local.hour < recoveryEndHour;
}

export { TIME_ZONE as RUSSIAN_POST_TIME_ZONE };
