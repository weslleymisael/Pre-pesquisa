// PubMed / NCBI E-utilities (public, no key required, CORS-enabled).
// Docs: https://www.ncbi.nlm.nih.gov/books/NBK25501/
// Two calls: esearch finds matching PMIDs, efetch returns full article XML
// for those ids (title/authors/abstract/MeSH terms/DOI — richer than esummary).
async function searchPubMed(query, { maxResults = 25, field = 'general' } = {}) {
  const term = field === 'author' ? `${query}[Author]` : query;
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=${maxResults}&retmode=json`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`PubMed ${searchRes.status}: ${searchRes.statusText}`);
  const ids = (await searchRes.json()).esearchresult?.idlist || [];
  if (ids.length === 0) return [];

  const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&rettype=abstract&retmode=xml`;
  const fetchRes = await fetch(fetchUrl);
  if (!fetchRes.ok) throw new Error(`PubMed ${fetchRes.status}: ${fetchRes.statusText}`);
  const doc = new DOMParser().parseFromString(await fetchRes.text(), 'application/xml');

  return [...doc.querySelectorAll('PubmedArticle')].map((article) => {
    const authors = [...article.querySelectorAll('AuthorList > Author')]
      .map((a) => [a.querySelector('LastName')?.textContent, a.querySelector('Initials')?.textContent].filter(Boolean).join(', '))
      .filter(Boolean);
    const year = article.querySelector('PubDate > Year')?.textContent
      || article.querySelector('PubDate > MedlineDate')?.textContent?.slice(0, 4)
      || '';
    const doiId = [...article.querySelectorAll('ArticleId')].find((n) => n.getAttribute('IdType') === 'doi');

    return {
      title: (article.querySelector('ArticleTitle')?.textContent || '').trim(),
      authors,
      year: year ? parseInt(year, 10) : null,
      citations: 0, // PubMed is an abstract index, not a citation database
      keywords: [...article.querySelectorAll('MeshHeading > DescriptorName')].map((n) => n.textContent.trim()),
      source: 'PubMed',
      doi: doiId ? doiId.textContent.trim() : '',
      venue: article.querySelector('Journal > Title')?.textContent || '',
      pdfUrl: '', // PubMed indexes abstracts, not full text — no direct PDF link
      abstract: [...article.querySelectorAll('AbstractText')].map((n) => n.textContent).join(' ').trim(),
      institutions: [],
      countries: [],
      referencedWorks: [],
    };
  });
}

if (typeof module !== 'undefined') module.exports = { searchPubMed };
else window.searchPubMed = searchPubMed;
