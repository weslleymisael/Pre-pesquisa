// Crossref REST API (public, no key required, CORS-enabled). Docs: https://api.crossref.org
async function searchCrossref(query, { rows = 25, field = 'general' } = {}) {
  const param = field === 'author' ? 'query.author' : 'query';
  const url = `https://api.crossref.org/works?${param}=${encodeURIComponent(query)}&rows=${rows}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Crossref ${res.status}: ${res.statusText}`);
  const data = await res.json();

  return (data.message?.items || []).map((it) => ({
    title: (it.title && it.title[0]) || '',
    authors: (it.author || []).map((a) => [a.family, a.given].filter(Boolean).join(', ')).filter(Boolean),
    year: it.published?.['date-parts']?.[0]?.[0] ?? null,
    citations: it['is-referenced-by-count'] ?? 0,
    keywords: it.subject || [],
    source: 'Crossref',
    doi: it.DOI || '',
    venue: (it['container-title'] && it['container-title'][0]) || '',
    pdfUrl: (it.link || []).find((l) => l['content-type'] === 'application/pdf')?.URL || '',
    // Crossref abstracts are JATS XML (e.g. "<jats:p>...</jats:p>") when present at all.
    abstract: (it.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    institutions: [],
    countries: [],
    referencedWorks: [],
  }));
}

if (typeof module !== 'undefined') module.exports = { searchCrossref };
else window.searchCrossref = searchCrossref;
