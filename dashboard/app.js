// Launch Radar — the dashboard's rendering code. No network: every figure
// comes from window.RADAR, written by main.ts from the same board as board.json.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="7" class="empty">No data loaded.</td></tr>';
    return;
  }

  var state = { q: '', chain: 'all', category: 'all', tab: 'pre', sort: 'rank', dir: 1, slug: null };

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
      '<td class="num"><strong>' + fmtUsd(r.implied_value_usd) + '</strong></td>' +
      '<td><span class="badge">Pre-token</span>' + (r.on_watchlist ? '<span class="badge watch">Watchlist</span>' : '') + '</td>' +
      '</tr>';
  }

  function renderBoard() {
    var list = filteredRows();
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + DATA.board_size + ' pre-token protocols' +
      (list.length !== DATA.board_size ? ' — filters active' : '') + '. Click a row for its detail and farm plan.';
    var tbody = document.getElementById('rows');
    tbody.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<tr><td colspan="7" class="empty">No protocol matches these filters.</td></tr>';
    document.getElementById('board-note').textContent =
      'Rank 1 is the board\'s most valuable launch. Implied value follows from TVL, 7-day growth and age — see the model below.';
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
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td></tr>';
    }).join('');
  }

  function renderModel() {
    var m = DATA.model;
    var tiers = m.size_tiers.map(function (t) {
      return '<li>' + (t[0] === 0 ? 'under $50M' : 'TVL ≥ ' + fmtUsd(t[0])) + ' → &times;' + t[1] + '</li>';
    }).join('');
    document.getElementById('model-grid').innerHTML =
      '<div class="model-card"><h3>Size multiple</h3><p>A giant trades at a lower TVL multiple than a small protocol, so the multiple tapers with size:</p><ul>' + tiers + '</ul></div>' +
      '<div class="model-card"><h3>Growth multiplier</h3><p>1 + clamped 7-day growth &times; ' + m.growth_weight + '. Growth is clamped to ' + m.growth_floor + '% … +' + m.growth_cap + '%, so one wild week cannot dominate the board.</p></div>' +
      '<div class="model-card"><h3>Age multiplier</h3><p>' + m.age_floor + ' + min(age, ' + m.age_days_cap + ' days) / ' + m.age_days_cap + ' &times; ' + m.age_range + '. A protocol that has run longer with no token scores higher; no listing date counts as ' + m.unknown_age_days + ' days.</p></div>';
  }

  // ------------------------------------------------------------ detail
  var dialog = document.getElementById('detail');
  function openDetail(slug) {
    var r = DATA.rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    state.slug = slug;
    writeHash();
    var breakdown = fmtUsd(r.tvl_usd) + ' &times; ' + r.size_multiple + ' &times; ' + r.growth_multiplier.toFixed(4) +
      ' &times; ' + r.age_multiplier.toFixed(4) + ' = <strong>' + fmtUsd(r.implied_value_usd) + '</strong>';
    dialog.innerHTML =
      '<div class="detail-head"><div><h2>' + esc(r.name) + '</h2>' +
      '<p class="note">Rank ' + r.rank + ' of ' + DATA.board_size + ' · ' + esc(r.category || 'Other') + ' · ' + esc(r.chains.join(', ')) + '</p></div>' +
      '<button type="button" class="close" id="detail-close">Close</button></div>' +
      '<div class="detail-body">' +
      '<p class="implied-big">' + fmtUsd(r.implied_value_usd) + ' <span style="font-size:14px;color:var(--muted);font-weight:400">implied value</span></p>' +
      '<p class="note">' + breakdown + '</p>' +
      '<dl class="facts">' +
      '<div class="fact"><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>' +
      '<div class="fact"><dt>7-day change</dt><dd class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</dd></div>' +
      '<div class="fact"><dt>Age</dt><dd>' + fmtAge(r.age_days) + '</dd></div>' +
      '<div class="fact"><dt>Listed</dt><dd>' + esc(r.listed_at || '—') + '</dd></div>' +
      '<div class="fact"><dt>Watchlist</dt><dd>' + (r.on_watchlist ? 'Yes' : 'No') + '</dd></div>' +
      '</dl>' +
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
    if (pre) renderBoard();
    else renderLive();
  }

  document.getElementById('tab-pre').addEventListener('click', function () { state.tab = 'pre'; writeHash(); render(); });
  document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); render(); });
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; writeHash(); renderBoard(); });
  document.getElementById('clear').addEventListener('click', function () {
    state.q = ''; state.chain = 'all'; state.category = 'all'; renderFilters(); writeHash(); renderBoard();
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
  renderStats();
  renderFilters();
  renderModel();
  render();
  if (state.slug && state.tab === 'pre') openDetail(state.slug);
})();
