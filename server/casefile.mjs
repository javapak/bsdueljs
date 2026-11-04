// Source treats file names as case-insensitive, and the game's scripts and models rely on that: they often spell a path differently from the
// file on disk. Windows doesn't care, but Linux does, so a server there finds files the way the game does.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const listings = new Map();
/**
 * @param {string} dir A folder.
 * @returns {Map<string, string>|null} Its entries, lower case to their real names; null if it can't be read. Kept, so restart after a game update.
 */
function listing(dir) {
  let m = listings.get(dir);
  if (m !== undefined) return m;
  try { m = new Map(readdirSync(dir).map((n) => [n.toLowerCase(), n])); } catch { m = null; }
  listings.set(dir, m);
  return m;
}
/**
 * Follows a path one part at a time, whatever its case.
 * @param {string} root The folder it's under.
 * @param {string} rel A path with forward slashes, already checked to stay under root.
 * @returns {string|null} The real path, spelled as it is on disk, or null if there's none.
 */
export function resolveCase(root, rel) {
  let at = root;
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    const real = listing(at)?.get(part.toLowerCase());
    if (real === undefined) return null;
    at = join(at, real);
  }
  return at;
}
