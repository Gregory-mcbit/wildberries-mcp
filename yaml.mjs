// Zero-dependency YAML parser for the subset used by Wildberries OpenAPI specs.
// Supports: block mappings/sequences, block scalars (| and > with chomping and
// explicit indent), quoted scalars (single/double), flow collections, comments,
// anchors/aliases, multi-line plain scalars.
//
// Deliberately strict: anything it cannot parse throws with a line number, so
// the catalog build fails loudly instead of silently producing a partial catalog.

class YamlError extends Error {
  constructor(message, lineNo) {
    super(lineNo ? `YAML error at line ${lineNo}: ${message}` : `YAML error: ${message}`);
    this.name = 'YamlError';
    this.lineNo = lineNo;
  }
}

const RE_EMPTY = /^\s*$/;
const RE_SEQ = /^-(?:\s+|$)/;
const RE_BLOCK = /^([|>])(?:([+-])(\d+)?|(\d+)([+-])?)?\s*$/;
const RE_INT = /^-?(?:0|[1-9]\d*)$/;
const RE_FLOAT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Splits "key: value" honoring quotes and flow depth. Returns null when the line
// is not a mapping entry.
function splitKeyValue(content) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (quote === "'" && content[i + 1] === "'") { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === '}') { depth--; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(content[i - 1]))) return null; // comment line
    if (ch === ':' && depth === 0) {
      const next = content[i + 1];
      if (next === undefined || /\s/.test(next)) {
        return { key: content.slice(0, i), rest: content.slice(i + 1) };
      }
    }
  }
  return null;
}

function unquoteKey(key) {
  const k = key.trim();
  if (k.length >= 2 && k.startsWith('"') && k.endsWith('"')) return parseDoubleQuoted(k).value;
  if (k.length >= 2 && k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}

function stripInlineComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function parseDoubleQuoted(text) {
  // text starts with '"'; when it is a single-line string we still parse escapes.
  let out = '';
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (i + 1 < text.length) {
        const tail = text.slice(i + 1);
        if (tail.trim() && !tail.trim().startsWith('#')) throw new YamlError('trailing characters after quoted scalar');
      }
      return { value: out, consumed: i + 1 };
    }
    if (ch !== '\\') { out += ch; i++; continue; }
    const esc = text[i + 1];
    i += 2;
    switch (esc) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case '0': out += '\0'; break;
      case 'u': {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError(`bad \\u escape: ${hex}`);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = text.slice(i, i + 8);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new YamlError(`bad \\U escape: ${hex}`);
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 8;
        break;
      }
      default:
        // Real Wildberries specs contain non-YAML escapes inside double quotes
        // (markdown escapes like \_ , \- etc). Keep them verbatim instead of
        // failing: descriptions are display text, not code.
        out += '\\' + esc;
        break;
    }
  }
  throw new YamlError('unterminated double-quoted scalar');
}

function resolveScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (RE_INT.test(s)) return Number(s);
  if (RE_FLOAT.test(s) && /[.eE]/.test(s)) return Number(s);
  return s;
}

