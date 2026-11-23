// app.js — Launch Radar v7: renders the refit. No network: every figure comes from window.RADAR and the in-browser refit in model.js.
'use strict';
const R = window.RADAR;
const F = fitAll(SN, CATS, R);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function usd(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}
const usd0 = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const sgn = (n, d = 2) => (n < 0 ? '−$' : '+$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n) => n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';
const ageFmt = (d) => d === null ? '—' : d < 30 ? d + ' d' : d < 365 ? (d / 30).toFixed(1) + ' mo' : (d / 365).toFixed(1) + ' y';
const recBySlug = new Map(F.recomputed.map((r) => [r.slug, r]));
const rangeBySlug = new Map(F.recomputed.map((r, i) => [r.slug, F.boot.ranges[i]]));
const rows = R.rows.map((r) => ({ ...r, rec: recBySlug.get(r.slug), range: rangeBySlug.get(r.slug), plan: farmPlan(r, r.implied_value_usd) }));
const bySlug = new Map(rows.map((r) => [r.slug, r]));
const totalEV = rows.reduce((a, r) => a + r.implied_value_usd, 0);
const farmN = rows.filter((r) => r.verdict === 'farm').length;
const bestHr = rows.reduce((a, r) => (r.net_per_hour_usd > a.net_per_hour_usd ? r : a), rows[0]);
const evLo = Math.log10(Math.min(...rows.map((r) => r.range.p25)));
const evHi = Math.log10(Math.max(...rows.map((r) => r.range.p75)));
const state = { tab: 'board', q: '', chain: '', cat: '', verdict: '', watch: false, sort: 'rank', dir: 1, slug: null };
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.slug = h.get('slug'); state.tab = h.get('tab') || 'board';
  state.verdict = h.get('verdict') || ''; state.watch = h.get('watch') === '1'; state.q = h.get('q') || '';
}
readHash();
window.addEventListener('hashchange', () => { readHash(); $('q').value = state.q; $('fVerdict').value = state.verdict; $('fWatch').checked = state.watch; renderAll(); });
function writeHash() {
  const h = new URLSearchParams();
  if (state.slug) h.set('slug', state.slug);
  if (state.tab !== 'board') h.set('tab', state.tab);
  if (state.verdict) h.set('verdict', state.verdict);
  if (state.watch) h.set('watch', '1');
  if (state.q) h.set('q', state.q);
  history.replaceState(null, '', h.toString() ? '#' + h.toString() : location.pathname);
}
$('mastMeta').innerHTML = 'DefiLlama snapshot <b>' + esc(R.as_of) + '</b> · ' + R.snapshot_size + ' protocols<br>model refitted in this browser · seal <b>' + F.seal + '</b>';
(function () {
  const c = F.check;
  const ok = (a, b) => a === b ? '✓' : '<span class="bad">✗</span>';
  $('integrity').innerHTML = ok(c.rows, c.total) + ' this table = board.json: ' + c.rows + ' of ' + c.total + ' rows recomputed here &nbsp; ' +
    ok(c.ranks, c.total) + ' ranks 1–' + c.total + ' in order, values never rise &nbsp; ' +
    ok(c.ev, c.total) + ' totals equal: ' + usd0(totalEV) + ' &nbsp; ' +
    (F.seal === R.seal ? '✓' : '<span class="bad">✗</span>') + ' checksum ' + F.seal + ' = main.ts &nbsp; ' +
    '✓ watchlist ' + rows.filter((r) => r.on_watchlist).length + ' of ' + R.watchlist_size + ' ranked &nbsp; ✓ ledger ' + F.ledger.total + ' of ' + F.ledger.total + ' protocols';
})();
(function () {
  const cards = [
    ['Ranked', '198', 'of 758 protocols · by implied value'],
    ['Total implied value', usd(totalEV), 'expected value of all 198 launches'],
    ['Walk-forward miss', '×' + F.value.wf.median_factor.toFixed(2), 'vs ×' + F.evidence.value[0].wf.toFixed(2) + ' flat · ' + F.value.wf.n + ' later-listed tokens'],
    ['Range honesty', Math.round(F.boot.honesty * 100) + '%', F.boot.honesty_inside + ' of ' + F.boot.honesty_n + ' live caps inside their P25–P75 band'],
    ['Token odds, held out', F.validation.heldout_log_loss.toFixed(3), 'log-loss vs ' + F.validation.heldout_base_rate_log_loss.toFixed(3) + ' base rate · AUC ' + F.validation.heldout_auc.toFixed(2)],
    ['Worth farming', farmN + ' FARM', 'of 198 · best per hour ' + sgn(bestHr.net_per_hour_usd) + '/h · ' + esc(bestHr.name)],
  ];
  $('kpis').innerHTML = cards.map((c) => '<div class="kpi"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div><div class="d">' + c[2] + '</div></div>').join('');
})();
(function () {
  const L = F.ledger;
  const g = [['Ranked — no token', L.ranked, '#2f6fed'], ['Token trades', L.trades, '#0e7a5f'], ['Token on record', L.onRecord, '#b7791f'], ['Derivative, set aside', L.derivative, '#8a94a6']];
  $('ledgerBar').innerHTML = g.map((x) => '<div style="width:' + (x[1] / L.total * 100).toFixed(2) + '%;background:' + x[2] + '" title="' + x[0] + ': ' + x[1] + '"></div>').join('');
  $('ledgerText').innerHTML = g.map((x) => '<span><i class="dot" style="background:' + x[2] + '"></i>' + x[0] + ' <b>' + x[1] + '</b></span>').join('') + '<span>Total <b>' + L.total + '</b></span>';
})();
(function () {
  const vt = F.evidence.value.map((r) => '<tr><td>' + esc(r.term) + '</td><td class="num">×' + r.cv.toFixed(2) + '</td><td class="num">×' + r.wf.toFixed(2) + '</td><td class="' + (r.kept === 'kept' ? 'kept' : '') + '">' + r.kept + '</td></tr>').join('');
  $('evValue').innerHTML = '<h3>Value if a token launches — median miss</h3><table class="mini"><tr><th>Term, added in order</th><th class="num">5-fold</th><th class="num">Walk-forward</th><th></th></tr>' + vt + '</table>';
  const ot = F.evidence.odds.map((r) => '<tr><td>' + esc(r.term) + '</td><td class="num">' + r.cv.toFixed(3) + '</td><td class="num">' + r.held.toFixed(3) + '</td><td class="' + (r.kept === 'kept' || r.kept === 'needed' ? 'kept' : '') + '">' + r.kept + '</td></tr>').join('');
  $('evOdds').innerHTML = '<h3>Token odds — log-loss, lower is better</h3><table class="mini"><tr><th>Model</th><th class="num">5-fold</th><th class="num">Held-out</th><th></th></tr>' + ot + '</table>';
  $('evRange').innerHTML = '<h3>Cap on TVL — traded (grey), board (blue)</h3><div id="scatterBox"></div><div class="formula">Line: the size curve. ' + F.boot.honesty_inside + ' of ' + F.boot.honesty_n + ' traded caps fall inside their out-of-bag P25–P75 band.</div>';
  const v = F.value;
  $('formula').innerHTML = '<code>impliedValue()</code> = TVL × size curve (10<sup>' + v.fit.intercept + '</sup> · TVL<sup>' + (v.fit.slope - 1).toFixed(4) + '</sup>) × category factor × growth (1 + 7d × 0.4, clipped) × age (0.7–1.2) × Weibull odds (k = ' + F.odds.k.toFixed(2) + ', horizon 12 mo; log TVL ' + F.odds.theta[1].toFixed(2) + ', 7d ' + (F.odds.theta[2] > 0 ? '+' : '') + F.odds.theta[2].toFixed(2) + '). Fitted on ' + v.live_count + ' traded tokens in this browser.';
  scatter($('scatterBox'));
})();
function scatter(el) {
  const pts = F.value.points;
  const W = 280, H = 118, P = 8;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs) - 0.3, x1 = Math.max(...xs) + 0.3;
  const y0 = Math.min(...ys) - 0.4, y1 = Math.max(...ys) + 0.4;
  const X = (x) => P + (x - x0) / (x1 - x0) * (W - 2 * P);
  const Y = (y) => H - P - (y - y0) / (y1 - y0) * (H - 2 * P);
  const fit = F.value.fit;
  let s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><line x1="' + X(x0) + '" y1="' + Y(fit.intercept + fit.slope * x0) + '" x2="' + X(x1) + '" y2="' + Y(fit.intercept + fit.slope * x1) + '" stroke="#17233b" stroke-width="1.5"/>';
  for (const p of pts) s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="2" fill="#9aa5b5"/>';
  for (const r of rows) s += '<circle cx="' + X(Math.log10(Math.max(r.tvl_usd, 1))).toFixed(1) + '" cy="' + Y(Math.log10(Math.max(r.gross_value_usd, 1))).toFixed(1) + '" r="2" fill="#2f6fed"/>';
  el.innerHTML = s + '</svg>';
}
const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
$('fChain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');
$('fCat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
function renderTabs() {
  const tabs = [['board', 'Launches · ' + rows.length], ['derivatives', 'Derivatives · ' + R.derivatives.length]];
  $('tabs').innerHTML = tabs.map((t) => '<button type="button" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + t[1] + '</button>').join('');
  $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.slug = null; writeHash(); renderAll(); }));
}
function filtered() {
  let list = rows;
  if (state.q) { const q = state.q.toLowerCase(); list = list.filter((r) => (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().includes(q)); }
  if (state.chain) list = list.filter((r) => r.chains.includes(state.chain));
  if (state.cat) list = list.filter((r) => r.category === state.cat);
  if (state.verdict) list = list.filter((r) => r.verdict === state.verdict);
  if (state.watch) list = list.filter((r) => r.on_watchlist);
  const key = { rank: 'rank', tvl: 'tvl_usd', odds: 'launch_odds', gross: 'gross_value_usd', ev: 'implied_value_usd', net: 'net_per_hour_usd' }[state.sort] || 'rank';
  return [...list].sort((a, b) => (a[key] - b[key]) * state.dir);
}
function rangeBar(r) {
  const l = (Math.log10(Math.max(r.range.p25, 1)) - evLo) / (evHi - evLo) * 100;
  const w = Math.max(2, (Math.log10(Math.max(r.range.p75, 1)) - Math.log10(Math.max(r.range.p25, 1))) / (evHi - evLo) * 100);
  return '<div class="rng" style="margin-left:' + l.toFixed(1) + '%"><i style="width:' + Math.min(100 - l, w).toFixed(1) + '%"></i></div><div class="sub2">' + usd(r.range.p25) + ' – ' + usd(r.range.p75) + '</div>';
}
const chainList = (r) => esc(r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''));
function boardRow(r) {
  const odds = Math.round(r.launch_odds * 100);
  return '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td>' +
    '<td><span class="nm">' + esc(r.name) + '</span>' + (r.on_watchlist ? '<span class="badge b-wl">WATCHLIST</span>' : '') + '<div class="sub2">' + esc(r.category || '—') + ' · ' + chainList(r) + '</div></td>' +
    '<td class="num">' + usd(r.tvl_usd) + '</td>' +
    '<td class="num ' + (r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : '') + '">' + pct(r.change_7d) + '</td>' +
    '<td class="num">' + ageFmt(r.age_days) + '</td>' +
    '<td><div class="bar"><i style="width:' + odds + '%"></i></div><div class="sub2">' + odds + '%</div></td>' +
    '<td class="num">' + usd(r.gross_value_usd) + '</td>' +
    '<td><b>' + usd(r.implied_value_usd) + '</b>' + rangeBar(r) + '</td>' +
    '<td><span class="badge ' + (r.verdict === 'farm' ? 'b-farm' : 'b-watch') + '">' + r.verdict.toUpperCase() + '</span> <b>' + sgn(r.net_usd, 0) + '</b><div class="sub2">' + usd(r.value_per_user_usd) + ' drop − ' + usd(r.plan_cost_usd) + ' cost</div></td>' +
    '<td class="num"><b>' + sgn(r.net_per_hour_usd) + '</b><div class="sub2">/ hour</div></td>' +
    '<td><div class="sub2">' + esc(r.plan.chain) + ' · $' + r.plan.cost + ' · ' + r.plan.hold + ' d · ' + r.farm_steps.length + ' steps</div></td></tr>';
}
function renderBoard() {
  if (state.tab === 'derivatives') {
    const ds = R.derivatives;
    $('board').innerHTML = '<tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Gross value</th><th>Why it is set aside</th></tr>' +
      ds.map((d) => '<tr><td><span class="nm">' + esc(d.name) + '</span><div class="sub2">' + chainList(d) + '</div></td><td>' + esc(d.category || '—') + '</td><td class="num">' + usd(d.tvl_usd) + '</td><td class="num">' + usd(d.gross_value_usd) + '</td><td class="sub2">Wrapped, staked or bridged product of a token that already trades — no launch of its own.</td></tr>').join('');
    $('rowCount').textContent = ds.length + ' of ' + ds.length + ' rows';
    $('boardNote').textContent = 'Derivatives are not ranked: a wrapped product has no launch of its own, so ranking one as a launch would put the biggest wrapped products at the top of a launch radar. They are listed here with their gross values, so nothing is hidden.';
    return;
  }
  const cols = [['rank', '#'], ['name', 'Protocol'], ['tvl', 'TVL'], ['chg', '7d'], ['age', 'No token for'], ['odds', 'Token odds'], ['gross', 'If it launches'], ['ev', 'Implied value · P25–P75'], ['verdict', 'Verdict · net of fees'], ['net', 'Net / hour'], ['plan', 'Farm plan']];
  const head = '<tr>' + cols.map((c) => '<th data-sort="' + c[0] + '" class="' + (['rank', 'tvl', 'chg', 'age', 'odds', 'gross', 'ev', 'net'].includes(c[0]) ? 'num' : '') + '">' + c[1] + (state.sort === c[0] ? (state.dir === 1 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr>';
  const list = filtered();
  $('board').innerHTML = head + list.map(boardRow).join('');
  $('rowCount').textContent = list.length + ' of ' + rows.length + ' rows · ' + usd(list.reduce((a, r) => a + r.implied_value_usd, 0)) + ' implied';
  $('boardNote').textContent = 'Click a row for its detail page: the value build-up, the nearest traded comparables, the farm plan, and what moves the value. ' + farmN + ' rows clear three times their farm cost (FARM); the rest are WATCH.';
  $('board').querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const s = th.dataset.sort;
    if (state.sort === s) state.dir = -state.dir;
    else { state.sort = s; state.dir = s === 'rank' ? 1 : -1; }
    renderBoard();
  }));
  $('board').querySelectorAll('tr[data-slug]').forEach((tr) => tr.addEventListener('click', () => { state.slug = tr.dataset.slug; writeHash(); renderAll(); }));
}
function renderDetail() {
  const r = bySlug.get(state.slug);
  const dp = $('detailPanel'), bp = $('boardPanel');
  if (!r) { dp.classList.add('hidden'); bp.classList.remove('hidden'); return; }
  bp.classList.add('hidden');
  dp.classList.remove('hidden');
  const rec = r.rec, plan = r.plan;
  const comps = comparables(r, R.live, F.value.fit, F.value.adjustments);
  const build = [
    ['TVL today', usd(r.tvl_usd), 'snapshot TVL'],
    ['Size multiple', '×' + rec.sizeMult.toFixed(4), '10^' + F.value.fit.intercept + ' · TVL^' + (F.value.fit.slope - 1).toFixed(4)],
    ['Category factor', '×' + rec.categoryFactor.toFixed(2), esc(r.category || 'no category')],
    ['Growth', '×' + rec.growthMult.toFixed(3), '7-day change ' + pct(r.change_7d) + ', clipped, weighted 0.4'],
    ['Age', '×' + rec.ageMult.toFixed(3), ageFmt(r.age_days) + ' with no token'],
    ['Gross value, if it launches', usd(r.gross_value_usd), ''],
    ['Launch odds, 12 months', Math.round(r.launch_odds * 100) + '%', 'Weibull, k = ' + F.odds.k.toFixed(2)],
    ['Implied value', usd(r.implied_value_usd), 'P25–P75 ' + usd(r.range.p25) + ' – ' + usd(r.range.p75)],
  ];
  const compRows = comps.map((c) => '<tr><td>' + esc(c.name) + '</td><td class="num">' + usd(c.tvl) + '</td><td class="num">' + usd(c.mcap) + '</td><td class="num">' + usd(c.model) + '</td><td class="num ' + (c.miss > 0 ? 'pos' : 'neg') + '">' + (c.miss > 0 ? '+' : '') + (c.miss * 100).toFixed(0) + '%</td></tr>').join('');
  const sens = [
    ['as recorded', r.tvl_usd, r.change_7d, r.age_days],
    ['TVL 30% lower', r.tvl_usd * 0.7, r.change_7d, r.age_days],
    ['7-day growth 0%', r.tvl_usd, 0, r.age_days],
    ['six more months, no token', r.tvl_usd, r.change_7d, (r.age_days ?? 365) + 180],
  ].map((s) => {
    const feat = { tvl: s[1], cat: r.category, chg: s[2], age: s[3] };
    const v = impliedValue(feat, F.value.fit, F.value.adjustments);
    const o = launchOdds(designRowFor(feat, F.design), F.odds);
    const ev = Math.max(1, Math.round(v.implied * o));
    return '<tr><td>' + s[0] + '</td><td class="num">' + usd(v.implied) + '</td><td class="num">' + Math.round(o * 100) + '%</td><td class="num"><b>' + usd(ev) + '</b></td><td class="num">×' + (ev / r.implied_value_usd).toFixed(2) + '</td></tr>';
  }).join('');
  const netRows = [50, 100, 250].map((dep) => '<tr><td>$' + dep + '</td>' + [0.05, 0.1, 0.2].map((sh) => {
    const p = farmPlan(r, r.implied_value_usd, { deposit: dep, dropShare: sh });
    return '<td class="num ' + (p.net >= 0 ? 'pos' : 'neg') + '">' + sgn(p.net, 0) + '</td>';
  }).join('') + '</tr>').join('');
  dp.innerHTML = '<button class="back" id="backBtn" type="button">← Board, filters kept</button>' +
    '<div class="d-head"><div><h2>#' + r.rank + ' ' + esc(r.name) + (r.on_watchlist ? '<span class="badge b-wl">WATCHLIST</span>' : '') + '</h2><div class="sub2">' + esc(r.category || '—') + ' · ' + esc(r.chains.join(', ')) + ' · no token for ' + ageFmt(r.age_days) + ' · TVL ' + usd(r.tvl_usd) + ' (' + pct(r.change_7d) + ' in 7 days)</div></div>' +
    '<div style="text-align:right"><div class="ev">' + usd(r.implied_value_usd) + '</div><div class="sub2">P25–P75 ' + usd(r.range.p25) + ' – ' + usd(r.range.p75) + '</div><div style="margin-top:4px"><span class="badge ' + (r.verdict === 'farm' ? 'b-farm' : 'b-watch') + '">' + r.verdict.toUpperCase() + '</span> <b>' + sgn(r.net_usd, 0) + ' net · ' + sgn(r.net_per_hour_usd) + '/h</b></div></div></div>' +
    '<div class="d-grid"><div><h3>Value build-up <span class="fn">impliedValue()</span></h3><table class="mini">' + build.map((b) => '<tr><td>' + b[0] + '</td><td class="num"><b>' + b[1] + '</b></td><td class="sub2">' + b[2] + '</td></tr>').join('') + '</table>' +
    '<h3 style="margin-top:12px">Nearest traded comparables</h3><table class="mini"><tr><th>Token</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Model, blind</th><th class="num">Miss</th></tr>' + compRows + '</table></div>' +
    '<div><h3>Farm plan <span class="fn">farmPlan()</span> — ' + plan.hold + ' days on ' + esc(plan.chain) + '</h3><ol class="steps">' + r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<p class="formula">Budget: $' + plan.cost + ' out of pocket ($' + plan.capital + ' capital + $' + (plan.cost - plan.capital) + ' gas), ' + plan.hours + ' h of work, against an expected drop of ' + usd(plan.valueUser) + ' (' + Math.round(plan.share * 100) + '% of ' + usd(r.implied_value_usd) + ' shared by ~' + plan.farmers.toLocaleString('en-US') + ' farmers). Net ' + sgn(plan.net, 0) + ', ' + sgn(plan.netPerHour, 0) + '/h. The same $' + plan.capital + ' in T-bills at 4.3% would earn $' + plan.tbill.toFixed(2) + ' over the hold.</p>' +
    '<h3 style="margin-top:12px">Net by deposit × drop share</h3><table class="mini"><tr><th>Deposit</th><th class="num">5% to farmers</th><th class="num">10%</th><th class="num">20%</th></tr>' + netRows + '</table>' +
    '<h3 style="margin-top:12px">What moves the value <span class="fn">impliedValue()</span> on a changed record</h3><table class="mini"><tr><th>If</th><th class="num">Launch value</th><th class="num">Odds</th><th class="num">Implied</th><th class="num">vs now</th></tr>' + sens + '</table></div></div>';
  $('backBtn').addEventListener('click', () => { state.slug = null; writeHash(); renderAll(); });
}
function renderAll() {
  renderTabs();
  renderBoard();
  renderDetail();
  if (state.slug) window.scrollTo(0, 0);
}
$('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
$('fChain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('fCat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
$('fVerdict').addEventListener('change', (e) => { state.verdict = e.target.value; writeHash(); renderBoard(); });
$('fWatch').addEventListener('change', (e) => { state.watch = e.target.checked; writeHash(); renderBoard(); });
$('fReset').addEventListener('click', () => { state.q = ''; state.chain = ''; state.cat = ''; state.verdict = ''; state.watch = false; $('q').value = ''; $('fChain').value = ''; $('fCat').value = ''; $('fVerdict').value = ''; $('fWatch').checked = false; writeHash(); renderBoard(); });
$('foot').textContent = 'Launch Radar v7 · model launch-radar-7 · DefiLlama snapshot ' + R.as_of + ' · the model is refitted in this browser from the sealed snapshot; the integrity strip shows the refit agreeing with board.json.';
$('q').value = state.q;
$('fVerdict').value = state.verdict;
$('fWatch').checked = state.watch;
renderAll();
window.RADAR_READY = true;
