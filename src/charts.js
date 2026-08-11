// Minimal D3 bar chart, shared by publications-per-year and Lotka's-law
// views. Browser-only (needs the DOM + the global d3 script already on the page).
function renderBarChart(container, data, { xKey, yKey, color = '#0035C1', series } = {}) {
  container.innerHTML = '';
  const width = container.clientWidth || 400;
  const height = container.clientHeight || 240;
  const margin = { top: 10, right: 10, bottom: 36, left: 40 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const svg = d3.select(container).append('svg').attr('width', width).attr('height', height);
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(data.map((d) => d[xKey])).range([0, innerW]).padding(0.25);
  const yMax = d3.max(data, (d) => Math.max(d[yKey], series ? d[series] || 0 : 0)) || 1;
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

  g.append('g')
    .selectAll('rect')
    .data(data)
    .join('rect')
    .attr('x', (d) => x(d[xKey]))
    .attr('y', (d) => y(d[yKey]))
    .attr('width', x.bandwidth())
    .attr('height', (d) => innerH - y(d[yKey]))
    .attr('fill', color)
    .attr('rx', 3);

  // Optional overlay line (e.g. Lotka's expected 1/n² curve).
  if (series) {
    const line = d3.line().x((d) => x(d[xKey]) + x.bandwidth() / 2).y((d) => y(d[series]));
    g.append('path').datum(data).attr('d', line).attr('fill', 'none').attr('stroke', '#FF7300').attr('stroke-width', 2);
    g.append('g')
      .selectAll('circle')
      .data(data)
      .join('circle')
      .attr('cx', (d) => x(d[xKey]) + x.bandwidth() / 2)
      .attr('cy', (d) => y(d[series]))
      .attr('r', 3)
      .attr('fill', '#FF7300');
  }

  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .selectAll('text')
    .attr('font-size', 9)
    .attr('transform', 'rotate(-40)')
    .style('text-anchor', 'end');
  g.append('g').call(d3.axisLeft(y).ticks(5)).selectAll('text').attr('font-size', 9);
  g.selectAll('.domain, .tick line').attr('stroke', '#E2E8F0');
}

if (typeof module !== 'undefined') module.exports = { renderBarChart };
else window.renderBarChart = renderBarChart;
