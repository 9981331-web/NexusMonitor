import fs from 'node:fs';
import path from 'node:path';
import { emptyRussianPostState } from './russian-post-domain.js';

export function readRussianPostState(statePath) {
  if (!fs.existsSync(statePath)) return emptyRussianPostState();
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (parsed?.version !== 1 || typeof parsed.incoming !== 'object' || typeof parsed.outgoing !== 'object') {
    throw new Error('Russian Post state file has an unsupported or invalid format');
  }
  return parsed;
}

export function writeRussianPostState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, statePath);
}
