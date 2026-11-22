// Launch Radar v6 — the dashboard's rendering code. No network: every figure
// comes from window.RADAR, written by main.ts from the same board as board.json.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="9" class="empty">No data loaded.</td></tr>';
    return;
  }

  var state = { q: '', chain: 'all', category: 'all', verdict: 'all', watchOnly: false, tab: 'board', sort: 'rank', dir: 1, slug: null };

  function fmtUsd(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return '—';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.floor(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pctClass(n) {
    if (n === null || n === undefined) return '';
    return n >= 0 ? 'pos' : 'neg';
  }

  // ------------------------------------------------------------ hash state
  function readHash() {
    var h = new URLSearchParams(window.location.hash.slice(1));
    state.q = h.get('q') || '';
    state.chain = h.get('chain') || 'all';
    state.category = h.get('cat') || 'all';
    state.verdict = h.get('verdict') === 'farm' || h.get('verdict') === 'watch' ? h.get('verdict') : 'all';
    state.watchOnly = h.get('watch') === '1';
    state.tab = h.get('tab') === 'deriv' || h.get('tab') === 'live' ? h.get('tab') : 'board';
    state.sort = h.get('sort') || 'rank';
    state.dir = h.get('dir') === 'desc' ? -1 : 1;
    state.slug = h.get('slug') || null;
  }
  function writeHash() {
    var h = new URLSearchParams();
    if (state.q) h.set('q', state.q);
    if (state.chain !== 'all') h.set('chain', state.chain);
    if (state.category !== 'all') h.set('cat', state.category);
    if (state.verdict !== 'all') h.set('verdict', state.verdict);
    if (state.watchOnly) h.set('watch', '1');
    if (state.tab !== 'board') h.set('tab', state.tab);
    if (state.sort !== 'rank') h.set('sort', state.sort);
    if (state.dir === -1) h.set('dir', 'desc');
    if (state.slug) h.set('slug', state.slug);
    var next = h.toString();
    history.replaceState(null, '', next ? '#' + next : window.location.pathname);
  }

  // ------------------------------------------------------------ filtering
  function matchesCommon(r) {
    var q = state.q.trim().toLowerCase();
    if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
    if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
    if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
    return true;
  }
  function filteredRows() {
    var list = DATA.rows.filter(function (r) {
      if (!matchesCommon(r)) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.watchOnly && !r.on_watchlist) return false;
      return true;
    });
    // The raw comparison is each key's natural order: rank ascending, name
    // A-Z, numbers largest first. dir flips it (1 natural, -1 reversed).
    var key = state.sort;
    var dir = state.dir;
    list.sort(function (a, b) {
      var d = 0;
      if (key === 'rank') d = a.rank - b.rank;
      else if (key === 'name') d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      else if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'growth') d = (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d);
      else if (key === 'age') d = (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      else if (key === 'odds') d = b.launch_odds - a.launch_odds;
      else if (key === 'value') d = b.implied_value_usd - a.implied_value_usd;
      if (d === 0) d = a.rank - b.rank;
      return d * dir;
    });
    return list;
  }
  function filteredDerivs() {
    return DATA.derivatives.filter(matchesCommon);
  }
  function filteredLive() {
    return DATA.live.filter(matchesCommon);
  }

  // ------------------------------------------------------------ rendering
  function renderStats() {
    document.getElementById('stats').innerHTML =
      '<div><dt>Launch board</dt><dd>' + DATA.board_size + '</dd></div>' +
      '<div><dt>Watchlist</dt><dd>' + DATA.watchlist_size + '</dd></div>' +
      '<div><dt>Already trading</dt><dd>' + DATA.live_size + '</dd></div>' +
      '<div><dt>Snapshot</dt><dd>' + esc(DATA.as_of) + '</dd></div>';
    document.getElementById('source-note').textContent =
      'Snapshot: ' + DATA.source + '. Model ' + DATA.model_version + '. ' +
      'Expected values are estimates from the snapshot, not prices.';
  }

  function renderKpis() {
    var ov = DATA.odds_validation;
    var accounted = DATA.board_size + DATA.derivative_size + DATA.live_size;
    var movers = DATA.top_movers.map(function (m) {
      return '<li><a href="#slug=' + esc(m.slug) + '" data-mover="' + esc(m.slug) + '">' + esc(m.name) + '</a> <span class="pos">' + fmtPct(m.change_7d) + '</span></li>';
    }).join('');
    document.getElementById('kpis').innerHTML =
      '<div class="kpi"><h3>Coverage — every protocol accounted for</h3><p class="kpi-big">' + accounted + ' <span>of ' + DATA.snapshot_size + ' protocols</span></p>' +
      '<p class="note">' + DATA.board_size + ' launch candidates on the board (all ' + DATA.watchlist_size + ' watchlist protocols covered), ' + DATA.derivative_size + ' derivatives in their own view, ' + DATA.live_size + ' already trading. Nothing in the snapshot is missing.</p></div>' +
      '<div class="kpi"><h3>Launch odds — held out in time</h3><p class="kpi-big">' + ov.heldout_log_loss.toFixed(3) + ' <span>log-loss vs ' + ov.base_rate_log_loss.toFixed(3) + ' base rate</span></p>' +
      '<p class="note">Weibull survival model, trained on the earliest-listed 70% and scored on the latest-listed ' + ov.heldout_n + ' protocols. AUC ' + ov.heldout_auc.toFixed(3) + '; shape k = ' + DATA.odds_fit.shape_k.toFixed(2) + ', so the launch hazard falls with age.</p></div>' +
      '<div class="kpi"><h3>Top movers — 7-day TVL</h3><ul class="movers">' + movers + '</ul>' +
      '<p class="note">Fastest-growing pre-token protocols this week. Click one to open its detail and farm plan.</p></div>';
    document.querySelectorAll('[data-mover]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        state.tab = 'board';
        writeHash(); render();
        openDetail(a.getAttribute('data-mover'));
      });
    });
  }

  function renderFilters() {
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains; }).concat(DATA.derivatives.flatMap(function (r) { return r.chains; })))).sort();
    var chainSel = document.getElementById('chain');
    chainSel.innerHTML = '<option value="all">All chains</option>' +
      chains.map(function (c) { return '<option value="' + esc(c) + '"' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }).concat(DATA.derivatives.map(function (r) { return r.category || 'Other'; })))).sort();
    var catSel = document.getElementById('category');
    catSel.innerHTML = '<option value="all">All categories</option>' +
      cats.map(function (c) { return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    document.getElementById('q').value = state.q;
    document.getElementById('verdict').value = state.verdict;
    document.getElementById('watchlist-only').checked = state.watchOnly;
  }

  function rowHtml(r) {
    var top = r.rank <= 3 ? ' top' : '';
    return '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
      '<td><span class="rank' + top + '">' + r.rank + '</span></td>' +
      '<td class="name">' + esc(r.name) + '<small>' + esc(r.category || 'Other') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</small></td>' +
      '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
      '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="num">' + (r.launch_odds * 100).toFixed(1) + '%</td>' +
      '<td class="num"><strong>' + fmtUsd(r.implied_value_usd) + '</strong></td>' +
      '<td><span class="badge' + (r.verdict === 'farm' ? ' farm' : '') + '">' + (r.verdict === 'farm' ? 'Farm' : 'Watch') + '</span></td>' +
      '<td><span class="badge">Pre-token</span>' + (r.on_watchlist ? '<span class="badge watch">Watchlist</span>' : '') + '</td>' +
      '</tr>';
  }

  function renderBoard() {
    var list = filteredRows();
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + DATA.board_size + ' launch candidates' +
      (list.length !== DATA.board_size ? ' — filters active' : '') + '. Click a row for its detail and farm plan.';
    var tbody = document.getElementById('rows');
    tbody.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<tr><td colspan="9" class="empty">No protocol matches these filters.</td></tr>';
    document.getElementById('board-note').textContent =
      'Rank 1 is the board\'s most valuable launch by expected value: gross implied value times the odds it launches within a year. See the model below for how both are fitted.';
    document.querySelectorAll('#board th button').forEach(function (b) {
      b.removeAttribute('aria-sort');
      if (b.getAttribute('data-sort') === state.sort) b.setAttribute('aria-sort', 'true');
    });
  }

  function renderDerivs() {
    var list = filteredDerivs();
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + DATA.derivative_size + ' derivatives' +
      (list.length !== DATA.derivative_size ? ' — filters active' : '') + '. Click a row for its detail and farm plan.';
    document.getElementById('deriv-rows').innerHTML = list.length
      ? list.map(function (r) {
          return '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
            '<td class="name">' + esc(r.name) + '<small>' + esc(r.chains.slice(0, 3).join(', ')) + '</small></td>' +
            '<td>' + esc(r.category || 'Other') + '</td>' +
            '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
            '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
            '<td class="num">' + fmtAge(r.age_days) + '</td>' +
            '<td class="num"><strong>' + fmtUsd(r.gross_value_usd) + '</strong></td></tr>';
        }).join('')
      : '<tr><td colspan="6" class="empty">No derivative matches these filters.</td></tr>';
  }

  function renderLive() {
    var list = filteredLive();
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + DATA.live_size + ' token-trading protocols' +
      (list.length !== DATA.live_size ? ' — filters active' : '') + '. Click a row for its detail.';
    document.getElementById('live-rows').innerHTML = list.length
      ? list.map(function (r) {
          return '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
            '<td class="name">' + esc(r.name) + '<small>' + esc(r.chains.slice(0, 3).join(', ')) + '</small></td>' +
            '<td>' + esc(r.category || 'Other') + '</td>' +
            '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
            '<td class="num"><strong>' + fmtUsd(r.mcap_usd) + '</strong></td>' +
            '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="empty">No token-trading protocol matches these filters.</td></tr>';
  }

  function renderModel() {
    var m = DATA.model;
    var cal = DATA.calibration;
    var fit = cal.fit;
    var bt = cal.backtest;
    var wf = cal.walkforward;
    var of = DATA.odds_fit;
    var ov = DATA.odds_validation;
    var refs = [5000000000, 1000000000, 250000000, 50000000, 5000000];
    var curve = refs.map(function (tvl) {
      var mult = Math.pow(10, fit.intercept) * Math.pow(tvl, fit.slope - 1);
      return '<li>TVL ' + fmtUsd(tvl) + ' → &times;' + mult.toFixed(4) + '</li>';
    }).join('');
    var adj = cal.category_adjustments;
    var adjNames = Object.keys(adj);
    var adjList = adjNames.map(function (c) {
      return '<li>' + esc(c) + ': &times;' + Math.pow(10, adj[c]).toFixed(3) + '</li>';
    }).join('');
    var effects = Object.keys(of.category_effects).map(function (c) {
      var v = of.category_effects[c];
      return '<li>' + esc(c) + ': ' + (v > 0 ? '+' : '') + v.toFixed(2) + '</li>';
    }).join('');
    document.getElementById('model-grid').innerHTML =
      '<div class="model-card"><h3>Gross value — fitted, not asserted</h3><p>Market cap grows with the square root of TVL across the snapshot\'s own ' + cal.live_count + ' live-token protocols. The line is fitted by Theil-Sen — the median of every pairwise slope, so the few extreme attribution artefacts cannot pull it:</p><p class="formula">log10(mcap) = ' + fit.intercept.toFixed(4) + ' + ' + fit.slope.toFixed(4) + ' &times; log10(TVL)</p><ul>' + curve + '</ul>' +
      '<p class="note">Conservative by design: these are circulating market caps, not fully diluted values, and a launch usually prices above them. No premium is assumed.</p></div>' +
      '<div class="model-card"><h3>Launch odds — Weibull survival</h3><p>A protocol that records a token has launched (its launch time is at most its age); a pre-token protocol has not (its launch time is past its age). The model fits a Weibull time-to-launch with a log-linear scale in TVL, 7-day growth and category. Shape k = ' + of.shape_k.toFixed(2) + ' — below 1, so the launch hazard falls with age: a protocol that has run years with no token is less likely to launch next year than a young one. The odds are P(launch within ' + of.horizon_days + ' days | not launched yet), clipped to ' + Math.round(m.odds_floor * 100) + '%–' + Math.round(m.odds_cap * 100) + '%.</p>' +
      '<p class="note">Validation: time-held-out log-loss ' + ov.heldout_log_loss.toFixed(4) + ' against a base rate of ' + ov.base_rate_log_loss.toFixed(4) + ', AUC ' + ov.heldout_auc.toFixed(3) + ' on ' + ov.heldout_n + ' later-listed protocols; 5-fold CV log-loss ' + ov.cv_log_loss.toFixed(4) + ', AUC ' + ov.cv_auc.toFixed(3) + '.</p></div>' +
      '<div class="model-card"><h3>Category effects on time to launch</h3><p>A positive effect means a longer time to launch (lower odds); a negative one means a shorter time. Fitted from the snapshot, with a ridge penalty of ' + m.odds_lambda + ':</p><ul class="adj-list">' + effects + '</ul>' +
      '<p class="note">Log TVL effect ' + of.log_tvl.toFixed(2) + ', 7-day growth effect ' + of.change_7d.toFixed(2) + ' — both on the log scale, so a negative value shortens the time to launch.</p></div>' +
      '<div class="model-card"><h3>Category factor — shrunk</h3><p>Each category\'s median residual from the gross line, shrunk toward zero by n / (n + ' + m.category_shrink_k + '): a category with many live protocols earns its adjustment, a category with one or two earns almost none. ' + adjNames.length + ' categories carry an adjustment:</p><ul class="adj-list">' + adjList + '</ul></div>' +
      '<div class="model-card"><h3>Backtests — gross value</h3><p>5-fold cross-validation on ' + bt.n + ' live tokens: the median prediction lands within &times;' + bt.median_factor.toFixed(2) + ' of the true market cap, ' + Math.round(bt.within_2x * 100) + '% within 2&times;, rank correlation ' + bt.spearman.toFixed(3) + '. Walk-forward in time on ' + wf.n + ' held-out protocols: median &times;' + wf.median_factor.toFixed(2) + ', ' + Math.round(wf.within_2x * 100) + '% within 2&times;, rank correlation ' + wf.spearman.toFixed(3) + '.</p></div>' +
      '<div class="model-card"><h3>Verdict — farm or watch</h3><p>Farm when the estimated airdrop value per farmer clears ' + m.verdict_multiple + '&times; the plan\'s cost; watch otherwise — never skip. Value per farmer = expected value &times; ' + Math.round(m.farmer_share * 100) + '% farmer share &divide; estimated farmers (25 &times; the square root of TVL in millions, clamped to 100–5000). The plan\'s cost is its deployed capital plus gas for the bridge, setup, weekly actions and exit. Both the 10% share and the farmer count are assumptions, stated as such.</p></div>';
  }

  // ------------------------------------------------------------ detail
  var dialog = document.getElementById('detail');
  function findRow(slug) {
    var r = DATA.rows.find(function (x) { return x.slug === slug; });
    if (r) return { row: r, kind: 'board' };
    var d = DATA.derivatives.find(function (x) { return x.slug === slug; });
    if (d) return { row: d, kind: 'deriv' };
    var l = DATA.live.find(function (x) { return x.slug === slug; });
    if (l) return { row: l, kind: 'live' };
    return null;
  }
  function openDetail(slug) {
    var found = findRow(slug);
    if (!found) return;
    var r = found.row;
    var kind = found.kind;
    state.slug = slug;
    writeHash();
    var head, body;
    if (kind === 'board') {
      var breakdown = fmtUsd(r.tvl_usd) + ' &times; ' + r.size_multiple + ' &times; ' + r.category_factor.toFixed(4) +
        ' &times; ' + r.growth_multiplier.toFixed(4) +
        ' &times; ' + r.age_multiplier.toFixed(4) + ' = <strong>' + fmtUsd(r.gross_value_usd) + '</strong> gross';
      var evLine = fmtUsd(r.gross_value_usd) + ' &times; ' + (r.launch_odds * 100).toFixed(1) + '% odds = <strong>' + fmtUsd(r.implied_value_usd) + '</strong> expected value';
      var verdictLine = 'Verdict <strong>' + (r.verdict === 'farm' ? 'Farm' : 'Watch') + '</strong>: ' + fmtUsd(r.value_per_user_usd) + ' estimated value per farmer (' + fmtUsd(r.implied_value_usd) + ' &times; 10% &divide; ' + r.farmer_count.toLocaleString() + ' farmers) against a $' + r.plan_cost_usd + ' plan cost.';
      head = '<div><h2>' + esc(r.name) + '</h2>' +
        '<p class="note">Rank ' + r.rank + ' of ' + DATA.board_size + ' · Launch · ' + esc(r.category || 'Other') + ' · ' + esc(r.chains.join(', ')) + (r.on_watchlist ? ' · Watchlist' : '') + '</p></div>';
      body =
        '<p class="implied-big">' + fmtUsd(r.implied_value_usd) + ' <span style="font-size:14px;color:var(--muted);font-weight:400">expected value</span></p>' +
        '<p class="note">' + breakdown + '</p>' +
        '<p class="note">' + evLine + '</p>' +
        '<p class="note">' + verdictLine + '</p>' +
        '<dl class="facts">' +
        '<div class="fact"><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>' +
        '<div class="fact"><dt>7-day change</dt><dd class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</dd></div>' +
        '<div class="fact"><dt>Age</dt><dd>' + fmtAge(r.age_days) + '</dd></div>' +
        '<div class="fact"><dt>Listed</dt><dd>' + esc(r.listed_at || '—') + '</dd></div>' +
        '<div class="fact"><dt>Launch odds</dt><dd>' + (r.launch_odds * 100).toFixed(1) + '%</dd></div>' +
        '<div class="fact"><dt>Gross value</dt><dd>' + fmtUsd(r.gross_value_usd) + '</dd></div>' +
        '</dl>' +
        '<h3>Farm plan</h3><ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
        '<p class="note">An estimate, not a price. Verify every step on the protocol\'s own site before moving funds.</p>';
    } else if (kind === 'deriv') {
      head = '<div><h2>' + esc(r.name) + '</h2>' +
        '<p class="note">Derivative — a wrapped, staked or bridged product, not a launch of its own · ' + esc(r.category || 'Other') + ' · ' + esc(r.chains.join(', ')) + '</p></div>';
      body =
        '<p class="implied-big">' + fmtUsd(r.gross_value_usd) + ' <span style="font-size:14px;color:var(--muted);font-weight:400">gross value (not ranked)</span></p>' +
        '<p class="note">This protocol is a product of a token that already trades, so it has no launch of its own and no launch odds. The plan below farms the parent token\'s ecosystem.</p>' +
        '<dl class="facts">' +
        '<div class="fact"><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>' +
        '<div class="fact"><dt>7-day change</dt><dd class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</dd></div>' +
        '<div class="fact"><dt>Age</dt><dd>' + fmtAge(r.age_days) + '</dd></div>' +
        '<div class="fact"><dt>Listed</dt><dd>' + esc(r.listed_at || '—') + '</dd></div>' +
        '</dl>' +
        '<h3>Farm plan</h3><ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
        '<p class="note">An estimate, not a price. Verify every step on the protocol\'s own site before moving funds.</p>';
    } else {
      head = '<div><h2>' + esc(r.name) + '</h2>' +
        '<p class="note">Already trading · ' + esc(r.category || 'Other') + ' · ' + esc(r.chains.join(', ')) + '</p></div>';
      body =
        '<p class="implied-big">' + fmtUsd(r.mcap_usd) + ' <span style="font-size:14px;color:var(--muted);font-weight:400">market cap</span></p>' +
        '<p class="note">This protocol\'s token already trades, so the board does not rank it and there is no farm plan for a launch.</p>' +
        '<dl class="facts">' +
        '<div class="fact"><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>' +
        '<div class="fact"><dt>7-day change</dt><dd class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</dd></div>' +
        '<div class="fact"><dt>Market cap</dt><dd>' + fmtUsd(r.mcap_usd) + '</dd></div>' +
        '</dl>';
    }
    dialog.innerHTML =
      '<div class="detail-head">' + head +
      '<button type="button" class="close" id="detail-close">Close</button></div>' +
      '<div class="detail-body">' + body + '</div>';
    document.getElementById('detail-close').addEventListener('click', function () { dialog.close(); });
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener('close', function () {
    if (state.slug) { state.slug = null; writeHash(); }
  });

  // ------------------------------------------------------------ wiring
  function render() {
    document.getElementById('tab-board').setAttribute('aria-selected', state.tab === 'board' ? 'true' : 'false');
    document.getElementById('tab-deriv').setAttribute('aria-selected', state.tab === 'deriv' ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
    document.getElementById('board-panel').hidden = state.tab !== 'board';
    document.getElementById('deriv-panel').hidden = state.tab !== 'deriv';
    document.getElementById('live-panel').hidden = state.tab !== 'live';
    document.getElementById('model').hidden = state.tab !== 'board';
    if (state.tab === 'board') renderBoard();
    else if (state.tab === 'deriv') renderDerivs();
    else renderLive();
  }

  document.getElementById('tab-board').addEventListener('click', function () { state.tab = 'board'; writeHash(); render(); });
  document.getElementById('tab-deriv').addEventListener('click', function () { state.tab = 'deriv'; writeHash(); render(); });
  document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); render(); });
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; writeHash(); render(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; writeHash(); render(); });
  document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; writeHash(); render(); });
  document.getElementById('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; writeHash(); render(); });
  document.getElementById('watchlist-only').addEventListener('change', function (e) { state.watchOnly = e.target.checked; writeHash(); render(); });
  document.getElementById('clear').addEventListener('click', function () {
    state.q = ''; state.chain = 'all'; state.category = 'all'; state.verdict = 'all'; state.watchOnly = false;
    renderFilters(); writeHash(); render();
  });
  document.querySelectorAll('#board th button').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = 1; }
      writeHash(); renderBoard();
    });
  });
  function rowClick(e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  }
  function rowKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { e.preventDefault(); openDetail(tr.getAttribute('data-slug')); }
  }
  document.getElementById('rows').addEventListener('click', rowClick);
  document.getElementById('rows').addEventListener('keydown', rowKey);
  document.getElementById('deriv-rows').addEventListener('click', rowClick);
  document.getElementById('deriv-rows').addEventListener('keydown', rowKey);
  document.getElementById('live-rows').addEventListener('click', rowClick);
  document.getElementById('live-rows').addEventListener('keydown', rowKey);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });

  readHash();
  renderStats();
  renderKpis();
  renderFilters();
  renderModel();
  render();
  if (state.slug) openDetail(state.slug);
})();
