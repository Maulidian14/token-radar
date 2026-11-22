// Launch Radar — the dashboard's rendering code. No network: every figure
// comes from window.RADAR, written by main.ts from the same board as board.json.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="9" class="empty">No data loaded.</td></tr>';
    return;
  }

  var state = { q: '', chain: 'all', category: 'all', cls: 'launch', verdict: 'all', tab: 'pre', sort: 'rank', dir: 1, slug: null };

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
  function fmtOdds(n) {
    if (n === null || n === undefined) return '—';
    return Math.round(n * 100) + '%';
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
  function verdictLabel(v) {
    return { farm: 'Farm', watch: 'Watch', skip: 'Skip', yield: 'Yield' }[v] || v;
  }

  // ------------------------------------------------------------ hash state
  function readHash() {
    var h = new URLSearchParams(window.location.hash.slice(1));
    state.q = h.get('q') || '';
    state.chain = h.get('chain') || 'all';
    state.category = h.get('cat') || 'all';
    state.cls = h.get('cls') === 'all' || h.get('cls') === 'derivative' ? h.get('cls') : 'launch';
    state.verdict = ['farm', 'watch', 'skip', 'yield'].indexOf(h.get('verdict')) >= 0 ? h.get('verdict') : 'all';
    state.tab = h.get('tab') === 'live' ? 'live' : 'pre';
    state.sort = h.get('sort') || 'rank';
    state.dir = h.get('dir') === 'desc' ? -1 : 1;
    state.slug = h.get('slug') || null;
  }
  function writeHash() {
    var h = new URLSearchParams();
    if (state.q) h.set('q', state.q);
    if (state.chain !== 'all') h.set('chain', state.chain);
    if (state.category !== 'all') h.set('cat', state.category);
    if (state.cls !== 'launch') h.set('cls', state.cls);
    if (state.verdict !== 'all') h.set('verdict', state.verdict);
    if (state.tab !== 'pre') h.set('tab', state.tab);
    if (state.sort !== 'rank') h.set('sort', state.sort);
    if (state.dir === -1) h.set('dir', 'desc');
    if (state.slug) h.set('slug', state.slug);
    var next = h.toString();
    history.replaceState(null, '', next ? '#' + next : window.location.pathname);
  }

  // ------------------------------------------------------------ filtering
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.cls !== 'all' && r.board_class !== state.cls) return false;
      if (state.verdict !== 'all' && r.farm_verdict !== state.verdict) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
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

  // ------------------------------------------------------------ rendering
  function renderStats() {
    document.getElementById('stats').innerHTML =
      '<div><dt>Board rows</dt><dd>' + DATA.board_size + '</dd></div>' +
      '<div><dt>Watchlist</dt><dd>' + DATA.watchlist_size + '</dd></div>' +
      '<div><dt>Live tokens</dt><dd>' + DATA.live_size + '</dd></div>' +
      '<div><dt>Snapshot</dt><dd>' + esc(DATA.as_of) + '</dd></div>';
    document.getElementById('source-note').textContent =
      'Snapshot: ' + DATA.source + '. Model ' + DATA.model_version + '. ' +
      'Implied values are estimates from the snapshot, not prices.';
  }

  function renderKpis() {
    var wf = DATA.calibration.walk_forward;
    var odds = DATA.calibration.odds;
    var launches = DATA.rows.filter(function (r) { return r.board_class === 'launch'; }).length;
    var farms = DATA.rows.filter(function (r) { return r.farm_verdict === 'farm'; }).length;
    var movers = DATA.top_movers.map(function (m) {
      return '<li><a href="#slug=' + esc(m.slug) + '" data-mover="' + esc(m.slug) + '">' + esc(m.name) + '</a> <span class="pos">' + fmtPct(m.change_7d) + '</span> <span class="note">rank ' + m.rank + '</span></li>';
    }).join('');
    document.getElementById('kpis').innerHTML =
      '<div class="kpi"><h3>Coverage</h3><p class="kpi-big">' + DATA.board_size + ' <span>of ' + DATA.snapshot_size + ' protocols</span></p>' +
      '<p class="note">' + launches + ' launches and ' + (DATA.board_size - launches) + ' derivatives on the board; all ' + DATA.watchlist_size + ' watchlist protocols covered; ' + DATA.live_size + ' live tokens in the Already trading view.</p></div>' +
      '<div class="kpi"><h3>Calibration — held out in time</h3><p class="kpi-big">&times;' + wf.median_factor.toFixed(2) + ' <span>median error</span></p>' +
      '<p class="note">Walk-forward backtest: fitted on earlier-listed live tokens, tested on ' + wf.n + ' later-listed ones. ' + Math.round(wf.within_2x * 100) + '% within 2&times;; rank correlation ' + wf.spearman.toFixed(3) + '.</p></div>' +
      '<div class="kpi"><h3>Launch odds — the peers\' record</h3><p class="kpi-big">' + odds.cross_validation.auc.toFixed(2) + ' <span>AUC, held out</span></p>' +
      '<p class="note">Log-loss ' + odds.cross_validation.log_loss.toFixed(3) + ' against a base-rate ' + odds.base_log_loss.toFixed(3) + ' (' + Math.round(odds.base_rate * 100) + '% of protocols carry a token). ' + farms + ' launches earn a farm verdict.</p></div>' +
      '<div class="kpi"><h3>Top movers — 7-day TVL</h3><ul class="movers">' + movers + '</ul>' +
      '<p class="note">Fastest-growing pre-token protocols this week. Click one to open its detail and farm plan.</p></div>';
    document.querySelectorAll('[data-mover]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        state.cls = 'all';
        document.getElementById('cls').value = 'all';
        writeHash(); renderBoard();
        openDetail(a.getAttribute('data-mover'));
      });
    });
  }

  function renderIntegrity() {
    var ig = DATA.integrity;
    var c = ig.coverage;
    var m = ig.missing;
    var limits = ig.limits.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    document.getElementById('integrity').innerHTML =
      '<h2>Integrity — what this board is built on</h2>' +
      '<dl class="integrity-facts">' +
      '<div><dt>Snapshot</dt><dd>' + esc(ig.snapshot.as_of) + '</dd></div>' +
      '<div><dt>Source</dt><dd>' + esc(ig.snapshot.source.split(' ')[0]) + '</dd></div>' +
      '<div><dt>Floor</dt><dd>' + fmtUsd(ig.snapshot.floor_usd) + ' TVL</dd></div>' +
      '<div><dt>Protocols</dt><dd>' + c.protocols + '</dd></div>' +
      '<div><dt>Pre-token</dt><dd>' + c.pre_token + '</dd></div>' +
      '<div><dt>Live tokens</dt><dd>' + c.live_token + '</dd></div>' +
      '<div><dt>Token recorded</dt><dd>' + c.token_recorded + '</dd></div>' +
      '<div><dt>Watchlist</dt><dd>' + c.watchlist + ' / ' + c.watchlist + '</dd></div>' +
      '</dl>' +
      '<p class="note">Missing data: ' + m.no_listed_at + ' protocols (' + Math.round(m.share_no_listed_at * 100) + '%) have no listed date, so they count as a year old for the age term and as the snapshot\'s median age for the odds; ' + m.no_change_7d + ' (' + Math.round(m.share_no_change_7d * 100) + '%) have no 7-day change, so they count as flat. The value model is calibrated on ' + ig.calibration_coverage.live_protocols + ' live-token protocols across ' + ig.calibration_coverage.categories_with_adjustment + ' categories; the odds model uses ' + ig.calibration_coverage.odds_features + ' features.</p>' +
      '<ul class="limits">' + limits + '</ul>';
  }

  function renderFilters() {
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains; }))).sort();
    var chainSel = document.getElementById('chain');
    chainSel.innerHTML = '<option value="all">All chains</option>' +
      chains.map(function (c) { return '<option value="' + esc(c) + '"' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var catSel = document.getElementById('category');
    catSel.innerHTML = '<option value="all">All categories</option>' +
      cats.map(function (c) { return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    document.getElementById('q').value = state.q;
  }

  function rowHtml(r) {
    var top = r.rank <= 3 ? ' top' : '';
    return '<tr data-slug="' + esc(r.slug) + '" tabindex="0">' +
      '<td><span class="rank' + top + '">' + r.rank + '</span></td>' +
      '<td class="name">' + esc(r.name) + '<small>' + esc(r.category || 'Other') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</small></td>' +
      '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
      '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="num">' + fmtOdds(r.launch_odds) + '</td>' +
      '<td class="num"><strong>' + fmtUsd(r.implied_value_usd) + '</strong></td>' +
      '<td><span class="badge verdict-' + r.farm_verdict + '">' + verdictLabel(r.farm_verdict) + '</span></td>' +
      '<td><span class="badge">Pre-token</span>' + (r.board_class === 'derivative' ? '<span class="badge deriv">Derivative</span>' : '') + (r.on_watchlist ? '<span class="badge watch">Watchlist</span>' : '') + '</td>' +
      '</tr>';
  }

  function renderBoard() {
    var list = filteredRows();
    var label = state.cls === 'launch' ? 'launches' : state.cls === 'derivative' ? 'derivatives' : 'pre-token protocols';
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + DATA.board_size + ' pre-token protocols (' + label + ')' +
      (list.length !== DATA.board_size ? ' — filters active' : '') + '. Click a row for its detail and farm plan.';
    var tbody = document.getElementById('rows');
    tbody.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<tr><td colspan="9" class="empty">No protocol matches these filters.</td></tr>';
    document.getElementById('board-note').textContent =
      'Rank 1 is the board\'s most valuable row by expected value: the power law\'s gross value times the launch odds from the peers\' record. The odds discount is why an exchange can top the board on size and still sit below its gross value — see the model below.';
    document.querySelectorAll('#board th button').forEach(function (b) {
      b.removeAttribute('aria-sort');
      if (b.getAttribute('data-sort') === state.sort) b.setAttribute('aria-sort', 'true');
    });
  }

  function renderLive() {
    document.getElementById('live-rows').innerHTML = DATA.live.map(function (r) {
      return '<tr><td class="name">' + esc(r.name) + '<small>' + esc(r.chains.slice(0, 3).join(', ')) + '</small></td>' +
        '<td>' + esc(r.category || 'Other') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num"><strong>' + fmtUsd(r.mcap_usd) + '</strong></td>' +
        '<td class="num">&times;' + r.mcap_tvl.toFixed(3) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td></tr>';
    }).join('');
  }

  function renderModel() {
    var m = DATA.model;
    var cal = DATA.calibration;
    var fit = cal.fit;
    var bt = cal.cross_validation;
    var wf = cal.walk_forward;
    var terms = cal.fitted_terms;
    var odds = cal.odds;
    // The effective multiple the fitted power law sets at a few TVLs, so the
    // reader can see the curve fall smoothly instead of stepping at band edges.
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
    // The odds regression's strongest category signals, either way.
    var catCoefs = odds.coefficients.filter(function (c) { return c.feature.indexOf('category:') === 0; });
    var sorted = catCoefs.slice().sort(function (a, b) { return a.coefficient - b.coefficient; });
    var low = sorted.slice(0, 3).map(function (c) { return '<li>' + esc(c.feature.slice(9)) + ': ' + c.coefficient.toFixed(2) + '</li>'; }).join('');
    var high = sorted.slice(-3).reverse().map(function (c) { return '<li>' + esc(c.feature.slice(9)) + ': +' + c.coefficient.toFixed(2) + '</li>'; }).join('');
    var cont = odds.coefficients.filter(function (c) { return ['log_tvl', 'age_days', 'change_7d', 'chains'].indexOf(c.feature) >= 0; });
    var contList = cont.map(function (c) { return '<li>' + esc(c.feature) + ': ' + (c.coefficient >= 0 ? '+' : '') + c.coefficient.toFixed(2) + '</li>'; }).join('');
    document.getElementById('model-grid').innerHTML =
      '<div class="model-card"><h3>Size curve — fitted, not asserted</h3><p>Market cap grows with the square root of TVL across the snapshot\'s own ' + cal.live_n + ' live-token protocols (median market cap ' + Math.round(cal.global_median * 100) + '% of TVL). The line is fitted by Theil-Sen — the median of every pairwise slope, so the few extreme attribution artefacts cannot pull it:</p><p class="formula">log10(mcap) = ' + fit.intercept.toFixed(4) + ' + ' + fit.slope.toFixed(4) + ' &times; log10(TVL)</p><ul>' + curve + '</ul>' +
      '<p class="note">Conservative by design: these are circulating market caps, not fully diluted values, and a launch usually prices above them. No premium is assumed.</p></div>' +
      '<div class="model-card"><h3>Every value term — fitted, tested twice</h3><p>A grid search over ' + (terms.grid.growth_weight.length * terms.grid.age_range.length * terms.grid.category_k.length) + ' combinations picked the growth weight, the age range and the category shrink constant, scored on the mean of two held-out tests of the full model:</p><ul><li>growth weight ' + terms.growth_weight + ' (growth clamped to ' + m.growth_clip.min + '% … +' + m.growth_clip.max + '%)</li><li>age range ' + terms.age_range + ' over ' + m.age_cap_days + ' days, from 0.7</li><li>category shrink k = ' + terms.category_k + '</li><li>mean held-out median log error ' + terms.mean_median_log_err.toFixed(4) + '</li></ul>' +
      '<p>5-fold cross-validation: median &times;' + bt.median_factor.toFixed(2) + ' error on ' + bt.n + ' live tokens, ' + Math.round(bt.within_2x * 100) + '% within 2&times;, rank correlation ' + bt.spearman.toFixed(3) + '. Walk-forward in time: median &times;' + wf.median_factor.toFixed(2) + ' on ' + wf.n + ' later-listed tokens, ' + Math.round(wf.within_2x * 100) + '% within 2&times;, rank correlation ' + wf.spearman.toFixed(3) + '. ' + esc(cal.held_out_note) + '</p></div>' +
      '<div class="model-card"><h3>Launch odds — the peers\' record</h3><p>A ridge logistic regression on whether a protocol\'s record carries a token (' + Math.round(odds.base_rate * 100) + '% of the snapshot does), with category, log TVL, age, 7-day change and chain count. The ridge penalty &lambda; = ' + odds.lambda + ' was picked by 5-fold cross-validation on log-loss. Odds are clipped to ' + Math.round(m.odds_clip.min * 100) + '%–' + Math.round(m.odds_clip.max * 100) + '%: no protocol is ever called a sure thing or a sure miss.</p>' +
      '<p>Validation: 5-fold log-loss ' + odds.cross_validation.log_loss.toFixed(3) + ' (base rate ' + odds.base_log_loss.toFixed(3) + '), AUC ' + odds.cross_validation.auc.toFixed(3) + ' on ' + odds.cross_validation.n + ' protocols. Time-held-out: log-loss ' + odds.walk_forward.log_loss.toFixed(3) + ', AUC ' + odds.walk_forward.auc.toFixed(3) + ' on ' + odds.walk_forward.n + ' later-listed protocols — harder, because later-listed protocols are younger and have had less time to launch.</p>' +
      '<p>Strongest category signals (log-odds):</p><ul><li>Lowest: <ul>' + low + '</ul></li><li>Highest: <ul>' + high + '</ul></li></ul><p>Continuous features:</p><ul>' + contList + '</ul>' +
      '<p class="note">The odds describe the peers\' record; they do not predict whether or when any one protocol issues a token.</p></div>' +
      '<div class="model-card"><h3>Category factor — shrunk</h3><p>Each category\'s median residual from the line, shrunk toward zero by n / (n + ' + terms.category_k + '): a category with many live protocols earns its adjustment, a category with one or two earns almost none. ' + adjNames.length + ' categories carry an adjustment:</p><ul class="adj-list">' + adjList + '</ul></div>' +
      '<div class="model-card"><h3>Farm verdicts — costed</h3><p>Each plan\'s total cost is its capital plus gas for the bridge, the setup, one weekly keep-alive per week of the hold, and the exit; its total time is the hold plus one setup day. A launch is then judged on its expected value per dollar spent, against the other launches on the board: top quarter farm, middle half watch, bottom quarter skip. A derivative gets a yield verdict — there is no launch of its own to value, so the plan is judged on yield.</p></div>' +
      '<div class="model-card"><h3>Growth &amp; age multipliers — fitted</h3><p>Growth: 1 + clamped 7-day growth &times; ' + terms.growth_weight + '. Age: 0.7 + min(age, ' + m.age_cap_days + ' days) / ' + m.age_cap_days + ' &times; ' + terms.age_range + '. No listing date counts as ' + m.unknown_age_days + ' days. Both weights come from the grid search, not from a prior: on their own, growth and age barely correlate with market multiples in this snapshot, so the search is what keeps them honest.</p></div>';
  }

  // ------------------------------------------------------------ detail
  var dialog = document.getElementById('detail');
  function openDetail(slug) {
    var r = DATA.rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    state.slug = slug;
    writeHash();
    var grossLine = fmtUsd(r.tvl_usd) + ' &times; ' + r.size_multiple + ' &times; ' + r.category_factor.toFixed(4) +
      ' &times; ' + r.growth_multiplier.toFixed(4) +
      ' &times; ' + r.age_multiplier.toFixed(4) + ' = <strong>' + fmtUsd(r.gross_implied_value_usd) + '</strong> gross';
    var oddsLine = fmtUsd(r.gross_implied_value_usd) + ' &times; ' + r.launch_odds.toFixed(4) + ' launch odds = <strong>' + fmtUsd(r.implied_value_usd) + '</strong> expected';
    dialog.innerHTML =
      '<div class="detail-head"><div><h2>' + esc(r.name) + '</h2>' +
      '<p class="note">Rank ' + r.rank + ' of ' + DATA.board_size + ' · ' + (r.board_class === 'derivative' ? 'Derivative — a wrapped, staked or bridged product, not a launch of its own' : 'Launch') + ' · ' + esc(r.category || 'Other') + ' · ' + esc(r.chains.join(', ')) + '</p></div>' +
      '<button type="button" class="close" id="detail-close">Close</button></div>' +
      '<div class="detail-body">' +
      '<p class="implied-big">' + fmtUsd(r.implied_value_usd) + ' <span style="font-size:14px;color:var(--muted);font-weight:400">expected value</span></p>' +
      '<p class="note">' + grossLine + '<br>' + oddsLine + '</p>' +
      '<dl class="facts">' +
      '<div class="fact"><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>' +
      '<div class="fact"><dt>7-day change</dt><dd class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</dd></div>' +
      '<div class="fact"><dt>Age</dt><dd>' + fmtAge(r.age_days) + '</dd></div>' +
      '<div class="fact"><dt>Listed</dt><dd>' + esc(r.listed_at || '—') + '</dd></div>' +
      '<div class="fact"><dt>Gross value</dt><dd>' + fmtUsd(r.gross_implied_value_usd) + '</dd></div>' +
      '<div class="fact"><dt>Launch odds</dt><dd>' + fmtOdds(r.launch_odds) + '</dd></div>' +
      '<div class="fact"><dt>Class</dt><dd>' + (r.board_class === 'derivative' ? 'Derivative' : 'Launch') + '</dd></div>' +
      '<div class="fact"><dt>Watchlist</dt><dd>' + (r.on_watchlist ? 'Yes' : 'No') + '</dd></div>' +
      '<div class="fact"><dt>Plan cost</dt><dd>' + fmtUsd(r.farm_total_cost_usd) + '</dd></div>' +
      '</dl>' +
      '<div class="verdict-panel verdict-' + r.farm_verdict + '"><h3>Verdict: ' + verdictLabel(r.farm_verdict).toUpperCase() + '</h3>' +
      '<p>The whole plan costs about ' + fmtUsd(r.farm_total_cost_usd) + ' over ' + r.farm_total_time_days + ' days' +
      (r.board_class === 'launch'
        ? ' for an expected launch value of ' + fmtUsd(r.implied_value_usd) + ' — about ' + fmtUsd(Math.round(r.farm_value_per_cost)) + ' of expected value per dollar spent, judged against the other launches on the board.'
        : ' — and this row has no launch of its own to value, so the plan is judged on yield.') + '</p></div>' +
      '<h3>Farm plan</h3><ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="note">An estimate, not a price. Verify every step on the protocol\'s own site before moving funds.</p>' +
      '</div>';
    document.getElementById('detail-close').addEventListener('click', function () { dialog.close(); });
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener('close', function () {
    if (state.slug) { state.slug = null; writeHash(); }
  });

  // ------------------------------------------------------------ wiring
  function render() {
    var pre = state.tab === 'pre';
    document.getElementById('tab-pre').setAttribute('aria-selected', pre ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-selected', pre ? 'false' : 'true');
    document.getElementById('live').hidden = pre;
    document.querySelector('section[aria-label="Board"]').hidden = !pre;
    document.getElementById('model').hidden = !pre;
    document.getElementById('integrity').hidden = !pre;
    if (pre) renderBoard();
    else renderLive();
  }

  document.getElementById('tab-pre').addEventListener('click', function () { state.tab = 'pre'; writeHash(); render(); });
  document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); render(); });
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('cls').addEventListener('change', function (e) { state.cls = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('clear').addEventListener('click', function () {
    state.q = ''; state.chain = 'all'; state.category = 'all'; state.cls = 'launch'; state.verdict = 'all';
    document.getElementById('cls').value = 'launch';
    document.getElementById('verdict').value = 'all';
    renderFilters(); writeHash(); renderBoard();
  });
  document.querySelectorAll('#board th button').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = 1; }
      writeHash(); renderBoard();
    });
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  document.getElementById('rows').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { e.preventDefault(); openDetail(tr.getAttribute('data-slug')); }
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });

  readHash();
  document.getElementById('cls').value = state.cls;
  document.getElementById('verdict').value = state.verdict;
  renderStats();
  renderKpis();
  renderIntegrity();
  renderFilters();
  renderModel();
  render();
  if (state.slug && state.tab === 'pre') openDetail(state.slug);
})();
