// OpenAlex REST API (public, no key required, CORS-enabled). Docs: https://docs.openalex.org

// OpenAlex serves abstracts as a word->positions inverted index (to save
// space) instead of plain text — this rebuilds the sentence.
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const positions = [];
  for (const [word, idxs] of Object.entries(invertedIndex)) {
    for (const i of idxs) positions[i] = word;
  }
  return positions.join(' ').trim();
}

async function searchOpenAlex(query, { perPage = 25, field = 'general' } = {}) {
  // "general" hits OpenAlex's full-text relevance search (title/abstract/fulltext) —
  // a name there can come from anywhere, including someone else's reference list.
  // "author" scopes to the byline specifically via raw_author_name.search.
  const url = field === 'author'
    ? `https://api.openalex.org/works?filter=raw_author_name.search:${encodeURIComponent(query)}&per-page=${perPage}`
    : `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${perPage}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}: ${res.statusText}`);
  const data = await res.json();

  return (data.results || []).map((w) => {
    const institutions = (w.authorships || []).flatMap((a) => a.institutions || []);
    return {
      title: w.title || w.display_name || '',
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      year: w.publication_year ?? null,
      citations: w.cited_by_count ?? 0,
      keywords: (w.concepts || []).map((c) => c.display_name).filter(Boolean),
      source: 'OpenAlex',
      doi: (w.doi || '').replace(/^https?:\/\/doi\.org\//, ''),
      venue: w.primary_location?.source?.display_name || '',
      pdfUrl: w.open_access?.oa_url || w.best_oa_location?.pdf_url || '',
      abstract: reconstructAbstract(w.abstract_inverted_index),
      institutions: [...new Set(institutions.map((i) => i.display_name).filter(Boolean))],
      countries: [...new Set(institutions.map((i) => i.country_code).filter(Boolean))],
      // OpenAlex work IDs this paper cites — used for bibliographic coupling
      // (papers that cite the same sources). Not available from other sources.
      referencedWorks: w.referenced_works || [],
    };
  });
}

// Co-citation nodes are *referenced* works, which usually aren't in our own
// corpus — this is the extra lookup that gives them a readable label
// instead of a bare OpenAlex ID. Batches of 50 (OpenAlex's practical filter
// limit); best-effort per batch so one bad chunk doesn't blank every label.
async function resolveWorkLabels(workUrls) {
  const shortIds = [...new Set(workUrls.map((u) => u.split('/').pop()).filter(Boolean))];
  const labels = new Map();
  const chunkSize = 50;

  for (let i = 0; i < shortIds.length; i += chunkSize) {
    const chunk = shortIds.slice(i, i + chunkSize);
    const url = `https://api.openalex.org/works?filter=ids.openalex:${chunk.join('|')}&select=id,title,cited_by_count&per-page=${chunk.length}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const w of data.results || []) {
        labels.set(w.id, { title: w.title || w.id, citations: w.cited_by_count || 0 });
      }
    } catch {
      // network hiccup on this batch — those nodes just keep their raw id as the label
    }
  }
  return labels;
}

if (typeof module !== 'undefined') module.exports = { searchOpenAlex, reconstructAbstract, resolveWorkLabels };
else { window.searchOpenAlex = searchOpenAlex; window.reconstructAbstract = reconstructAbstract; window.resolveWorkLabels = resolveWorkLabels; }
