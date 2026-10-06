import { parse as parseTomlText } from 'smol-toml';

export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TomlEditError';
  }
}

export interface TomlTableEdit {
  table?: string[];
  key: string;
  op: 'set' | 'delete';
  value?: string | number | boolean | string[];
}

export interface TomlArrayTableEdit {
  arrayTable: string[];
  match: Record<string, string>;
  key: string;
  op: 'set' | 'delete';
  value?: string | number | boolean | string[];
}

export type TomlEdit = TomlTableEdit | TomlArrayTableEdit;

function isArrayTableEdit(edit: TomlEdit): edit is TomlArrayTableEdit {
  return 'arrayTable' in edit && Array.isArray(edit.arrayTable);
}

function splitTomlKeyPath(path: string): string[] {
  const segs: string[] = [];
  let i = 0;
  while (i < path.length) {
    while (i < path.length && /\s/.test(path[i])) i++;
    if (i >= path.length) break;
    let seg = '';
    const ch = path[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < path.length && path[i] !== quote) {
        if (quote === '"' && path[i] === '\\') {
          seg += path[i + 1] ?? '';
          i += 2;
        } else {
          seg += path[i];
          i++;
        }
      }
      i++;
    } else {
      while (i < path.length && path[i] !== '.' && !/\s/.test(path[i])) seg += path[i++];
      seg = seg.trim();
    }
    segs.push(seg);
    while (i < path.length && /\s/.test(path[i])) i++;
    if (path[i] === '.') i++;
  }
  return segs;
}

function formatHeaderKey(segment: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(segment)) {
    return segment;
  }
  if (segment.includes('\\') && !segment.includes("'")) {
    return `'${segment}'`;
  }
  return JSON.stringify(segment);
}

function formatKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  if (key.includes('\\') && !key.includes("'")) {
    return `'${key}'`;
  }
  return JSON.stringify(key);
}

function formatTomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\\') && !value.includes("'") && !value.includes('\n') && !value.includes('\r')) {
      return `'${value}'`;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(', ')}]`;
  }
  throw new TomlEditError(`Unsupported TOML value type: ${typeof value}`);
}

function parseHeaderLine(line: string): { type: 'table' | 'arrayTable'; segments: string[] } | null {
  const m = line.match(/^\s*(\[\[?)\s*([^\]]*?)\s*(\]\]?)\s*(?:#.*)?$/);
  if (!m) return null;
  if (m[1] === '[' && m[3] === ']') {
    return { type: 'table', segments: splitTomlKeyPath(m[2]) };
  }
  if (m[1] === '[[' && m[3] === ']]') {
    return { type: 'arrayTable', segments: splitTomlKeyPath(m[2]) };
  }
  return null;
}

function parseKeyValueLine(line: string): {
  key: string;
  rawValue: string;
  inlineComment: string;
  indent: string;
} | null {
  const m = line.match(/^(\s*)([A-Za-z0-9_.-]+|"[^"]*"|'[^']*')\s*=\s*(.*)$/);
  if (!m) return null;
  const indent = m[1];
  const rawKey = m[2];
  const rest = m[3];
  const key = splitTomlKeyPath(rawKey)[0];

  let inDouble = false;
  let inSingle = false;
  let commentIndex = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"' && !inSingle) {
      if (i === 0 || rest[i - 1] !== '\\') inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '#' && !inDouble && !inSingle) {
      commentIndex = i;
      break;
    }
  }

  let rawValue = rest.trimEnd();
  let inlineComment = '';
  if (commentIndex !== -1) {
    rawValue = rest.slice(0, commentIndex).trimEnd();
    inlineComment = rest.slice(commentIndex);
  }
  return { key, rawValue, inlineComment, indent };
}

/**
 * Number of lines the value starting on `lines[keyLineIdx]` spans. A multi-line array or inline table
 * (`disabled_tools = [
  "a",
]`) continues until its brackets balance; strings and comments are skipped.
 */
function valueLineSpan(lines: string[], keyLineIdx: number): number {
  const first = lines[keyLineIdx];
  let i = first.indexOf('=') + 1;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let row = keyLineIdx; row < lines.length; row++) {
    const line = lines[row];
    for (; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (quote === '"' && ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#') {
        break;
      } else if (ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ']' || ch === '}') {
        depth--;
      }
    }
    if (depth <= 0) return row - keyLineIdx + 1;
    quote = null;
    i = 0;
  }
  return 1;
}

function parseTomlScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function segmentsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

function cloneDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map(cloneDeep) as unknown as T;
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    res[k] = cloneDeep(v);
  }
  return res as T;
}

function applyEditToExpected(expected: Record<string, unknown>, edit: TomlEdit): void {
  if (isArrayTableEdit(edit)) {
    let cur: any = expected;
    for (let i = 0; i < edit.arrayTable.length; i++) {
      const seg = edit.arrayTable[i];
      if (i === edit.arrayTable.length - 1) {
        if (!Array.isArray(cur[seg])) {
          if (edit.op === 'set') {
            cur[seg] = [];
          } else {
            return;
          }
        }
        cur = cur[seg];
      } else {
        if (cur[seg] === undefined || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) {
          if (edit.op === 'set') {
            cur[seg] = {};
          } else {
            return;
          }
        }
        cur = cur[seg];
      }
    }
    const arr = cur as Record<string, unknown>[];
    const matchEntry = arr.find((item) =>
      Object.entries(edit.match).every(([k, v]) => String(item[k]) === String(v)),
    );
    if (matchEntry) {
      if (edit.op === 'set') {
        matchEntry[edit.key] = edit.value;
      } else {
        delete matchEntry[edit.key];
      }
    } else if (edit.op === 'set') {
      const newEntry: Record<string, unknown> = { ...edit.match };
      newEntry[edit.key] = edit.value;
      arr.push(newEntry);
    }
  } else {
    const tablePath = edit.table ?? [];
    let cur: any = expected;
    for (const seg of tablePath) {
      if (cur[seg] === undefined || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) {
        if (edit.op === 'set') {
          cur[seg] = {};
        } else {
          return;
        }
      }
      cur = cur[seg];
    }
    if (edit.op === 'set') {
      cur[edit.key] = edit.value;
    } else {
      delete cur[edit.key];
    }
  }
}

export function editTomlKeys(text: string, edits: TomlEdit[]): string {
  for (const edit of edits) {
    if (edit.key === 'trusted_hash') {
      throw new TomlEditError('Cannot modify protected key: trusted_hash');
    }
  }

  let originalParsed: Record<string, unknown>;
  try {
    originalParsed = (text.trim() ? parseTomlText(text) : {}) as Record<string, unknown>;
  } catch (err) {
    throw new TomlEditError(`Original text is not valid TOML: ${(err as Error).message}`);
  }

  if (edits.length === 0) {
    return text;
  }

  const expected = cloneDeep(originalParsed);
  for (const edit of edits) {
    applyEditToExpected(expected, edit);
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n') || text.endsWith('\r\n') || text.trim() === '';
  let lines = text.length === 0 ? [] : text.split(/\r?\n/);

  for (const edit of edits) {
    if (isArrayTableEdit(edit)) {
      lines = applyArrayTableEdit(lines, edit);
    } else {
      lines = applyTableEdit(lines, edit);
    }
  }

  let newText = lines.join(eol);
  if (hasTrailingNewline && newText.length > 0 && !newText.endsWith(eol)) {
    newText += eol;
  }

  let newParsed: Record<string, unknown>;
  try {
    newParsed = (newText.trim() ? parseTomlText(newText) : {}) as Record<string, unknown>;
  } catch (err) {
    throw new TomlEditError(`Edited text is not valid TOML: ${(err as Error).message}`);
  }

  if (!deepEqual(newParsed, expected)) {
    throw new TomlEditError('Verification failed: edited TOML does not match expected state');
  }

  return newText;
}

function applyTableEdit(lines: string[], edit: TomlTableEdit): string[] {
  const table = edit.table ?? [];
  const isRoot = table.length === 0;

  let start = -1;
  let end = lines.length;

  if (isRoot) {
    start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (parseHeaderLine(lines[i])) {
        end = i;
        break;
      }
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const h = parseHeaderLine(lines[i]);
      if (h && h.type === 'table' && segmentsMatch(h.segments, table)) {
        start = i + 1;
        break;
      }
    }
    if (start !== -1) {
      for (let i = start; i < lines.length; i++) {
        if (parseHeaderLine(lines[i])) {
          end = i;
          break;
        }
      }
    }
  }

  if (start === -1) {
    if (edit.op === 'delete') {
      return lines;
    }
    const headerStr = '[' + table.map(formatHeaderKey).join('.') + ']';
    const kvLine = `${formatKey(edit.key)} = ${formatTomlValue(edit.value!)}`;
    const trimmed = [...lines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') {
      trimmed.pop();
    }
    if (trimmed.length > 0) {
      return [...trimmed, '', headerStr, kvLine];
    }
    return [headerStr, kvLine];
  }

  let keyLineIdx = -1;
  for (let i = start; i < end; i++) {
    const kv = parseKeyValueLine(lines[i]);
    if (kv && kv.key === edit.key) {
      keyLineIdx = i;
      break;
    }
  }

  if (keyLineIdx !== -1) {
    const span = valueLineSpan(lines, keyLineIdx);
    if (edit.op === 'delete') {
      const nextLines = [...lines];
      nextLines.splice(keyLineIdx, span);
      return nextLines;
    }
    const existing = parseKeyValueLine(lines[keyLineIdx])!;
    const commentPart = existing.inlineComment && span === 1 ? ` ${existing.inlineComment.trim()}` : '';
    const newLine = `${existing.indent}${formatKey(edit.key)} = ${formatTomlValue(edit.value!)}${commentPart}`;
    const nextLines = [...lines];
    nextLines.splice(keyLineIdx, span, newLine);
    return nextLines;
  }

  if (edit.op === 'delete') {
    return lines;
  }

  let insertIdx = end;
  while (insertIdx > start && lines[insertIdx - 1].trim() === '') {
    insertIdx--;
  }

  let indent = '';
  for (let i = start; i < end; i++) {
    const kv = parseKeyValueLine(lines[i]);
    if (kv) {
      indent = kv.indent;
      break;
    }
  }

  const newLine = `${indent}${formatKey(edit.key)} = ${formatTomlValue(edit.value!)}`;
  const nextLines = [...lines];
  nextLines.splice(insertIdx, 0, newLine);
  return nextLines;
}

function applyArrayTableEdit(lines: string[], edit: TomlArrayTableEdit): string[] {
  const entries: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeaderLine(lines[i]);
    if (h && h.type === 'arrayTable' && segmentsMatch(h.segments, edit.arrayTable)) {
      const entryStart = i + 1;
      let entryEnd = lines.length;
      for (let j = entryStart; j < lines.length; j++) {
        if (parseHeaderLine(lines[j])) {
          entryEnd = j;
          break;
        }
      }
      entries.push({ start: entryStart, end: entryEnd });
    }
  }

  let matchingEntry: { start: number; end: number } | null = null;
  for (const entry of entries) {
    const kvMap = new Map<string, unknown>();
    for (let i = entry.start; i < entry.end; i++) {
      const kv = parseKeyValueLine(lines[i]);
      if (kv) {
        kvMap.set(kv.key, parseTomlScalar(kv.rawValue));
      }
    }
    const matchesAll = Object.entries(edit.match).every(
      ([k, v]) => String(kvMap.get(k)) === String(v),
    );
    if (matchesAll) {
      matchingEntry = entry;
      break;
    }
  }

  if (matchingEntry) {
    let keyLineIdx = -1;
    for (let i = matchingEntry.start; i < matchingEntry.end; i++) {
      const kv = parseKeyValueLine(lines[i]);
      if (kv && kv.key === edit.key) {
        keyLineIdx = i;
        break;
      }
    }

    if (keyLineIdx !== -1) {
      const span = valueLineSpan(lines, keyLineIdx);
      if (edit.op === 'delete') {
        const nextLines = [...lines];
        nextLines.splice(keyLineIdx, span);
        return nextLines;
      }
      const existing = parseKeyValueLine(lines[keyLineIdx])!;
      const commentPart = existing.inlineComment && span === 1 ? ` ${existing.inlineComment.trim()}` : '';
      const newLine = `${existing.indent}${formatKey(edit.key)} = ${formatTomlValue(edit.value!)}${commentPart}`;
      const nextLines = [...lines];
      nextLines.splice(keyLineIdx, span, newLine);
      return nextLines;
    }

    if (edit.op === 'delete') {
      return lines;
    }

    let insertIdx = matchingEntry.end;
    while (insertIdx > matchingEntry.start && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }

    let indent = '';
    for (let i = matchingEntry.start; i < matchingEntry.end; i++) {
      const kv = parseKeyValueLine(lines[i]);
      if (kv) {
        indent = kv.indent;
        break;
      }
    }

    const newLine = `${indent}${formatKey(edit.key)} = ${formatTomlValue(edit.value!)}`;
    const nextLines = [...lines];
    nextLines.splice(insertIdx, 0, newLine);
    return nextLines;
  }

  if (edit.op === 'delete') {
    return lines;
  }

  const header = '[[' + edit.arrayTable.map(formatHeaderKey).join('.') + ']]';
  const entryLines: string[] = [header];
  for (const [mKey, mVal] of Object.entries(edit.match)) {
    if (mKey === edit.key) continue;
    entryLines.push(`${formatKey(mKey)} = ${formatTomlValue(mVal)}`);
  }
  entryLines.push(`${formatKey(edit.key)} = ${formatTomlValue(edit.value!)}`);

  if (entries.length > 0) {
    const lastEntry = entries[entries.length - 1];
    let insertIdx = lastEntry.end;
    while (insertIdx > lastEntry.start && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
    const nextLines = [...lines];
    nextLines.splice(insertIdx, 0, '', ...entryLines);
    return nextLines;
  }

  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') {
    trimmed.pop();
  }
  if (trimmed.length > 0) {
    return [...trimmed, '', ...entryLines];
  }
  return entryLines;
}
