// Stable, collision-free file ids for multi-store account tokens.
//
// Account names may contain characters that are unsafe in file names (spaces,
// Cyrillic, punctuation). A naive sanitizer maps "Основной" and "Второй" to the
// same "_", so two stores would share one token file. The id therefore includes
// a short hash of the original name, and `used` guarantees uniqueness even if
// two names still produce the same prefix.

import { createHash } from 'node:crypto';

export function accountFileId(name, used = new Set()) {
  const original = String(name ?? '');
  const safe =
    original
      .replace(/[^\w.-]+/g, '_')
      .replace(/^[._-]+/, '')
      .slice(0, 40) || 'account';
  const hash = createHash('sha256').update(original).digest('hex').slice(0, 10);
  let id = `${safe}-${hash}`;
  let n = 2;
  while (used.has(id)) id = `${safe}-${hash}-${n++}`;
  used.add(id);
  return id;
}
