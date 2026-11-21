// Fast CSV reader: a drop-in for csv-reader 1.0.0, written from its rules.
// Strategy: most records are plain lines, so parse those with a slice +
// split (native speed). Any line holding a quote or a stray CR falls back
// to an exact indexOf-driven field parser that follows the same broken-row
// policy: BOM dropped, CRLF/LF record ends, stray CR dropped with an
// error, quoted fields with "" escapes and LF-normalised line breaks,
// junk after a closing quote appended, unterminated quotes re-read as
// unquoted, short/long rows padded/cut to the first record's width.
// Pure: no state is kept from one run() call to the next.

// How a field ended: 0 = comma, 1 = line break, 2 = end of text.
const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let p = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read, for error records.
  let curLine = 1;
  let curRow = null;

  function error(code) {
    errors.push({ code, line: curLine, row: curRow });
  }

  // Reads unquoted characters onto `startVal` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr). Returns the
  // field, how it ended, and how many characters were appended.
  function readUnquoted(startVal) {
    let value = startVal;
    let added = 0;
    for (;;) {
      const ci = text.indexOf(',', p);
      const ni = text.indexOf('\n', p);
      const ri = text.indexOf('\r', p);
      let m = ci;
      let kind = COMMA;
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; kind = BREAK; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; kind = 2; }
      if (m === -1) {
        if (p < n) { value += text.slice(p, n); added += n - p; p = n; }
        return { value, ended: END, added };
      }
      if (kind === COMMA) {
        value += text.slice(p, m); added += m - p; p = m + 1;
        return { value, ended: COMMA, added };
      }
      if (kind === BREAK) {
        value += text.slice(p, m); added += m - p; p = m + 1; line++;
        return { value, ended: BREAK, added };
      }
      // A CR: CRLF ends the record, a lone CR is dropped.
      if (text.charCodeAt(m + 1) === 10) {
        value += text.slice(p, m); added += m - p; p = m + 2; line++;
        return { value, ended: BREAK, added };
      }
      error('stray_cr');
      value += text.slice(p, m); added += m - p; p = m + 1;
    }
  }

  // Normalises one slice of a quoted field: every CRLF or lone CR inside
  // quotes reads as one LF, and every line break inside counts a line.
  function fixSegment(a, b) {
    if (a === b) return '';
    const seg = text.slice(a, b);
    const hasR = seg.indexOf('\r') !== -1;
    const hasN = seg.indexOf('\n') !== -1;
    if (!hasR && !hasN) return seg;
    if (!hasR) {
      line += seg.split('\n').length - 1;
      return seg;
    }
    const breaks = seg.match(/\r\n|\r|\n/g);
    if (breaks !== null) line += breaks.length;
    return seg.replace(/\r\n|\r/g, '\n');
  }

  // Reads a quoted field whose opening quote is at p.
  function readQuoted() {
    const open = p;
    const openLine = line;
    let value = '';
    p += 1;
    let segStart = p;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // Never closes: the quote is literal, the rest is re-read unquoted.
        p = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += fixSegment(segStart, q);
        value += '"';
        p = q + 2;
        segStart = p;
        continue;
      }
      value += fixSegment(segStart, q);
      p = q + 1;
      break;
    }
    if (p >= n) return { value, ended: END };
    const c = text.charCodeAt(p);
    if (c === 44) { p += 1; return { value, ended: COMMA }; }
    if (c === 10) { p += 1; line += 1; return { value, ended: BREAK }; }
    if (c === 13 && text.charCodeAt(p + 1) === 10) {
      p += 2; line += 1;
      return { value, ended: BREAK };
    }
    // Junk after the closing quote is appended as it stands.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Parses one record the exact way, field by field. Returns its fields,
  // or null when the line held only stray CRs (no record).
  function parseSlowRecord() {
    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(p) === 34;
      const field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
      ended = field.ended;
    } while (ended === COMMA);
    if (fields.length === 1 && fields[0] === '' && !quoted) return null;
    return fields;
  }

  while (p < n) {
    // Peek at the next physical line: a record with no quotes and no stray
    // CR on this line is exactly one line, so split it directly.
    let e = text.indexOf('\n', p);
    const hasNL = e !== -1;
    if (!hasNL) e = n;
    let end = e;
    if (hasNL && e > p && text.charCodeAt(e - 1) === 13) end = e - 1;
    if (end === p) {
      // A line with no characters is no record.
      if (hasNL) { line += 1; p = e + 1; continue; }
      break;
    }
    curLine = line;
    curRow = header && columns === null ? null : rows.length;
    let fields;
    const lineStr = text.slice(p, end);
    if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
      fields = lineStr.split(',');
      if (hasNL) { line += 1; p = e + 1; } else { p = n; }
    } else {
      fields = parseSlowRecord();
      if (fields === null) continue;
    }
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: curLine, row: curRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: curLine, row: curRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
