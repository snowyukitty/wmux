export class JsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonEditError';
  }
}

export interface JsonEdit {
  path: (string | number)[];
  op: 'set' | 'delete';
  value?: unknown;
}

function detectJsonIndent(lines: string[]): string | number {
  for (const line of lines) {
    const match = line.match(/^([ \t]+)\S/);
    if (match) {
      const ws = match[1];
      if (ws.startsWith('\t')) return '\t';
      if (ws.startsWith('    ')) return 4;
      if (ws.startsWith('  ')) return 2;
    }
  }
  return 2;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
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

export function editJsonKeys(text: string, edits: JsonEdit[]): string {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new JsonEditError(`Invalid JSON: ${(err as Error).message}`);
  }

  if (edits.length === 0) {
    return text;
  }

  const originalCopy = JSON.parse(JSON.stringify(root));
  let modifiedRoot: unknown = root;

  for (const edit of edits) {
    if (edit.path.length === 0) {
      if (edit.op === 'set') {
        modifiedRoot = edit.value;
      } else if (edit.op === 'delete') {
        modifiedRoot = {};
      }
      continue;
    }

    let current: any = modifiedRoot;
    let valid = true;

    for (let i = 0; i < edit.path.length - 1; i++) {
      const seg = edit.path[i];
      const nextSeg = edit.path[i + 1];

      if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
        valid = false;
        break;
      }

      if (edit.op === 'set') {
        if (current[seg] === undefined || current[seg] === null || typeof current[seg] !== 'object') {
          current[seg] = typeof nextSeg === 'number' ? [] : {};
        }
        current = current[seg];
      } else {
        if (current === null || typeof current !== 'object' || !(seg in current)) {
          valid = false;
          break;
        }
        current = current[seg];
      }
    }

    if (!valid || current === null || typeof current !== 'object') {
      continue;
    }

    const lastSeg = edit.path[edit.path.length - 1];
    if (lastSeg === '__proto__' || lastSeg === 'constructor' || lastSeg === 'prototype') {
      continue;
    }

    if (edit.op === 'set') {
      current[lastSeg] = edit.value;
    } else if (edit.op === 'delete') {
      if (Array.isArray(current) && typeof lastSeg === 'number') {
        current.splice(lastSeg, 1);
      } else {
        delete current[lastSeg];
      }
    }
  }

  if (deepEqual(originalCopy, modifiedRoot)) {
    return text;
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n') || text.endsWith('\r\n');
  const lines = text.split(/\r?\n/);
  const indent = detectJsonIndent(lines);

  let formatted = JSON.stringify(modifiedRoot, null, indent);
  if (eol === '\r\n') {
    formatted = formatted.replace(/\n/g, '\r\n');
  }
  if (hasTrailingNewline) {
    formatted += eol;
  }

  return formatted;
}
