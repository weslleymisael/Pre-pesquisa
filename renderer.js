(function () {
  const state = {
    records: [], // all records gathered so far (search results + imports)
    filtered: [], // records after the year-slider cut
    visible: [], // filtered further by authorFilter, if set — what every view actually renders
    authorFilter: null, // canonical author name, or null
    netMode: 'keywords', // 'keywords' | 'authors'
    activeView: 'overview', // 'overview' | 'analyses'
    activeAnalysisTab: 'network', // 'network' | 'laws' | 'authors' — sub-tab within 'analyses'
    searchAttempted: false, // distinguishes "never searched" from "searched, got nothing"
    lastGraphData: null, // { nodes, links } from the most recent successful graph render — for GraphML export
    networkRenderToken: 0, // bumped on every renderNetwork() call; co-citation's async label fetch checks this to discard stale results
  };

  const $ = (id) => document.getElementById(id);
  const graphCanvas = $('graphCanvas');
  let sim = null;

  // Repositories with a real, keyless, open search API. Adding a new one
  // later is one line here (plus the matching repo pill in index.html) —
  // everything else (repo pill list, "which repos lack an API" alert)
  // derives from this instead of a growing if-chain in runAnalysis.
  const API_SEARCHERS = {
    OpenAlex: (q, { perSource, field }) => searchOpenAlex(q, { perPage: perSource, field }),
    Crossref: (q, { perSource, field }) => searchCrossref(q, { rows: perSource, field }),
    arXiv: (q, { perSource, field }) => searchArxiv(q, { maxResults: perSource, field }),
    PubMed: (q, { perSource, field }) => searchPubMed(q, { maxResults: perSource, field }),
  };
  const countryNames = new Intl.DisplayNames(['pt'], { type: 'region' });

  // ---- XSS safety: all record fields below come from external APIs or
  // user-uploaded files, so anything going into innerHTML must be escaped,
  // and any href must be scheme-checked (no javascript: links).
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeHttpUrl(url) {
    try {
      const u = new URL(url, 'https://example.invalid');
      return ['http:', 'https:'].includes(u.protocol) && /^https?:\/\//i.test(url) ? url : null;
    } catch { return null; }
  }

  function doiUrl(doi) {
    return /^10\.\S+\/\S+$/.test(doi || '') ? 'https://doi.org/' + encodeURI(doi) : null;
  }

  // ---- metrics -------------------------------------------------------

  function renderMetrics(records) {
    const totalCitations = records.reduce((sum, r) => sum + (r.citations || 0), 0);
    $('valArtigos').textContent = records.length.toLocaleString('pt-BR');
    $('valCitacoes').textContent = totalCitations.toLocaleString('pt-BR');
    $('valHIndex').textContent = hIndex(records.map((r) => r.citations || 0));
  }

  // ---- article list ---------------------------------------------------------

  const ONBOARDING_HTML = `
    <div class="onboarding">
      <div class="onboarding-step"><span class="step-num">1</span><span>Digite um termo e clique em <b>Analisar Corpus</b> — ou clique em <b>Importar Arquivo</b> logo abaixo para usar um .bib/.ris/.csv que você já tem.</span></div>
      <div class="onboarding-step"><span class="step-num">2</span><span>Abra <b>Análises</b> no menu à esquerda: Rede de Relações (grafo), Leis Bibliométricas (Bradford, Lotka) e Unificação de Autores, em abas.</span></div>
      <div class="onboarding-step"><span class="step-num">3</span><span>Exporte os dados, salve o projeto ou gere o texto de metodologia nas <b>Ações</b>, no menu à esquerda.</span></div>
    </div>`;

  function renderArticleList(records) {
    $('articleCount').textContent = `${records.length} resultado${records.length === 1 ? '' : 's'}`;
    const list = $('articleList');
    if (records.length === 0) {
      if (state.records.length > 0) {
        list.innerHTML = '<div class="empty-state">Nenhum artigo no recorte temporal/autor atual. Ajuste o filtro acima.</div>';
      } else if (state.searchAttempted) {
        list.innerHTML = '<div class="empty-state">A busca não retornou artigos. Tente outro termo, troque "Termo geral"/"Nome de autor", ou importe um arquivo.</div>';
      } else {
        list.innerHTML = ONBOARDING_HTML;
      }
      return;
    }
    list.innerHTML = sortRecords(records, $('articleSort').value)
      .map((r) => {
        const pdf = safeHttpUrl(r.pdfUrl);
        const doi = doiUrl(r.doi);
        const link = pdf
          ? `<a class="link-btn pdf" href="${pdf}" target="_blank" rel="noopener">Abrir PDF</a>`
          : doi
            ? `<a class="link-btn" href="${doi}" target="_blank" rel="noopener">Abrir DOI</a>`
            : `<span class="link-btn disabled">Sem link</span>`;
        const meta = [r.venue, r.year, r.source].filter(Boolean).map(escapeHtml).join(' • ');
        const hasAbstract = !!(r.abstract && r.abstract.trim());
        return `
        <div class="article-row">
          <span class="title" style="${hasAbstract ? 'cursor:pointer;' : ''}" ${hasAbstract ? 'tabindex="0" role="button" aria-expanded="false" aria-label="Expandir resumo"' : ''}>${hasAbstract ? '▸ ' : ''}${escapeHtml(r.title)}</span>
          <span class="meta">
            <span>${escapeHtml((r.authors || []).slice(0, 3).join('; '))}${(r.authors || []).length > 3 ? ' et al.' : ''} — ${meta}</span>
            <span style="display:flex; align-items:center; gap:8px;">
              <span class="badge-count" style="background-color: var(--brand-blue);">${r.citations || 0} cit.</span>
              ${link}
            </span>
          </span>
          ${hasAbstract ? `<p class="abstract" style="display:none;">${escapeHtml(r.abstract)}</p>` : ''}
        </div>`;
      })
      .join('');
  }

  // ---- authors ---------------------------------------------------------

  function authorCounts(records) {
    const counts = {};
    for (const r of records) {
      for (const author of r.authors || []) {
        counts[author] = (counts[author] || 0) + (r.citations || 0);
      }
    }
    return counts;
  }

  function renderAuthorRows(container, unified, { highlightFirst = false } = {}) {
    container.innerHTML = unified
      .map((a, i) => {
        const active = a.name === state.authorFilter || (highlightFirst && i === 0 && !state.authorFilter);
        return `
      <div class="pill-row ${active ? 'highlight' : ''}" data-author="${escapeHtml(a.name)}" title="Clique para filtrar por este autor" tabindex="0" role="button" aria-pressed="${active}">
        <span>${i + 1}. ${escapeHtml(a.name)}</span>
        <span class="badge-count" style="${active ? '' : 'background-color: var(--brand-blue);'}">${a.citations} cit.</span>
      </div>`;
      })
      .join('');
  }

  function renderAuthors(records) {
    const unified = unifyAuthors(authorCounts(records));
    if (unified.length === 0) {
      const msg = '<div class="empty-state">Analise um corpus para ver o ranking de autores. Clique em um autor para filtrar os artigos por ele.</div>';
      $('authorListPreview').innerHTML = msg;
      $('authorListFull').innerHTML = msg;
      $('mergeBox').style.display = 'none';
      return;
    }
    renderAuthorRows($('authorListPreview'), unified.slice(0, 5), { highlightFirst: true });
    renderAuthorRows($('authorListFull'), unified, { highlightFirst: true });

    const mergeBox = $('mergeBox');
    const merged = unified.find((a) => a.mergedFrom.length > 1);
    if (merged) {
      mergeBox.style.display = 'flex';
      mergeBox.innerHTML = `<span>Unificado: <b>${escapeHtml(merged.mergedFrom.join('</b>, <b>'))}</b> → <b>${escapeHtml(merged.name)}</b></span>`;
    } else {
      mergeBox.style.display = 'none';
    }
  }

  // ---- network view (keyword co-occurrence / co-authorship) ---------------------------------------------------------

  async function renderNetwork() {
    const token = ++state.networkRenderToken; // this call's id — a later call bumps it again, so a stale async result below can tell it's no longer current
    if (sim) sim.stop();
    const records = state.visible;
    if (records.length === 0) {
      graphCanvas.innerHTML = '<div class="empty-state">Este grafo mostra <b>palavras-chave</b> ou <b>autores</b> que aparecem juntos nos mesmos artigos, ligados quando isso acontece com frequência.<br><br>Analise um corpus na Visão Geral para gerá-lo.</div>';
      state.lastGraphData = null;
      return;
    }
    const density = parseInt($('nodeDensity').value, 10);
    const repulsion = parseInt($('repulsion').value, 10);
    const builders = { authors: buildCoauthorship, coupling: buildCitationCoupling, cocitation: buildCoCitation, keywords: buildCooccurrence };
    const data = builders[state.netMode](records, density);
    if (data.nodes.length === 0) {
      const missing = {
        authors: 'autoria (nenhum artigo com múltiplos autores)',
        coupling: 'referências (só registros da OpenAlex têm essa informação)',
        cocitation: 'referências (só registros da OpenAlex têm essa informação)',
        keywords: 'palavras-chave',
      }[state.netMode];
      graphCanvas.innerHTML = `<div class="empty-state">Nenhum dado de ${missing} disponível neste corpus.</div>`;
      state.lastGraphData = null;
      return;
    }

    // Co-citation nodes are references, not our own corpus, so they need an
    // extra lookup for a readable label — every other mode already has one.
    if (state.netMode === 'cocitation') {
      graphCanvas.innerHTML = '<div class="empty-state">Buscando títulos das referências...</div>';
      const labels = await resolveWorkLabels(data.nodes.map((n) => n.id));
      if (token !== state.networkRenderToken) return; // superseded by a newer render while we were fetching
      for (const n of data.nodes) {
        const info = labels.get(n.id);
        n.label = info ? (info.title.length > 40 ? info.title.slice(0, 37) + '...' : info.title) : 'Referência não encontrada';
        n.count = info ? Math.min(info.citations, 50) : 0;
      }
    }

    state.lastGraphData = data;
    sim = renderGraph(graphCanvas, data, { repulsion });
  }

  // ---- laws view ---------------------------------------------------------

  function lawTable(headers, rows) {
    return `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}`;
  }

  function renderLaws() {
    const records = state.visible;
    const citations = records.map((r) => r.citations || 0);
    $('lawsHIndex').textContent = hIndex(citations);
    $('lawsGIndex').textContent = gIndex(citations);
    $('lawsI10Index').textContent = i10Index(citations);

    if (records.length === 0) {
      const msg = '<div class="empty-state">Analise um corpus para calcular a Lei de Bradford, Lei de Lotka, publicações por ano e ranking de periódicos/países.</div>';
      for (const id of ['chartYear', 'chartLotka']) $(id).innerHTML = msg;
      for (const id of ['tableBradford', 'tableJournals', 'tableCountries', 'tableTrends']) $(id).innerHTML = `<tr><td>${msg}</td></tr>`;
      return;
    }

    renderBarChart($('chartYear'), publicationsPerYear(records), { xKey: 'year', yKey: 'count', color: '#0035C1' });
    renderBarChart($('chartLotka'), lotkaDistribution(records), { xKey: 'n', yKey: 'authors', color: '#00B4D8', series: 'expected' });

    const bradfordRows = bradfordZones(records)
      .slice(0, 30)
      .map(
        (r) => `<tr><td>${r.rank}</td><td>${escapeHtml(r.venue)}</td><td>${r.count}</td><td><span class="zone-badge zone-${r.zone}">Zona ${r.zone}</span></td></tr>`
      );
    $('tableBradford').innerHTML = lawTable(['#', 'Periódico', 'Artigos', 'Zona'], bradfordRows);

    const journalRows = journalRanking(records)
      .slice(0, 30)
      .map((r) => `<tr><td>${escapeHtml(r.venue)}</td><td>${r.articles}</td><td>${r.citations}</td></tr>`);
    $('tableJournals').innerHTML = lawTable(['Periódico', 'Artigos', 'Citações'], journalRows);

    const countries = countryRanking(records).slice(0, 30);
    const countryRows = countries.map((r) => {
      let name = r.country;
      try { name = countryNames.of(r.country) || r.country; } catch { /* unrecognized region code — show raw */ }
      return `<tr><td>${escapeHtml(name)}</td><td>${r.articles}</td><td>${r.citations}</td></tr>`;
    });
    $('tableCountries').innerHTML = countries.length
      ? lawTable(['País', 'Artigos', 'Citações'], countryRows)
      : '<tr><td style="color: var(--text-muted); padding: 8px 0;">Sem dados de país no corpus atual.</td></tr>';

    const trends = keywordTrends(records, 15);
    const trendRows = trends.map((t) => {
      const arrow = t.delta > 0 ? '↑' : t.delta < 0 ? '↓' : '→';
      const color = t.delta > 0 ? 'var(--brand-blue)' : t.delta < 0 ? 'var(--text-muted)' : 'var(--text-dark)';
      const sign = t.delta > 0 ? '+' : '';
      return `<tr><td>${escapeHtml(t.keyword)}</td><td>${t.recent}</td><td>${t.older}</td><td style="color:${color}; font-weight:800;">${arrow} ${sign}${t.delta}</td></tr>`;
    });
    $('tableTrends').innerHTML = trends.length
      ? lawTable(['Palavra-chave', 'Recentes', 'Anteriores', 'Variação'], trendRows)
      : '<tr><td style="color: var(--text-muted); padding: 8px 0;">Sem palavras-chave suficientes para calcular tendência.</td></tr>';
  }

  // ---- view switching ---------------------------------------------------------

  // Renders whichever sub-tab is active within "Análises" (network/laws
  // both need their container visible to size D3/charts correctly; the
  // authors sub-tab needs no special call — renderAuthors already runs
  // unconditionally in renderAll()).
  function renderCurrentView() {
    if (state.activeView !== 'analyses') return;
    if (state.activeAnalysisTab === 'network') renderNetwork();
    else if (state.activeAnalysisTab === 'laws') renderLaws();
  }

  function switchView(view) {
    state.activeView = view;
    document.querySelectorAll('.view').forEach((v) => (v.style.display = v.id === `view-${view}` ? '' : 'none'));
    document.querySelectorAll('.nav-item').forEach((li) => li.classList.remove('active'));
    document.querySelector(`.nav-item a[data-view="${view}"]`).closest('.nav-item').classList.add('active');
    // Metodologias is pure reference content — nothing there to search or filter.
    $('heroSearch').style.display = view === 'methodology' ? 'none' : '';
    renderCurrentView();
  }

  function switchAnalysisTab(tab) {
    state.activeAnalysisTab = tab;
    document.querySelectorAll('.analysis-tab').forEach((el) => (el.style.display = el.id === `tab-${tab}` ? '' : 'none'));
    document.querySelectorAll('.analysis-tabs .pill').forEach((p) => {
      const isActive = p.dataset.analysisTab === tab;
      p.classList.toggle('active', isActive);
      p.setAttribute('aria-pressed', isActive);
    });
    renderCurrentView();
  }

  // Recomputes state.visible (year cut + optional author drill-down) and
  // re-renders everything that depends on it. The author ranking itself
  // stays on state.filtered so a different author can still be picked.
  function renderAll() {
    if (state.authorFilter) {
      const canon = canonicalNameMap(state.filtered.flatMap((r) => r.authors || []));
      state.visible = state.filtered.filter((r) => (r.authors || []).some((a) => (canon.get(a) || a) === state.authorFilter));
    } else {
      state.visible = state.filtered;
    }

    const chip = $('authorFilterBar');
    if (state.authorFilter) {
      chip.style.display = 'flex';
      $('authorFilterName').textContent = state.authorFilter;
    } else {
      chip.style.display = 'none';
    }

    renderMetrics(state.visible);
    renderArticleList(state.visible);
    renderAuthors(state.filtered);
    renderCurrentView();
  }

  // ---- year filter ---------------------------------------------------------
  // Custom decade -> year picker (Google Calendar-style drill-down), not a
  // native date input — records only carry a year, so day/month never
  // applied, and bounding "De" to the earliest year already loaded made it
  // impossible to ask for anything further back. Blank means unbounded.
  // The hidden inputs keep the exact same "YYYY-01-01"/"YYYY-12-31" value
  // format the rest of the app (save/load project, methodology text) already
  // reads via yearOf() — only the input method changed, not the storage.

  function yearOf(dateInputValue) {
    return dateInputValue ? parseInt(dateInputValue.slice(0, 4), 10) : null;
  }

  // A fixed wide default (not derived from whatever the last search
  // happened to return) — 1900 comfortably predates any real bibliometric
  // corpus, and "current year" instead of a hardcoded year keeps this
  // correct without a yearly edit.
  function defaultYearBounds() {
    return { min: 1900, max: new Date().getFullYear() };
  }

  // field: 'From' | 'To'. year: a number, or null/'' to clear ("no limit").
  function setYearField(field, year) {
    $(`year${field}Input`).value = year ? `${year}-${field === 'From' ? '01-01' : '12-31'}` : '';
    $(`year${field}Display`).textContent = year || 'Qualquer ano';
  }

  // Sets both De/Até. Pass {from, to} as years to restore a specific
  // selection; omitted, defaults to 1900–current year (still just a
  // starting point — pickers stay free to pick anything, including
  // clearing for "no limit").
  function setYearRange({ from, to } = {}) {
    const bounds = defaultYearBounds();
    setYearField('From', from ?? bounds.min);
    setYearField('To', to ?? bounds.max);
  }

  function resetTimeRange() {
    setYearRange();
  }

  function applyYearFilter() {
    let from = yearOf($('yearFromInput').value) ?? -Infinity;
    let to = yearOf($('yearToInput').value) ?? Infinity;
    if (from > to) { to = from; setYearField('To', from); }

    $('yearFromLabel').textContent = Number.isFinite(from) ? from : 'o início';
    $('yearToLabel').textContent = Number.isFinite(to) ? to : 'hoje';
    state.filtered = state.records.filter((r) => !r.year || (r.year >= from && r.year <= to));
    renderAll();
  }

  // Decade grid, then year grid within the chosen decade — two levels only,
  // since that's all a year-only value needs. Native <button> cells mean
  // Tab/Enter/Space already work without extra keyboard wiring.
  function createYearPicker({ trigger, popover, field }) {
    let mode = 'decade';
    let currentDecade = null;

    function currentYear() {
      return yearOf($(`year${field}Input`).value);
    }

    function render() {
      const selected = currentYear();
      if (mode === 'decade') {
        const decades = decadesInRange(1900, new Date().getFullYear());
        popover.innerHTML = `
          <div class="year-picker-grid">
            ${decades.map((d) => {
              const isSelected = selected != null && selected >= d && selected < d + 10;
              return `<button type="button" class="year-picker-cell${isSelected ? ' selected' : ''}" data-decade="${d}">${d}s</button>`;
            }).join('')}
          </div>
          <button type="button" class="year-picker-clear">Limpar (sem limite)</button>`;
      } else {
        const years = yearsInDecade(currentDecade);
        popover.innerHTML = `
          <button type="button" class="year-picker-back">‹ Décadas</button>
          <div class="year-picker-grid">
            ${years.map((y) => `<button type="button" class="year-picker-cell${y === selected ? ' selected' : ''}" data-year="${y}">${y}</button>`).join('')}
          </div>
          <button type="button" class="year-picker-clear">Limpar (sem limite)</button>`;
      }
    }

    function open() {
      // Always starts at the decade grid — that's the requested navigation
      // (décadas -> anos). The value is pre-filled by default (1900/current
      // year), so "jump straight to its decade" would skip decade view on
      // literally every first open; the current decade is highlighted
      // instead (see render()), which points it out without skipping it.
      mode = 'decade';
      currentDecade = null;
      render();
      const rect = trigger.getBoundingClientRect();
      popover.style.top = `${rect.bottom + 6}px`;
      popover.style.left = `${rect.left}px`;
      popover.style.display = 'block';
      trigger.setAttribute('aria-expanded', 'true');
    }
    function close() {
      popover.style.display = 'none';
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popover.style.display === 'none') open(); else close();
    });

    popover.addEventListener('click', (e) => {
      const decadeBtn = e.target.closest('[data-decade]');
      const yearBtn = e.target.closest('[data-year]');
      const backBtn = e.target.closest('.year-picker-back');
      const clearBtn = e.target.closest('.year-picker-clear');
      if (decadeBtn) {
        currentDecade = parseInt(decadeBtn.dataset.decade, 10);
        mode = 'year';
        render();
      } else if (backBtn) {
        mode = 'decade';
        render();
      } else if (yearBtn) {
        setYearField(field, parseInt(yearBtn.dataset.year, 10));
        applyYearFilter();
        close();
        trigger.focus();
      } else if (clearBtn) {
        setYearField(field, null);
        applyYearFilter();
        close();
        trigger.focus();
      }
    });

    // On document, not popover: right after opening, focus is still on
    // `trigger` (a sibling of popover, not an ancestor of it), so Escape
    // pressed there would never bubble through a popover-scoped listener.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popover.style.display !== 'none') { close(); trigger.focus(); }
    });

    document.addEventListener('click', (e) => {
      if (popover.style.display === 'none') return;
      // composedPath() is captured at dispatch time, before any listener
      // runs — popover.contains(e.target) would break here, because the
      // popover's own click handler (above) replaces its innerHTML to
      // switch decade/year view, which detaches e.target from the DOM
      // *before* this bubbles up to document, making contains() wrongly
      // say "outside" and close the popover the instant you drill in.
      const path = e.composedPath();
      if (!path.includes(popover) && !path.includes(trigger)) close();
    });
  }

  // ---- methodology text ---------------------------------------------------------

  function buildMethodText() {
    const query = $('searchInput').value.trim();
    const repos = [...document.querySelectorAll('.pill.active[data-repo]')].map((p) => p.dataset.repo);
    const yearFrom = yearOf($('yearFromInput').value) ?? 'o início';
    const yearTo = yearOf($('yearToInput').value) ?? 'hoje';
    const records = state.visible;
    const totalCitations = records.reduce((sum, r) => sum + (r.citations || 0), 0);

    const fieldLabel = $('searchField').value === 'author' ? 'busca por nome de autor' : 'busca por termo geral';
    return `A coleta de dados bibliométricos foi realizada utilizando a plataforma Preá Pesquisa. A busca (${fieldLabel}) contemplou os termos "${query}" nas bases ativas (${repos.join(', ') || 'nenhuma'}) no período de ${yearFrom} a ${yearTo}. Após o processo de de-duplicação e unificação de autores, obteve-se um corpus de ${records.length} artigos e ${totalCitations} citações acumuladas. A análise de coocorrência e as leis bibliométricas (Bradford, Lotka) foram calculadas dinamicamente a partir dos registros.`;
  }

  // ---- search / API ---------------------------------------------------------

  async function runAnalysis() {
    const query = $('searchInput').value.trim();
    if (!query) { $('searchInput').focus(); return; }

    if (state.records.length > 0) {
      const ok = confirm(
        `Isso vai substituir os ${state.records.length} artigos já carregados por esta nova busca.\n\nPara adicionar sem substituir, cancele e use "Importar Arquivo" abaixo da busca. Continuar?`
      );
      if (!ok) return;
    }

    const activePills = [...document.querySelectorAll('.pill.active[data-repo]')];
    const activeRepos = activePills.map((p) => p.dataset.repo);

    const btn = $('btnAnalyze');
    btn.disabled = true;
    $('analyzeSpinner').style.display = 'inline-block';
    $('analyzeLabel').textContent = 'Buscando...';
    $('analyzeArrow').style.display = 'none';

    try {
      const perSource = parseInt($('resultsPerSource').value, 10);
      const field = $('searchField').value;
      const searchableRepos = activeRepos.filter((r) => API_SEARCHERS[r]);
      const jobs = searchableRepos.map((r) => API_SEARCHERS[r](query, { perSource, field }));

      const noApiRepos = activeRepos.filter((r) => !API_SEARCHERS[r]);
      if (noApiRepos.length > 0) {
        alert(`${noApiRepos.join(', ')}: sem API de busca aberta disponível (assinatura institucional ou chave própria). Use "Importar Arquivo" para incluir exports dessas bases.`);
      }
      if (jobs.length === 0 && noApiRepos.length === activeRepos.length) return;

      // One source being slow, rate-limited or unreachable shouldn't blank
      // out results the others already got back — settle each independently
      // and only complain about the ones that actually failed.
      const settled = await Promise.allSettled(jobs);
      const failedRepos = settled.flatMap((s, i) => (s.status === 'rejected' ? [searchableRepos[i]] : []));
      if (failedRepos.length > 0) {
        alert(`Não foi possível buscar em: ${failedRepos.join(', ')}. Os resultados abaixo são das demais fontes.`);
      }
      const newRecords = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));

      // A new search replaces the corpus — editing the keywords and
      // re-running should show results for the new query, not the old
      // results with a few new ones mixed in. (Dedup here still matters:
      // the same paper can come back from both OpenAlex and Crossref.)
      const seen = new Set();
      state.records = newRecords.filter((r) => {
        const key = recordKey(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      state.authorFilter = null;
      state.searchAttempted = true;
      resetTimeRange();
      applyYearFilter();
    } catch (err) {
      alert(`Falha na busca: ${err.message}`);
    } finally {
      btn.disabled = false;
      $('analyzeSpinner').style.display = 'none';
      $('analyzeLabel').textContent = 'Analisar Corpus';
      $('analyzeArrow').style.display = '';
    }
  }

  // ---- file import ---------------------------------------------------------

  function parseByExtension(name, text) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'bib') return parseBibTeX(text);
    if (ext === 'ris') return parseRIS(text);
    if (ext === 'csv' || ext === 'txt') return parseCSV(text);
    return [];
  }

  function importFiles(fileList) {
    const seen = new Set(state.records.map(recordKey));
    let pending = fileList.length;
    let added = 0;
    for (const file of fileList) {
      const reader = new FileReader();
      reader.onload = () => {
        const records = parseByExtension(file.name, reader.result);
        for (const r of records) {
          const key = recordKey(r);
          if (!seen.has(key)) { seen.add(key); state.records.push(r); added++; }
        }
        if (--pending === 0) {
          if (added === 0) alert('Nenhum registro reconhecido nos arquivos selecionados. Verifique se a extensão (.bib/.ris/.csv) corresponde ao formato do conteúdo.');
          // Import adds to the existing corpus — the year fields are
          // unbounded now, so the current selection just keeps working.
          applyYearFilter();
        }
      };
      reader.readAsText(file);
    }
  }

  // ---- export ---------------------------------------------------------

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Rasterizes the current network SVG to PNG via an offscreen <canvas> —
  // no image library needed, the browser's own SVG renderer does the work.
  function exportGraphPng(svg, filename) {
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    const svgUrl = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' }));

    const img = new Image();
    img.onerror = (e) => { console.error('PNG export: failed to rasterize SVG', e); URL.revokeObjectURL(svgUrl); };
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FAFAFC'; // match .graph-canvas background so it isn't transparent/black
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob((blob) => {
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(pngUrl);
      }, 'image/png');
    };
    img.src = svgUrl;
  }

  function exportCorpusCsv() {
    const header = ['title', 'authors', 'year', 'citations', 'venue', 'keywords', 'source', 'doi', 'pdfUrl'];
    const rows = state.visible.map((r) =>
      [r.title, (r.authors || []).join('; '), r.year ?? '', r.citations ?? 0, r.venue || '', (r.keywords || []).join('; '), r.source, r.doi, r.pdfUrl || '']
        .map(csvEscape)
        .join(',')
    );
    download('prea-pesquisa-corpus.csv', [header.join(','), ...rows].join('\n'), 'text/csv');
  }

  function exportTableCsv(table, filename) {
    const rows = [...table.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((cell) => csvEscape(cell.textContent.trim())).join(',')
    );
    download(filename, rows.join('\n'), 'text/csv');
  }

  // Every artifact the app can currently produce (corpus, network, charts,
  // law tables), each with the export formats that actually make sense for
  // it — a table only ever needs CSV, an SVG chart can also rasterize to
  // PNG. Only listed when there's real data to export, so the menu doubles
  // as an at-a-glance "what has been generated so far".
  function exportMenuItems() {
    const items = [];
    if (state.visible.length > 0) {
      items.push({ group: 'Corpus', label: 'Tabela de artigos (CSV)', action: exportCorpusCsv });
    }

    const netSvg = graphCanvas.querySelector('svg');
    if (netSvg && state.lastGraphData) {
      const base = `prea-pesquisa-rede-${state.netMode}`;
      items.push({ group: 'Rede de Relações', label: 'Imagem (SVG)', action: () => download(`${base}.svg`, netSvg.outerHTML, 'image/svg+xml') });
      items.push({ group: 'Rede de Relações', label: 'Imagem (PNG)', action: () => exportGraphPng(netSvg, `${base}.png`) });
      items.push({ group: 'Rede de Relações', label: 'Dados (GraphML)', action: () => download(`${base}.graphml`, buildGraphML(state.lastGraphData.nodes, state.lastGraphData.links), 'application/xml') });
    }

    const yearSvg = $('chartYear').querySelector('svg');
    if (yearSvg) {
      items.push({ group: 'Publicações por Ano', label: 'Imagem (SVG)', action: () => download('prea-pesquisa-publicacoes-por-ano.svg', yearSvg.outerHTML, 'image/svg+xml') });
      items.push({ group: 'Publicações por Ano', label: 'Imagem (PNG)', action: () => exportGraphPng(yearSvg, 'prea-pesquisa-publicacoes-por-ano.png') });
    }

    const lotkaSvg = $('chartLotka').querySelector('svg');
    if (lotkaSvg) {
      items.push({ group: 'Lei de Lotka', label: 'Imagem (SVG)', action: () => download('prea-pesquisa-lotka.svg', lotkaSvg.outerHTML, 'image/svg+xml') });
      items.push({ group: 'Lei de Lotka', label: 'Imagem (PNG)', action: () => exportGraphPng(lotkaSvg, 'prea-pesquisa-lotka.png') });
    }

    const tables = [
      ['tableBradford', 'Lei de Bradford', 'prea-pesquisa-bradford.csv'],
      ['tableJournals', 'Ranking de Periódicos', 'prea-pesquisa-periodicos.csv'],
      ['tableCountries', 'Produção por País', 'prea-pesquisa-paises.csv'],
      ['tableTrends', 'Palavras-chave em Tendência', 'prea-pesquisa-tendencias.csv'],
    ];
    for (const [id, group, filename] of tables) {
      const table = $(id);
      if (table.querySelectorAll('tr').length > 1) {
        items.push({ group, label: 'Tabela (CSV)', action: () => exportTableCsv(table, filename) });
      }
    }

    return items;
  }

  function createExportMenu({ trigger, popover }) {
    function render() {
      const items = exportMenuItems();
      popover._items = items;
      if (items.length === 0) {
        popover.innerHTML = '<div class="export-menu-empty">Nada para exportar ainda — analise um corpus primeiro.</div>';
        return;
      }
      const groups = [...new Set(items.map((i) => i.group))];
      popover.innerHTML = groups.map((g) => `
        <div class="export-menu-group">
          <div class="export-menu-group-title">${g}</div>
          ${items.map((item, idx) => (item.group === g ? `<button type="button" class="export-menu-item" data-idx="${idx}">${item.label}</button>` : '')).join('')}
        </div>`).join('');
    }

    function open() {
      render();
      const rect = trigger.getBoundingClientRect();
      popover.style.top = `${rect.top}px`;
      popover.style.left = `${rect.right + 8}px`;
      popover.style.display = 'block';
      trigger.setAttribute('aria-expanded', 'true');
    }
    function close() {
      popover.style.display = 'none';
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popover.style.display === 'none') open(); else close();
    });

    popover.addEventListener('click', (e) => {
      const btn = e.target.closest('.export-menu-item');
      if (!btn) return;
      popover._items[parseInt(btn.dataset.idx, 10)].action();
      close();
      trigger.focus();
    });

    // Same composedPath()/document-level approach as the year picker (see
    // createYearPicker): outside-click and Escape both need to survive the
    // innerHTML swap in render(), which contains()-based checks don't.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popover.style.display !== 'none') { close(); trigger.focus(); }
    });
    document.addEventListener('click', (e) => {
      if (popover.style.display === 'none') return;
      const path = e.composedPath();
      if (!path.includes(popover) && !path.includes(trigger)) close();
    });
  }

  // ---- project save/load ---------------------------------------------------------
  // Round-trips the full record shape (keywords, abstract, institutions, ...) as
  // JSON — unlike the CSV export, which flattens arrays and is meant for external
  // tools, this is meant to resume work in this app without re-fetching the APIs.

  function saveProject() {
    if (state.records.length === 0) { alert('Nenhum dado para salvar.'); return; }
    const project = {
      version: 2,
      query: $('searchInput').value,
      activeRepos: [...document.querySelectorAll('.pill.active[data-repo]')].map((p) => p.dataset.repo),
      yearFrom: yearOf($('yearFromInput').value),
      yearTo: yearOf($('yearToInput').value),
      records: state.records,
    };
    download('prea-pesquisa-projeto.json', JSON.stringify(project), 'application/json');
  }

  function loadProject(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let project;
      try { project = JSON.parse(reader.result); } catch { alert('Arquivo de projeto inválido (JSON malformado).'); return; }
      if (!Array.isArray(project.records)) { alert('Arquivo de projeto inválido (sem registros).'); return; }

      state.records = project.records;
      state.authorFilter = null;
      if (typeof project.query === 'string') $('searchInput').value = project.query;
      if (Array.isArray(project.activeRepos)) {
        document.querySelectorAll('.pill[data-repo]').forEach((p) => {
          p.classList.toggle('active', project.activeRepos.includes(p.dataset.repo));
        });
      }
      // v1 project files only had a single cutoff year; v2 has a real range.
      if (project.yearFrom || project.yearTo) setYearRange({ from: project.yearFrom, to: project.yearTo });
      else if (project.year) setYearRange({ to: project.year });
      else resetTimeRange();
      applyYearFilter();
    };
    reader.readAsText(file);
  }

  // ---- wiring ---------------------------------------------------------

  // Plain <div class="pill"> elements aren't natively focusable or
  // keyboard-activatable — this makes them behave like a <button> for
  // keyboard users without changing how they look or are styled.
  function makePillAccessible(el) {
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  }

  // arXiv's API sends no CORS headers, so a real web origin (http/https)
  // gets it blocked outright — it only works from Electron's file:// pages,
  // which don't send a browser Origin header for arXiv to reject. On the
  // web build, treat it like the other no-open-API sources instead of
  // leaving an "active" pill that silently fails on every search.
  if (location.protocol !== 'file:') {
    const arxivPill = document.querySelector('.pill[data-repo="arXiv"]');
    if (arxivPill) {
      arxivPill.classList.remove('active');
      arxivPill.dataset.importOnly = 'true';
      arxivPill.title = 'Bloqueado por CORS ao rodar como site (funciona no aplicativo desktop) — clique para ver como importar.';
      $('importOnlyPills').appendChild(arxivPill);

      const row = document.createElement('div');
      row.className = 'import-guide-row';
      row.innerHTML = '<b>arXiv</b><span>Bloqueado nesta versão web (funciona no app desktop) — busque em arxiv.org e exporte o BibTeX de cada artigo</span>';
      document.querySelector('.import-guide-list').prepend(row);
    }
  }

  document.querySelectorAll('.pill[data-repo]').forEach((pill) => {
    makePillAccessible(pill);
    // These four have no open search API — clicking them shows how to get a
    // file from that platform instead of toggling a filter that would never
    // do anything on its own (see the "no open API" note in runAnalysis,
    // which still applies if a loaded project file references one of these).
    if (pill.dataset.importOnly) {
      pill.addEventListener('click', () => { $('importGuideModal').style.display = 'flex'; });
      return;
    }
    pill.setAttribute('aria-pressed', pill.classList.contains('active'));
    pill.addEventListener('click', () => {
      pill.classList.toggle('active');
      pill.setAttribute('aria-pressed', pill.classList.contains('active'));
    });
  });

  document.querySelectorAll('.nav-item a[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); switchView(a.dataset.view); });
  });

  document.querySelectorAll('.analysis-tabs .pill').forEach((p) => {
    makePillAccessible(p);
    p.addEventListener('click', () => switchAnalysisTab(p.dataset.analysisTab));
  });

  $('btnAnalyze').addEventListener('click', runAnalysis);
  $('searchField').addEventListener('change', () => {
    $('searchInput').placeholder = $('searchField').value === 'author' ? 'Ex: Alfredo Marcelo Grigio' : 'Ex: artificial intelligence bibliometrics';
  });
  $('nodeDensity').addEventListener('input', renderNetwork);
  $('repulsion').addEventListener('input', renderNetwork);
  $('btnResetGraph').addEventListener('click', () => {
    $('nodeDensity').value = 50;
    $('repulsion').value = 5;
    renderNetwork();
  });

  document.querySelectorAll('#tab-network [data-mode]').forEach((pill) => {
    makePillAccessible(pill);
    pill.setAttribute('aria-pressed', pill.classList.contains('active'));
    pill.addEventListener('click', () => {
      state.netMode = pill.dataset.mode;
      document.querySelectorAll('#tab-network [data-mode]').forEach((p) => {
        const isActive = p === pill;
        p.classList.toggle('active', isActive);
        p.setAttribute('aria-pressed', isActive);
      });
      renderNetwork();
    });
  });

  createYearPicker({ trigger: $('yearFromTrigger'), popover: $('yearFromPopover'), field: 'From' });
  createYearPicker({ trigger: $('yearToTrigger'), popover: $('yearToPopover'), field: 'To' });

  $('articleSort').addEventListener('change', () => renderArticleList(state.visible));

  function toggleAuthorFilterFromRow(row) {
    if (!row) return;
    state.authorFilter = state.authorFilter === row.dataset.author ? null : row.dataset.author;
    renderAll();
  }
  document.querySelectorAll('#authorListPreview, #authorListFull').forEach((el) => {
    el.addEventListener('click', (e) => toggleAuthorFilterFromRow(e.target.closest('.pill-row')));
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.pill-row');
      if (!row) return;
      e.preventDefault();
      toggleAuthorFilterFromRow(row);
    });
  });
  makePillAccessible($('btnClearAuthorFilter'));
  $('btnClearAuthorFilter').addEventListener('click', () => { state.authorFilter = null; renderAll(); });

  $('btnImportFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files.length) importFiles(e.target.files);
    e.target.value = '';
  });

  createExportMenu({ trigger: $('btnExport'), popover: $('exportMenu') });

  $('btnSaveProject').addEventListener('click', saveProject);
  $('btnLoadProject').addEventListener('click', () => $('projectInput').click());
  $('projectInput').addEventListener('change', (e) => {
    if (e.target.files[0]) loadProject(e.target.files[0]);
    e.target.value = '';
  });

  function toggleAbstract(title) {
    if (!title) return;
    const abstract = title.closest('.article-row').querySelector('.abstract');
    if (!abstract) return;
    const expanded = abstract.style.display === 'none';
    abstract.style.display = expanded ? 'block' : 'none';
    title.setAttribute('aria-expanded', String(expanded));
    title.setAttribute('aria-label', expanded ? 'Recolher resumo' : 'Expandir resumo');
  }
  $('articleList').addEventListener('click', (e) => toggleAbstract(e.target.closest('.title')));
  $('articleList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const title = e.target.closest('.title');
    if (!title) return;
    e.preventDefault();
    toggleAbstract(title);
  });

  $('btnMethodology').addEventListener('click', () => {
    $('methodText').value = buildMethodText();
    $('methodModal').style.display = 'flex';
  });
  makePillAccessible($('btnCloseMethod'));
  $('btnCloseMethod').addEventListener('click', () => ($('methodModal').style.display = 'none'));
  $('btnCloseMethod2').addEventListener('click', () => ($('methodModal').style.display = 'none'));
  $('btnCopyMethod').addEventListener('click', () => {
    const el = $('methodText');
    el.select();
    navigator.clipboard.writeText(el.value);
    alert('Texto da Metodologia copiado!');
    $('methodModal').style.display = 'none';
  });

  makePillAccessible($('btnCloseImportGuide'));
  $('btnCloseImportGuide').addEventListener('click', () => ($('importGuideModal').style.display = 'none'));
  $('btnCloseImportGuide2').addEventListener('click', () => ($('importGuideModal').style.display = 'none'));
  $('btnImportFromGuide').addEventListener('click', () => {
    $('importGuideModal').style.display = 'none';
    $('fileInput').click();
  });

  setYearRange();
  applyYearFilter();
})();
