import { createHash } from 'node:crypto';

const entityMap = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']
]);

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (full, entity) => {
    if (entity[0] === '#') {
      const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const code = Number.parseInt(digits, radix);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return entityMap.get(entity.toLowerCase()) ?? full;
  });
}

export function htmlToLines(html) {
  const cleaned = html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<!--([\s\S]*?)-->/gu, ' ')
    .replace(/<\s*br\s*\/?\s*>|<\/(?:p|div|li|tr|td|th|section|article|h[1-6])\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return decodeEntities(cleaned)
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

const hearingPattern = /(?:заседан|слушан|рассмотрен|назначен|отложен|перенес|приостанов|возобнов|решени|судебн.*(?:дата|время)|hearing|scheduled|adjourn|postpon|status|decision|proceeding)/iu;
const datePattern = /(?:\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b)/u;

export function extractCourtSnapshot(html, caseNumber = '') {
  // sudrf.ru returns all tabs in one document; tab 2 is the movement table.
  const movementTable = /<table\b[^>]*\bid\s*=\s*(['"])tablcont\1[^>]*>([\s\S]*?)<\/table>/iu.exec(html)?.[0];
  const source = movementTable ?? /<main\b[^>]*>([\s\S]*?)<\/main>/iu.exec(html)?.[1] ?? html;
  const lines = htmlToLines(source);
  const caseNeedle = caseNumber.toLocaleLowerCase('ru-RU');
  const relevant = lines.filter((line) => {
    const lower = line.toLocaleLowerCase('ru-RU');
    return hearingPattern.test(line) || (datePattern.test(line) && (!caseNeedle || lower.includes(caseNeedle)));
  });
  if (!movementTable && !relevant.length) {
    throw new Error('No hearing date or case status information was found on the page');
  }
  // For sudrf.ru, fingerprint only the movement table, not general case data.
  const normalized = [...new Set(lines.map((line) => line.normalize('NFKC')))].join('\n');
  const rows = movementTable
    ? [...movementTable.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
      .map((match) => htmlToLines(match[1]).map((line) => line.normalize('NFKC')).join(' | '))
      .filter((row) => row && !/движение дела|наименование события/iu.test(row))
    : [];
  return {
    text: normalized,
    rows,
    fingerprint: createHash('sha256').update(normalized, 'utf8').digest('hex')
  };
}
