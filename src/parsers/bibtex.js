// Minimal brace-depth-aware BibTeX parser. Handles the common case
// (braced/quoted field values, nested braces) — not the full BibTeX grammar
// (string macros, @comment, crossref inheritance are not supported).
// ponytail: naive scanner, swap for a real BibTeX grammar (e.g. bibtex-parse-js) if malformed real-world files show up.
function splitEntries(text) {
  const entries = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '@') { i++; continue; }
    const braceStart = text.indexOf('{', i);
    if (braceStart === -1) break;
    let depth = 1;
    let j = braceStart + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    entries.push(text.slice(i, j));
    i = j;
  }
  return entries;
}

function splitTopLevel(body, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function stripValue(raw) {
  let v = raw.trim().replace(/,\s*$/, '').trim();
  if (v.startsWith('{') && v.endsWith('}')) v = v.slice(1, -1);
  else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  // Inner {...} pairs are just capitalization-protection markers in BibTeX values.
  return v.replace(/[{}]/g, '').trim();
}

function parseBibTeX(text) {
  const records = [];
  for (const raw of splitEntries(text)) {
    const head = /^@(\w+)\{/.exec(raw);
    if (!head) continue;
    const body = raw.slice(head[0].length, -1); // strip "@type{" ... "}"
    const firstComma = body.indexOf(',');
    if (firstComma === -1) continue;
    const fieldsBlock = body.slice(firstComma + 1);

    const record = { title: '', authors: [], year: null, keywords: [], citations: 0, source: 'BibTeX', doi: '', venue: '', pdfUrl: '', abstract: '', institutions: [], countries: [], referencedWorks: [] };
    for (const chunk of splitTopLevel(fieldsBlock, ',')) {
      const eq = chunk.indexOf('=');
      if (eq === -1) continue;
      const name = chunk.slice(0, eq).trim().toLowerCase();
      const value = stripValue(chunk.slice(eq + 1));
      if (!value) continue;
      switch (name) {
        case 'title': record.title = value.replace(/\s+/g, ' '); break;
        case 'author': record.authors = value.split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean); break;
        case 'year': { const y = parseInt(value, 10); if (!Number.isNaN(y)) record.year = y; break; }
        case 'keywords': record.keywords = value.split(/[,;]/).map((k) => k.trim()).filter(Boolean); break;
        case 'doi': record.doi = value; break;
        case 'journal': case 'booktitle': record.venue = value; break;
        case 'url': record.pdfUrl = value; break;
        case 'abstract': record.abstract = value.replace(/\s+/g, ' '); break;
      }
    }
    if (record.title) records.push(record);
  }
  return records;
}

if (typeof module !== 'undefined') module.exports = { parseBibTeX };
else window.parseBibTeX = parseBibTeX;
