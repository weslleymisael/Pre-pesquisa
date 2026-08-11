// Bibliometric-law computations. All pure functions over the record array
// already collected by search/import — no new data source needed.
const _analysisCanonicalNameMap = typeof module !== 'undefined' ? require('./dedupe.js').canonicalNameMap : window.canonicalNameMap;

// Bradford's Law: journals ranked by article count, split into three zones
// of roughly equal cumulative article count. Zone 1 ("core") is the small
// set of journals producing the first third of all articles.
// ponytail: equal-thirds zoning is the common practical proxy for Bradford's
// law (true scattering is log-based); swap for a log-fit if precision matters.
function bradfordZones(records) {
  const counts = new Map();
  for (const r of records) {
    if (r.venue) counts.set(r.venue, (counts.get(r.venue) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, c]) => sum + c, 0);
  const zoneSize = total / 3;

  let cumulative = 0;
  let zone = 1;
  return sorted.map(([venue, count], i) => {
    cumulative += count;
    const row = { rank: i + 1, venue, count, zone };
    if (cumulative >= zoneSize * zone && zone < 3) zone++;
    return row;
  });
}

// Lotka's Law: distribution of articles-per-author. Predicts the number of
// authors with n papers falls off as ~1/n². `expected` overlays that curve
// normalized to the observed single-paper-author count for comparison.
function lotkaDistribution(records) {
  const canon = _analysisCanonicalNameMap(records.flatMap((r) => r.authors || []));
  const papersPerAuthor = new Map();
  for (const r of records) {
    const authors = new Set((r.authors || []).map((a) => canon.get(a) || a));
    for (const author of authors) papersPerAuthor.set(author, (papersPerAuthor.get(author) || 0) + 1);
  }

  const histogram = new Map();
  for (const n of papersPerAuthor.values()) histogram.set(n, (histogram.get(n) || 0) + 1);

  const n1 = histogram.get(1) || 0;
  return [...histogram.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, authors]) => ({ n, authors, expected: Math.round(n1 / (n * n)) }));
}

// Splits the corpus's year range at its midpoint and compares how often
// each keyword shows up in the recent half vs. the older half. Ranked by
// that delta, so rising terms bubble to the top.
// ponytail: a two-bucket split, not a real trend regression — swap for a
// per-year slope fit if the midpoint split proves too coarse.
function keywordTrends(records, topN = 15) {
  const years = records.map((r) => r.year).filter(Boolean);
  if (years.length === 0) return [];
  const mid = (Math.min(...years) + Math.max(...years)) / 2;

  const recentCounts = new Map();
  const olderCounts = new Map();
  const totalCounts = new Map();
  for (const r of records) {
    if (!r.year) continue;
    const bucket = r.year >= mid ? recentCounts : olderCounts;
    for (const kw of new Set((r.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean))) {
      bucket.set(kw, (bucket.get(kw) || 0) + 1);
      totalCounts.set(kw, (totalCounts.get(kw) || 0) + 1);
    }
  }

  return [...totalCounts.keys()]
    .map((keyword) => {
      const recent = recentCounts.get(keyword) || 0;
      const older = olderCounts.get(keyword) || 0;
      return { keyword, recent, older, delta: recent - older };
    })
    .sort((a, b) => b.delta - a.delta)
    .slice(0, topN);
}

function publicationsPerYear(records) {
  const counts = new Map();
  for (const r of records) if (r.year) counts.set(r.year, (counts.get(r.year) || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
}

function journalRanking(records) {
  const map = new Map();
  for (const r of records) {
    if (!r.venue) continue;
    const entry = map.get(r.venue) || { venue: r.venue, articles: 0, citations: 0 };
    entry.articles++;
    entry.citations += r.citations || 0;
    map.set(r.venue, entry);
  }
  return [...map.values()].sort((a, b) => b.citations - a.citations);
}

// countries: ISO alpha-2 codes from OpenAlex authorship institutions (other
// sources don't reliably provide these, so their records just won't count here).
function countryRanking(records) {
  const map = new Map();
  for (const r of records) {
    for (const code of new Set(r.countries || [])) {
      const entry = map.get(code) || { country: code, articles: 0, citations: 0 };
      entry.articles++;
      entry.citations += r.citations || 0;
      map.set(code, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.articles - a.articles);
}

// Author-impact indices, computed from a plain array of per-paper citation counts.
function hIndex(citations) {
  const sorted = [...citations].sort((a, b) => b - a);
  let h = 0;
  while (h < sorted.length && sorted[h] >= h + 1) h++;
  return h;
}

// Largest g such that the top g papers together have at least g² citations.
function gIndex(citations) {
  const sorted = [...citations].sort((a, b) => b - a);
  let cumulative = 0;
  let g = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i];
    if (cumulative >= (i + 1) * (i + 1)) g = i + 1;
  }
  return g;
}

function i10Index(citations) {
  return citations.filter((c) => c >= 10).length;
}

function sortRecords(records, mode) {
  const sorted = [...records];
  switch (mode) {
    case 'citations': return sorted.sort((a, b) => (b.citations || 0) - (a.citations || 0));
    case 'year-desc': return sorted.sort((a, b) => (b.year || 0) - (a.year || 0));
    case 'year-asc': return sorted.sort((a, b) => (a.year || 0) - (b.year || 0));
    case 'title': return sorted.sort((a, b) => a.title.localeCompare(b.title));
    default: return sorted;
  }
}

const api = { bradfordZones, lotkaDistribution, publicationsPerYear, journalRanking, countryRanking, hIndex, gIndex, i10Index, sortRecords, keywordTrends };
if (typeof module !== 'undefined') module.exports = api;
else Object.assign(window, api);
