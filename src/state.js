import fs from 'node:fs';
import path from 'node:path';

export function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (parsed?.version !== 1 || typeof parsed.fingerprint !== 'string') {
    throw new Error('State file has an unsupported or invalid format');
  }
  return parsed;
}

export function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

