// RIS is line-based: "TAG  - value", records end at "ER  -".
// Fields we care about: TI/T1 title, AU author (repeatable), PY/Y1 year, N1/AB abstract, KW keyword (repeatable).
function parseRIS(text) {
  const records = [];
  let current = null;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const m = /^([A-Z0-9]{2})\s*-\s?(.*)$/.exec(rawLine);
    if (!m) continue;
    const [, tag, value] = m;

    if (tag === 'TY') {
      current = { title: '', authors: [], year: null, keywords: [], citations: 0, source: 'RIS', doi: '', venue: '', pdfUrl: '', abstract: '', institutions: [], countries: [], referencedWorks: [] };
    }
    if (!current) continue;

    switch (tag) {
      case 'TI': case 'T1': current.title = value.trim(); break;
      case 'AU': case 'A1': current.authors.push(value.trim()); break;
      case 'PY': case 'Y1': {
        const year = parseInt(value, 10);
        if (!Number.isNaN(year)) current.year = year;
        break;
      }
      case 'KW': current.keywords.push(value.trim()); break;
      case 'DO': current.doi = value.trim(); break;
      case 'JF': case 'JO': case 'T2': current.venue = value.trim(); break;
      case 'UR': case 'L1': if (!current.pdfUrl) current.pdfUrl = value.trim(); break;
      case 'AB': case 'N2': current.abstract = value.trim(); break;
      case 'ER':
        if (current.title) records.push(current);
        current = null;
        break;
    }
  }
  return records;
}

if (typeof module !== 'undefined') module.exports = { parseRIS };
else window.parseRIS = parseRIS;
