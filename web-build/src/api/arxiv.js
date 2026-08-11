// arXiv API (public, no key required, CORS-enabled). Docs: https://info.arxiv.org/help/api
// Rate limit is informal (~1 req/3s) — fine for a single interactive search.
// Returns Atom/XML, not JSON, so this parses with the browser's native DOMParser.
async function searchArxiv(query, { maxResults = 25, field = 'general' } = {}) {
  const searchExpr = field === 'author' ? `au:"${query}"` : `all:${query}`;
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchExpr)}&max_results=${maxResults}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arXiv ${res.status}: ${res.statusText}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');

  return [...doc.querySelectorAll('entry')].map((entry) => {
    const published = entry.querySelector('published')?.textContent || '';
    const pdfLink = [...entry.querySelectorAll('link')].find((l) => l.getAttribute('title') === 'pdf');
    const doiEl = entry.getElementsByTagName('arxiv:doi')[0];

    return {
      title: (entry.querySelector('title')?.textContent || '').trim().replace(/\s+/g, ' '),
      authors: [...entry.querySelectorAll('author > name')].map((n) => n.textContent.trim()),
      year: published ? parseInt(published.slice(0, 4), 10) : null,
      citations: 0, // arXiv is a preprint repository, not a citation index
      // arXiv has no keyword field — its subject categories (e.g. "cs.DL") are the closest fit.
      keywords: [...entry.querySelectorAll('category')].map((c) => c.getAttribute('term')).filter(Boolean),
      source: 'arXiv',
      doi: doiEl ? doiEl.textContent.trim() : '',
      venue: 'arXiv',
      pdfUrl: pdfLink ? pdfLink.getAttribute('href') : '',
      abstract: (entry.querySelector('summary')?.textContent || '').trim().replace(/\s+/g, ' '),
      institutions: [],
      countries: [],
      referencedWorks: [],
    };
  });
}

if (typeof module !== 'undefined') module.exports = { searchArxiv };
else window.searchArxiv = searchArxiv;
