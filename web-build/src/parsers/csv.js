// RFC4180-ish CSV parser (quoted fields, escaped "" quotes, commas/newlines inside quotes).
function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip, \n handles the break */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Common export header variants from WoS/Scopus/OpenAlex/SciELO CSVs.
const HEADER_ALIASES = {
  title: ['title', 'article title', 'título'],
  authors: ['authors', 'author', 'autores'],
  year: ['year', 'publication year', 'ano'],
  citations: ['citations', 'cited by', 'times cited', 'citações'],
  keywords: ['keywords', 'author keywords', 'palavras-chave'],
  doi: ['doi'],
  venue: ['source title', 'journal', 'venue', 'publication title', 'periódico'],
  pdfUrl: ['pdf url', 'link', 'url'],
  abstract: ['abstract', 'resumo'],
};

function matchColumn(header, aliases) {
  const idx = header.findIndex((h) => aliases.includes(h.trim().toLowerCase()));
  return idx;
}

function parseCSV(text) {
  const rows = parseCSVRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const cols = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    cols[field] = matchColumn(header, aliases);
  }

  const records = [];
  for (const row of rows.slice(1)) {
    const get = (idx) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');
    const title = get(cols.title);
    if (!title) continue;
    const year = parseInt(get(cols.year), 10);
    const citations = parseInt(get(cols.citations), 10);
    records.push({
      title,
      authors: get(cols.authors).split(/[;]|,\s*(?=[A-Z][a-z]*,)/).map((a) => a.trim()).filter(Boolean),
      year: Number.isNaN(year) ? null : year,
      citations: Number.isNaN(citations) ? 0 : citations,
      keywords: get(cols.keywords).split(/[,;]/).map((k) => k.trim()).filter(Boolean),
      source: 'CSV',
      doi: get(cols.doi),
      venue: get(cols.venue),
      pdfUrl: get(cols.pdfUrl),
      abstract: get(cols.abstract),
      institutions: [],
      countries: [],
      referencedWorks: [],
    });
  }
  return records;
}

if (typeof module !== 'undefined') module.exports = { parseCSV, parseCSVRows };
else { window.parseCSV = parseCSV; window.parseCSVRows = parseCSVRows; }
