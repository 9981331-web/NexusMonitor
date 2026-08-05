const MOSCOW_UTC_OFFSET_HOURS = 3;
const SLOTS = [
  { hour: 12, minute: 8, kind: 'midday' },
  { hour: 18, minute: 8, kind: 'evening' }
];

export function moscowDateKey(date) {
  const shifted = new Date(date.getTime() + MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function nextScheduledCheck(after = new Date()) {
  const shifted = new Date(after.getTime() + MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const baseYear = shifted.getUTCFullYear();
  const baseMonth = shifted.getUTCMonth();
  const baseDay = shifted.getUTCDate();

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const localDay = new Date(Date.UTC(baseYear, baseMonth, baseDay + dayOffset));
    const weekday = localDay.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const slot of SLOTS) {
      const instant = new Date(Date.UTC(
        localDay.getUTCFullYear(), localDay.getUTCMonth(), localDay.getUTCDate(),
        slot.hour - MOSCOW_UTC_OFFSET_HOURS, slot.minute
      ));
      if (instant.getTime() > after.getTime()) return { at: instant, kind: slot.kind };
    }
  }
  throw new Error('Unable to calculate the next weekday court check');
}
