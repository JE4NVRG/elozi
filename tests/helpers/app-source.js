// Explicit excerpts of the panel source for text-coupled tests (FRONTEND-V2 §8.1, seam 4).
//
// A test that needs to execute or inspect a piece of public/app.js asks for it by name:
//   excerpt('api')  // text between /*@anchor:api*/ and /*@end:api*/
// instead of slicing app.js between two literal strings with indexOf. The markers are plain
// block comments on their own lines, so refactors that move code keep the tests working as long
// as the markers travel with the code. When anchored code moves out of app.js into a flat module
// in public/, move its markers along and list that module in ANCHOR_SOURCES.
// tests/app-anchors.test.js owns the list of expected anchors and requires each exactly once.
import { readFileSync } from 'node:fs';

export const ANCHOR_SOURCES = Object.freeze(['app.js']);

const publicDirectory = new URL('../../public/', import.meta.url);
const MARKER = /\/\*@(anchor|end):([a-z0-9][a-z0-9-]*)\*\//g;
const MARKER_LINE = /^[ \t]*\/\*@(?:anchor|end):[a-z0-9][a-z0-9-]*\*\/[ \t]*\r?\n/gm;
const INLINE_MARKER = /\/\*@(?:anchor|end):[a-z0-9][a-z0-9-]*\*\//g;
const sources = new Map();
let index;

/** Raw text of a flat public/ file, cached for the test process. */
export function publicSource(file) {
  if (!sources.has(file)) sources.set(file, readFileSync(new URL(file, publicDirectory), 'utf8'));
  return sources.get(file);
}

/** Every marker found in the listed sources: [{file, kind, name, start, end}] in source order. */
export function anchorMarkers(files = ANCHOR_SOURCES) {
  const markers = [];
  for (const file of files) for (const match of publicSource(file).matchAll(MARKER)) markers.push({ file, kind: match[1], name: match[2], start: match.index, end: match.index + match[0].length });
  return markers;
}

function anchorIndex() {
  if (index) return index;
  const found = new Map();
  for (const marker of anchorMarkers()) {
    const entry = found.get(marker.name) || { anchors: [], ends: [] };
    entry[marker.kind === 'anchor' ? 'anchors' : 'ends'].push(marker);
    found.set(marker.name, entry);
  }
  index = found;
  return index;
}

/**
 * Text between /*@anchor:<name>*\/ and /*@end:<name>*\/, without the line breaks that hold the
 * markers and without nested markers of other anchors, i.e. the original source of that excerpt.
 */
export function excerpt(name) {
  const entry = anchorIndex().get(name);
  if (!entry || entry.anchors.length !== 1 || entry.ends.length !== 1) throw new Error(`Âncora ${name} precisa existir exatamente uma vez em ${ANCHOR_SOURCES.join(', ')} (início ${entry?.anchors.length || 0}, fim ${entry?.ends.length || 0}).`);
  const [begin] = entry.anchors, [end] = entry.ends;
  if (begin.file !== end.file || end.start <= begin.end) throw new Error(`Âncora ${name} precisa abrir antes de fechar no mesmo arquivo.`);
  const text = publicSource(begin.file).slice(begin.end, end.start)
    .replace(/^[ \t]*\r?\n/, '')
    .replace(MARKER_LINE, '')
    .replace(INLINE_MARKER, '')
    .replace(/\r?\n[ \t]*$/, '');
  if (!text.trim()) throw new Error(`Âncora ${name} está vazia.`);
  return text;
}
