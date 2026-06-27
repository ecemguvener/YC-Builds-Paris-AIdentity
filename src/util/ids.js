import { randomBytes } from 'node:crypto';

/** Short, prefixed, URL-safe id, e.g. payid_8f3a1c2b. */
export function id(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
