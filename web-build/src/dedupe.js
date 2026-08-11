// Author-name unification: "Silva, A." and "Silva, A. B." are treated as the
// same person when one name's initials are a prefix of the other's, under
// the same surname. This is a heuristic, not identity resolution.
// ponytail: initials-prefix heuristic, upgrade to ORCID/DOI-based matching if false merges show up.
function normalizeName(name) {
  const [surnamePart, restPart = ''] = name.split(',').map((s) => s.trim());
  const initials = restPart
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase());
  return { surname: surnamePart.toLowerCase(), initials };
}

function initialsCompatible(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.every((ch, i) => ch === longer[i]);
}

// Groups raw name strings into { canonical, variants[] } clusters (same
// surname, compatible initials). The shared core behind unifyAuthors and
// canonicalNameMap so both use one grouping pass.
function groupNames(names) {
  const groups = [];
  for (const name of names) {
    const { surname, initials } = normalizeName(name);
    const group = groups.find((g) => g.surname === surname && initialsCompatible(g.initials, initials));
    if (group) {
      group.variants.push(name);
      if (initials.length > group.initials.length) {
        group.initials = initials;
        group.canonical = name;
      }
    } else {
      groups.push({ surname, initials, canonical: name, variants: [name] });
    }
  }
  return groups;
}

// authorCounts: object of { "Surname, F." -> citationCount }
function unifyAuthors(authorCounts) {
  return groupNames(Object.keys(authorCounts))
    .map((g) => ({
      name: g.canonical,
      citations: g.variants.reduce((sum, v) => sum + authorCounts[v], 0),
      mergedFrom: g.variants,
    }))
    .sort((a, b) => b.citations - a.citations);
}

// Maps every raw name variant to its group's canonical spelling — used to
// collapse duplicate authors before building the co-authorship graph.
function canonicalNameMap(names) {
  const map = new Map();
  for (const g of groupNames(names)) {
    for (const variant of g.variants) map.set(variant, g.canonical);
  }
  return map;
}

// Dedup key for a bibliographic record: DOI when present (reliable, source-
// independent), title otherwise (normalized — trimmed/collapsed/lowercased —
// so trivial formatting differences between sources don't create dupes).
// ponytail: title fallback is still exact-normalized-match, not fuzzy; two
// sources with meaningfully different title wording will still both show up.
function recordKey(record) {
  const doi = (record.doi || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  if (doi) return 'doi:' + doi;
  return 'title:' + (record.title || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
}

if (typeof module !== 'undefined') module.exports = { unifyAuthors, normalizeName, canonicalNameMap, recordKey };
else { window.unifyAuthors = unifyAuthors; window.normalizeName = normalizeName; window.canonicalNameMap = canonicalNameMap; window.recordKey = recordKey; }