class Parser {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
    this.anchors = new Map();
  }

  // Returns line info for a raw line or null when it is blank/comment.
  info(index) {
    const raw = this.lines[index];
    const ind = raw.search(/[^ ]/);
    if (ind === -1) return { blank: true, indent: raw.length };
    if (raw[ind] === '\t') throw new YamlError('tab used for indentation', index + 1);
    const content = raw.slice(ind);
    if (content.startsWith('#')) return { blank: true, indent: ind };
    return { blank: false, indent: ind, content, raw, no: index + 1 };
  }

  skipBlank() {
    while (this.i < this.lines.length) {
      const ln = this.info(this.i);
      if (!ln.blank) return ln;
      this.i++;
    }
    return null;
  }

  // Parses a node whose first content line has at least minIndent spaces.
  parseBlock(minIndent) {
    const ln = this.skipBlank();
    if (!ln) return null;
    if (ln.indent < minIndent) return null;
    if (ln.content === '-' || RE_SEQ.test(ln.content)) return this.parseSequence(ln.indent);
    return this.parseMapping(ln.indent);
  }

  parseMapping(indent) {
    const obj = {};
    for (;;) {
      const ln = this.skipBlank();
      if (!ln) break;
      if (ln.indent !== indent) {
        if (ln.indent > indent) throw new YamlError(`unexpected indentation (expected ${indent})`, ln.no);
        break;
      }
      if (ln.content === '-' || RE_SEQ.test(ln.content)) break;
      const kv = splitKeyValue(ln.content);
      if (!kv) throw new YamlError(`expected "key: value", got: ${ln.content.slice(0, 60)}`, ln.no);
      this.i++;
      const key = unquoteKey(kv.key);
      this.assignEntry(obj, key, kv.rest, indent, ln.no);
    }
    return obj;
  }

  // Parses the first "key: value" pair given as text plus subsequent lines of a
  // mapping that starts at `indent` (used for "- key: value" sequence items).
  parseMappingWithFirst(indent, firstContent, firstLineNo) {
    const obj = {};
    const kv = splitKeyValue(firstContent);
    if (!kv) throw new YamlError(`expected "key: value" in sequence item`, firstLineNo);
    this.assignEntry(obj, unquoteKey(kv.key), kv.rest, indent, firstLineNo);
    for (;;) {
      const ln = this.skipBlank();
      if (!ln) break;
      if (ln.indent !== indent) {
        if (ln.indent > indent) throw new YamlError(`unexpected indentation (expected ${indent})`, ln.no);
        break;
      }
      if (ln.content === '-' || RE_SEQ.test(ln.content)) break;
      const kv2 = splitKeyValue(ln.content);
      if (!kv2) throw new YamlError(`expected "key: value"`, ln.no);
      this.i++;
      this.assignEntry(obj, unquoteKey(kv2.key), kv2.rest, indent, ln.no);
    }
    return obj;
  }

  assignEntry(obj, key, rest, indent, lineNo) {
    const value = this.parseValue(rest, indent, lineNo);
    if (key === '<<') {
      // YAML merge key: object or list of objects
      const sources = Array.isArray(value) ? value : [value];
      for (const src of sources) {
        if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (!(k in obj)) obj[k] = v;
      }
      return;
    }
    obj[key] = value;
  }

  parseSequence(indent) {
    const arr = [];
    for (;;) {
      const ln = this.skipBlank();
      if (!ln) break;
      if (ln.indent !== indent) {
        if (ln.indent > indent) throw new YamlError(`unexpected indentation (expected ${indent})`, ln.no);
        break;
      }
      if (!(ln.content === '-' || RE_SEQ.test(ln.content))) break;
      this.i++;
      const afterDashRaw = ln.content.slice(1);
      const afterDash = afterDashRaw.trimStart();
      const contentIndent = indent + 1 + (afterDashRaw.length - afterDashRaw.replace(/^ +/, '').length);
      if (afterDash === '') {
        const next = this.skipBlank();
        if (next && next.indent > indent) arr.push(this.parseBlock(next.indent));
        else arr.push(null);
        continue;
      }
      if (afterDash === '-' || RE_SEQ.test(afterDash)) {
        arr.push(this.parseSequence(contentIndent));
        continue;
      }
      if (splitKeyValue(afterDash)) {
        // mapping item, e.g. "- name: foo"
        arr.push(this.parseMappingWithFirst(contentIndent, afterDash, ln.no));
        continue;
      }
      arr.push(this.parseValue(afterDash, indent, ln.no));
    }
    return arr;
  }

  parseValue(restRaw, parentIndent, lineNo) {
    let rest = restRaw.trim();
    // anchors / aliases
    let anchorName = null;
    if (rest.startsWith('&')) {
      const m = /^&([^\s]+)\s*(.*)$/s.exec(rest);
      if (!m) throw new YamlError('bad anchor', lineNo);
      anchorName = m[1];
      rest = m[2];
      if (rest === '') {
        const next = this.skipBlank();
        const node = next && next.indent > parentIndent ? this.parseBlock(next.indent) : null;
        this.anchors.set(anchorName, node);
        return node;
      }
    }
    if (rest.startsWith('*')) {
      const name = rest.slice(1).trim();
      if (!this.anchors.has(name)) throw new YamlError(`unknown alias *${name}`, lineNo);
      return this.anchors.get(name);
    }
    if (rest === '') {
      const next = this.skipBlank();
      const node = next && next.indent > parentIndent ? this.parseBlock(next.indent) : null;
      if (anchorName) this.anchors.set(anchorName, node);
      return node;
    }
    const block = RE_BLOCK.exec(rest);
    if (block) {
      const chomp = block[2] || block[5] || '';
      const explicit = block[3] || block[4] || null;
      const node = this.parseBlockScalar(block[1], chomp, explicit === null ? null : Number(explicit), parentIndent);
      if (anchorName) this.anchors.set(anchorName, node);
      return node;
    }
    if (rest.startsWith('[') || rest.startsWith('{')) {
      const node = this.parseFlowValue(rest);
      if (anchorName) this.anchors.set(anchorName, node);
      return node;
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const node = this.parseQuoted(rest);
      if (anchorName) this.anchors.set(anchorName, node);
      return node;
    }
    // plain scalar, possibly continued on more-indented following lines
    let text = stripInlineComment(rest).trim();
    for (;;) {
      const next = this.i < this.lines.length ? this.info(this.i) : null;
      if (!next || next.blank || next.indent <= parentIndent) break;
      if (next.content === '-' || RE_SEQ.test(next.content)) break;
      if (splitKeyValue(next.content)) break;
      const piece = stripInlineComment(next.content).trim();
      if (piece === '') break;
      this.i++;
      text += ' ' + piece;
    }
    const node = resolveScalar(text);
    if (anchorName) this.anchors.set(anchorName, node);
    return node;
  }

  parseQuoted(rest) {
    if (rest.startsWith('"')) {
      const res = parseDoubleQuoted(rest);
      return res.value;
    }
    // single quoted
    let out = '';
    let i = 1;
    for (; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "'") {
        if (rest[i + 1] === "'") { out += "'"; i++; continue; }
        return out;
      }
      out += ch;
    }
    throw new YamlError('unterminated single-quoted scalar');
  }

  // Flow collections may span multiple lines; gather until balanced.
  parseFlowValue(first) {
    let text = first;
    let idx = this.i;
    const balanced = () => {
      let depth = 0;
      let quote = null;
      for (let j = 0; j < text.length; j++) {
        const ch = text[j];
        if (quote) {
          if (quote === '"' && ch === '\\') { j++; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
      }
      return depth <= 0 && !quote;
    };
    while (!balanced()) {
      if (idx >= this.lines.length) throw new YamlError('unterminated flow collection');
      text += ' ' + this.lines[idx].trim();
      idx++;
    }
    this.i = idx;
    const fp = new FlowParser(text, this);
    const value = fp.parseValue();
    fp.skipWs();
    if (fp.pos < fp.s.length && fp.s.slice(fp.pos).trim().replace(/^#.*$/, '') !== '') {
      throw new YamlError(`unexpected trailing content in flow value: ${fp.s.slice(fp.pos, fp.pos + 40)}`);
    }
    return value;
  }

  parseBlockScalar(style, chomp, explicitIndent, parentIndent) {
    // find content indent from the first non-blank line
    let contentIndent = explicitIndent === null ? null : parentIndent + explicitIndent;
    let idx = this.i;
    const collected = [];
    let sawContent = false;
    while (idx < this.lines.length) {
      const raw = this.lines[idx];
      const ind = raw.search(/[^ ]/);
      const blank = ind === -1 || RE_EMPTY.test(raw);
      if (blank) {
        collected.push({ blank: true, raw });
        idx++;
        continue;
      }
      if (ind <= parentIndent) break;
      if (contentIndent === null) contentIndent = ind;
      if (ind < contentIndent) break;
      collected.push({ blank: false, raw, indent: ind });
      sawContent = true;
      idx++;
    }
    this.i = idx;
    if (contentIndent === null) return '';
    // drop leading blank lines (YAML keeps them, but they only matter for chomping)
    const lines = collected.map((l) => (l.blank ? '' : l.raw.slice(contentIndent)));
    let text = style === '|' ? lines.join('\n') : foldLines(lines);
    if (chomp === '-') text = text.replace(/\n+$/, '');
    else if (chomp === '+') text = text.endsWith('\n') ? text : text + '\n';
    else text = text.replace(/\n+$/, '') + '\n';
    return text;
  }
}

export function parseYaml(text, options = {}) {
  const src = stripBom(String(text));
  const rawLines = src.split(/\r?\n/);
  // drop document markers at the very start; stop at a second document
  let start = 0;
  while (start < rawLines.length && RE_EMPTY.test(rawLines[start])) start++;
  if (start < rawLines.length && rawLines[start].trim() === '---') start++;
  let end = rawLines.length;
  for (let i = start; i < rawLines.length; i++) {
    // Document markers must start at column 0; "---" or "..." deeper inside a
    // block scalar is ordinary markdown text.
    if (rawLines[i] === '---' || rawLines[i] === '...') { end = i; break; }
  }
  const lines = rawLines.slice(start, end);
  // strip trailing blank lines
  while (lines.length && RE_EMPTY.test(lines[lines.length - 1])) lines.pop();
  const p = new Parser(lines);
  const ln = p.skipBlank();
  if (!ln) return null;
  const value = p.parseBlock(ln.indent);
  const tail = p.skipBlank();
  if (tail) throw new YamlError(`unexpected content after document`, tail.no);
  return value;
}

class FlowParser {
  constructor(s, root) { this.s = s; this.pos = 0; this.root = root; }

  skipWs() { while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++; }

  parseValue() {
    this.skipWs();
    const ch = this.s[this.pos];
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseObject();
    if (ch === '"') return this.parseDouble();
    if (ch === "'") return this.parseSingle();
    if (ch === '*' ) {
      const m = /^\*([^\s,\]}]+)/.exec(this.s.slice(this.pos));
      if (!m) throw new YamlError('bad alias in flow');
      this.pos += m[0].length;
      if (!this.root.anchors.has(m[1])) throw new YamlError(`unknown alias *${m[1]}`);
      return this.root.anchors.get(m[1]);
    }
    return resolveScalar(this.parsePlain());
  }

  parsePlain() {
    const start = this.pos;
    let quote = null;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (quote) {
        if (quote === '"' && ch === '\\') { this.pos += 2; continue; }
        if (ch === quote) quote = null;
        this.pos++;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; this.pos++; continue; }
      if (ch === ',' || ch === ']' || ch === '}') break;
      this.pos++;
    }
    return this.s.slice(start, this.pos).trim();
  }

  parseDouble() {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (ch === '\\') { this.pos += 2; continue; }
      if (ch === '"') { this.pos++; break; }
      this.pos++;
    }
    return parseDoubleQuoted(this.s.slice(start, this.pos)).value;
  }

  parseSingle() {
    let out = '';
    this.pos++;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (ch === "'") {
        if (this.s[this.pos + 1] === "'") { out += "'"; this.pos += 2; continue; }
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    throw new YamlError('unterminated single-quoted scalar in flow');
  }

  parseArray() {
    this.pos++; // [
    const arr = [];
    this.skipWs();
    if (this.s[this.pos] === ']') { this.pos++; return arr; }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      const ch = this.s[this.pos];
      if (ch === ',') { this.pos++; continue; }
      if (ch === ']') { this.pos++; return arr; }
      throw new YamlError(`expected , or ] in flow sequence, got ${JSON.stringify(ch)}`);
    }
  }

  parseObject() {
    this.pos++; // {
    const obj = {};
    this.skipWs();
    if (this.s[this.pos] === '}') { this.pos++; return obj; }
    for (;;) {
      this.skipWs();
      let key;
      const ch = this.s[this.pos];
      if (ch === '"') key = this.parseDouble();
      else if (ch === "'") key = this.parseSingle();
      else {
        const start = this.pos;
        while (this.pos < this.s.length && this.s[this.pos] !== ':') this.pos++;
        key = this.s.slice(start, this.pos).trim();
      }
      this.skipWs();
      if (this.s[this.pos] !== ':') throw new YamlError('expected : in flow mapping');
      this.pos++;
      obj[key] = this.parseValue();
      this.skipWs();
      const ch2 = this.s[this.pos];
      if (ch2 === ',') { this.pos++; continue; }
      if (ch2 === '}') { this.pos++; return obj; }
      throw new YamlError(`expected , or } in flow mapping, got ${JSON.stringify(ch2)}`);
    }
  }
}

// Folded (>) line handling: newlines between non-empty lines become spaces,
// blank lines become newlines.
function foldLines(lines) {
  let out = '';
  let prevBlank = true;
  for (const line of lines) {
    const blank = line === '';
    if (blank) { out += '\n'; prevBlank = true; continue; }
    if (!prevBlank) out += ' ';
    out += line;
    prevBlank = false;
  }
  return out;
}

export { YamlError, Parser };
