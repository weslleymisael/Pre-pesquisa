// Co-occurrence graphs (keywords or co-authorship): pure data-shaping
// (testable) + D3 rendering (browser-only). Both graph types are "which
// items appear together in the same record" — one core builder, two ways
// of extracting the item list per record.
const _graphCanonicalNameMap = typeof module !== 'undefined' ? require('./dedupe.js').canonicalNameMap : window.canonicalNameMap;

// itemsPerRecord: array of string-arrays, one per record. density: how many
// top items (by frequency) to keep as nodes.
function buildNetwork(itemsPerRecord, density = 50) {
  const freq = new Map();
  const pairCounts = new Map();

  for (const items of itemsPerRecord) {
    const uniq = [...new Set(items)];
    for (const k of uniq) freq.set(k, (freq.get(k) || 0) + 1);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = [uniq[i], uniq[j]].sort().join('|||');
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  const topItems = new Set(
    [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, density).map(([k]) => k)
  );

  const nodes = [...topItems].map((id) => ({ id, count: freq.get(id) }));
  const links = [...pairCounts.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split('|||');
      return { source, target, weight };
    })
    .filter((l) => topItems.has(l.source) && topItems.has(l.target));

  return { nodes, links };
}

function buildCooccurrence(records, density = 50) {
  return buildNetwork(
    records.map((r) => (r.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean)),
    density
  );
}

function buildCoauthorship(records, density = 50) {
  const canon = _graphCanonicalNameMap(records.flatMap((r) => r.authors || []));
  return buildNetwork(
    records.map((r) => (r.authors || []).map((a) => canon.get(a) || a)),
    density
  );
}

// Bibliographic coupling: papers are linked when they cite the same prior
// works (shared referencedWorks), not because they co-occur in a shared
// "record" — the record here IS the node, so this doesn't fit buildNetwork's
// shape and gets its own pairwise comparison. Only OpenAlex records carry
// referencedWorks, so records from other sources are silently excluded.
function buildCitationCoupling(records, density = 50) {
  const withRefs = records.filter((r) => (r.referencedWorks || []).length > 0);
  const top = [...withRefs].sort((a, b) => (b.citations || 0) - (a.citations || 0)).slice(0, density);
  const refSets = top.map((r) => new Set(r.referencedWorks));
  const nodeId = (r) => r.doi || r.title;

  const nodes = top.map((r) => ({
    id: nodeId(r),
    label: r.title.length > 40 ? r.title.slice(0, 37) + '...' : r.title,
    count: Math.min(r.citations || 0, 50), // cap so one blockbuster paper doesn't dwarf the graph
  }));

  const links = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      let shared = 0;
      for (const w of refSets[i]) if (refSets[j].has(w)) shared++;
      if (shared > 0) links.push({ source: nodeId(top[i]), target: nodeId(top[j]), weight: shared });
    }
  }
  return { nodes, links };
}

// Co-citation: the inverse of bibliographic coupling. Coupling links two of
// OUR papers when they cite the same sources; co-citation links two CITED
// works when the same one of our papers cites both of them. Nodes here are
// the *referenced* works, not our corpus — so unlike every other network
// mode, we don't have titles/labels for them locally. This only returns
// the raw structure (node id = OpenAlex work URL); resolving readable
// labels needs a separate API lookup (see resolveWorkLabels in openalex.js).
function buildCoCitation(records, density = 50) {
  return buildNetwork(records.map((r) => r.referencedWorks || []), density);
}

function escapeXml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// GraphML export — the standard node/edge XML format read by Gephi,
// Cytoscape, yEd, and NetworkX, for people who want to analyze the network
// itself rather than just look at the picture we render. Node ids are
// remapped to n0/n1/... (GraphML wants simple ids); the real name is kept
// in the "label" attribute. After D3's force simulation runs, it mutates
// link.source/target from plain id strings into references to the actual
// node objects — this accepts both shapes.
function buildGraphML(nodes, links) {
  const idOf = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const endpointId = (endpoint) => idOf.get(typeof endpoint === 'object' ? endpoint.id : endpoint);

  const nodeXml = nodes
    .map((n) => `    <node id="${idOf.get(n.id)}">\n      <data key="label">${escapeXml(n.label || n.id)}</data>\n      <data key="count">${n.count ?? 0}</data>\n    </node>`)
    .join('\n');
  const edgeXml = links
    .map((l, i) => `    <edge id="e${i}" source="${endpointId(l.source)}" target="${endpointId(l.target)}">\n      <data key="weight">${l.weight ?? 1}</data>\n    </edge>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <key id="count" for="node" attr.name="count" attr.type="int"/>
  <key id="weight" for="edge" attr.name="weight" attr.type="int"/>
  <graph id="G" edgedefault="undirected">
${nodeXml}
${edgeXml}
  </graph>
</graphml>
`;
}

// Renders (or re-renders) a force-directed graph into `container` (a DOM element).
// `repulsion` (1-10) scales the node-charge strength; call again on control changes.
function renderGraph(container, { nodes, links }, { repulsion = 5 } = {}) {
  container.innerHTML = '';
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 300;
  const palette = ['#0035C1', '#FF7300', '#FECE00', '#00B4D8'];

  // xmlns is required for the SVG to stand alone once serialized outside this
  // document (file export, <img> rasterization for PNG export) — outerHTML
  // does not add it automatically.
  const svg = d3.select(container).append('svg').attr('xmlns', 'http://www.w3.org/2000/svg').attr('width', width).attr('height', height);

  // Everything pannable/zoomable lives under one <g> that the zoom behavior
  // transforms — the SVG element itself keeps its fixed width/height (export
  // still captures the full canvas regardless of current zoom/pan).
  const zoomLayer = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.2, 5]).on('zoom', (event) => zoomLayer.attr('transform', event.transform));
  svg.call(zoom);

  const link = zoomLayer
    .append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', '#CBD5E1')
    .attr('stroke-width', (d) => Math.min(1 + d.weight, 6));

  const node = zoomLayer
    .append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', (d) => 8 + Math.min(d.count * 2, 20))
    .attr('fill', (_, i) => palette[i % palette.length])
    .call(
      d3
        .drag()
        .on('start', (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  const label = zoomLayer
    .append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text((d) => d.label || d.id)
    .attr('font-size', 9)
    .attr('font-weight', 700)
    .attr('fill', '#0F172A')
    .attr('text-anchor', 'middle')
    .attr('dy', -12);

  const sim = d3
    .forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance(60))
    .force('charge', d3.forceManyBody().strength(-repulsion * 30))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius((d) => 12 + d.count))
    .on('tick', () => {
      link
        .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      label.attr('x', (d) => d.x).attr('y', (d) => d.y);
    });

  return sim;
}

if (typeof module !== 'undefined') module.exports = { buildCooccurrence, buildCoauthorship, buildCitationCoupling, buildCoCitation, buildGraphML, renderGraph };
else {
  window.buildCooccurrence = buildCooccurrence;
  window.buildCoauthorship = buildCoauthorship;
  window.buildCitationCoupling = buildCitationCoupling;
  window.buildCoCitation = buildCoCitation;
  window.buildGraphML = buildGraphML;
  window.renderGraph = renderGraph;
}
