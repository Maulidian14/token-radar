// model.js — Launch Radar v7: the model, fitted in this browser. The board is recomputed here from the sealed snapshot in zdata.js and the rows in data.js — no fetch, no network, no hardcoded names. Constants match main.ts, so the refit agrees with board.json to the last cent.
'use strict';

const M = {
  growth_weight: 0.4, growth_floor: -50, growth_cap: 100,
  age_floor: 0.7, age_range: 0.5, age_days_cap: 730, unknown_age_days: 365,
  cv_folds: 5, category_shrink_k: 15,
  wf_cutoffs: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8], wf_test_share: 0.1,
  odds_lambda: 0.1, odds_horizon_days: 365, odds_floor: 0.05, odds_cap: 0.95,
  odds_min_category: 15, farmer_share: 0.1, verdict_multiple: 3,
  bootstrap_refits: 200, tbill_rate: 0.043,
};
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const meanOf = (xs) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
function medianOf(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function seededStream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function livePoints(SN, CATS) {
  return SN.filter((r) => r[1] > 0 && r[0] > 0)
    .map((r) => ({ x: Math.log10(r[0]), y: Math.log10(r[1]), cat: r[2] < 0 ? null : CATS[r[2]], age: r[3], chg: r[4] }));
}
function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx !== 0) slopes.push((points[j].y - points[i].y) / dx);
    }
  const slope = medianOf(slopes) ?? 1;
  return { intercept: round4(medianOf(points.map((p) => p.y - slope * p.x)) ?? 0), slope: round4(slope) };
}
function categoryAdjustments(points, fit, k) {
  const byCat = new Map();
  for (const p of points) {
    if (p.cat === null) continue;
    const list = byCat.get(p.cat) ?? [];
    list.push(p.y - (fit.intercept + fit.slope * p.x));
    byCat.set(p.cat, list);
  }
  const out = {};
  for (const cat of [...byCat.keys()].sort()) {
    const res = byCat.get(cat);
    out[cat] = round4((medianOf(res) ?? 0) * (res.length / (res.length + k)));
  }
  return out;
}
function fitGross(points, k) {
  const fit = points.length >= 2 ? theilSen(points) : { intercept: 0, slope: 1 };
  return { fit, adjustments: categoryAdjustments(points, fit, k) };
}
function predictPoint(model, p) {
  const adj = p.cat !== null ? (model.adjustments[p.cat] ?? 0) : 0;
  return 10 ** (model.fit.intercept + model.fit.slope * p.x + adj);
}
function ranksOf(values) {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]] = avg;
    i = j + 1;
  }
  return ranks;
}
function backtestOf(predicted, actual) {
  const errors = predicted.map((pr, i) => Math.abs(Math.log10(pr) - Math.log10(actual[i])));
  const med = medianOf(errors) ?? 0;
  return {
    n: errors.length, median_log_err: round4(med), median_factor: round4(10 ** med),
    within_2x: round4(errors.length === 0 ? 0 : errors.filter((e) => e <= Math.log10(2)).length / errors.length),
  };
}
function cvPredict(points, predict) {
  const folds = Math.max(2, Math.floor(M.cv_folds));
  const pred = [], act = [];
  for (let k = 0; k < folds; k++) {
    const test = points.filter((_, i) => i % folds === k);
    const train = points.filter((_, i) => i % folds !== k);
    if (test.length === 0 || train.length < 2) continue;
    for (const p of test) { pred.push(predict(train, p)); act.push(10 ** p.y); }
  }
  return { bt: backtestOf(pred, act), residuals: pred.map((pr, i) => Math.log10(pr) - Math.log10(act[i])) };
}
function wfPredict(points, predict) {
  const dated = points.filter((p) => p.age !== null).sort((a, b) => b.age - a.age);
  const undated = points.filter((p) => p.age === null);
  const pred = [], act = [];
  for (const cutoff of M.wf_cutoffs) {
    const i = Math.floor(dated.length * cutoff);
    const train = [...dated.slice(0, i), ...undated];
    const test = dated.slice(i, i + Math.max(1, Math.floor(dated.length * M.wf_test_share)));
    if (test.length === 0 || train.length < 2) continue;
    for (const p of test) { pred.push(predict(train, p)); act.push(10 ** p.y); }
  }
  return backtestOf(pred, act);
}
function impliedValue(feat, fit, adjustments) {
  const sizeMult = round4(10 ** fit.intercept * feat.tvl ** (fit.slope - 1));
  const categoryFactor = round4(10 ** (feat.cat !== null ? (adjustments[feat.cat] ?? 0) : 0));
  const growthPct = clamp(typeof feat.chg === 'number' && Number.isFinite(feat.chg) ? feat.chg : 0, M.growth_floor, M.growth_cap);
  const growthMult = 1 + (growthPct / 100) * M.growth_weight;
  const ageForModel = feat.age ?? M.unknown_age_days;
  const ageMult = M.age_floor + (Math.min(Math.max(ageForModel, 0), M.age_days_cap) / M.age_days_cap) * M.age_range;
  return {
    implied: Math.max(1, Math.round(feat.tvl * sizeMult * categoryFactor * growthMult * ageMult)),
    sizeMult, categoryFactor, growthPct, growthMult: round4(growthMult), ageMult: round4(ageMult),
  };
}
function fitValue(SN, CATS) {
  const points = livePoints(SN, CATS);
  const globalMedian = medianOf(points.map((p) => 10 ** (p.y - p.x))) ?? 0;
  const full = points.length >= 2 ? fitGross(points, M.category_shrink_k)
    : { fit: { intercept: round4(Math.log10(Math.max(globalMedian, 1e-12))), slope: 1 }, adjustments: {} };
  const predict = (train, p) => predictPoint(fitGross(train, M.category_shrink_k), p);
  const cv = cvPredict(points, predict);
  return {
    points, live_count: points.length, global_median: round4(globalMedian),
    fit: full.fit, adjustments: full.adjustments,
    cv: cv.bt, cvResiduals: cv.residuals, wf: wfPredict(points, predict),
  };
}
function oddsDesign(SN, CATS) {
  const counts = new Map();
  for (const r of SN) {
    if (r[2] < 0) continue;
    const c = CATS[r[2]];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const bigCategories = [...counts.entries()].filter(([, n]) => n >= M.odds_min_category).map(([c]) => c).sort();
  const logTvls = SN.map((r) => Math.log10(Math.max(r[0], 1)));
  const chgs = SN.map((r) => clamp(typeof r[4] === 'number' && Number.isFinite(r[4]) ? r[4] : 0, M.growth_floor, M.growth_cap));
  const logTvlMu = meanOf(logTvls), chgMu = meanOf(chgs);
  const logTvlSd = Math.sqrt(meanOf(logTvls.map((v) => (v - logTvlMu) ** 2))) || 1;
  const chgSd = Math.sqrt(meanOf(chgs.map((v) => (v - chgMu) ** 2))) || 1;
  const d = { bigCategories, logTvlMu, logTvlSd, chgMu, chgSd };
  const rows = SN.map((r) => ({
    x: designX(r[0], r[4], r[2] < 0 ? null : CATS[r[2]], d),
    age: Math.max(r[3] ?? M.unknown_age_days, 1), y: r[5] === 2 ? 1 : 0,
  }));
  return { rows, ...d };
}
function designX(tvl, chg, cat, d) {
  const x = [1, (Math.log10(Math.max(tvl, 1)) - d.logTvlMu) / d.logTvlSd,
    (clamp(typeof chg === 'number' && Number.isFinite(chg) ? chg : 0, M.growth_floor, M.growth_cap) - d.chgMu) / d.chgSd];
  for (const c of d.bigCategories) x.push(cat === c ? 1 : 0);
  return x;
}
function designRowFor(feat, design) {
  return { x: designX(feat.tvl, feat.chg, feat.cat, design), age: Math.max(feat.age ?? M.unknown_age_days, 1), y: 0 };
}
function weibullNllGrad(theta, rows, lambda) {
  const d = theta.length - 1;
  const k = Math.exp(theta[d]);
  let value = 0;
  const grad = new Array(theta.length).fill(0);
  for (const r of rows) {
    let logLam = 0;
    for (let j = 0; j < d; j++) logLam += theta[j] * r.x[j];
    const s = Math.min(30, Math.max(-30, k * (Math.log(r.age) - logLam)));
    const u = Math.exp(s);
    const g = u > 50 ? 0 : u / Math.expm1(u);
    const w = r.y === 1 ? g : -u;
    if (r.y === 1) value -= u < 1e-10 ? Math.log(u) : Math.log1p(-Math.exp(-u));
    else value += u;
    for (let j = 0; j < d; j++) grad[j] += k * r.x[j] * w;
    grad[d] -= w * s;
  }
  for (let j = 1; j < d; j++) { value += lambda * theta[j] ** 2; grad[j] += 2 * lambda * theta[j]; }
  return { value, grad };
}
function dot(u, v) { let s = 0; for (let i = 0; i < u.length; i++) s += u[i] * v[i]; return s; }
function bfgs(start, fn, maxIter = 500, gradTol = 1e-7) {
  const n = start.length;
  let x = [...start];
  let { value, grad } = fn(x);
  const h = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let iter = 0; iter < maxIter; iter++) {
    let gmax = 0;
    for (const g of grad) gmax = Math.max(gmax, Math.abs(g));
    if (gmax < gradTol) break;
    const p = new Array(n).fill(0);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += h[i][j] * grad[j]; p[i] = -s; }
    const slope = dot(grad, p);
    if (!(slope < 0)) break;
    let step = 1;
    let next = x.map((xi, i) => xi + step * p[i]);
    let trial = fn(next);
    let tries = 0;
    while (trial.value > value + 1e-4 * step * slope && tries < 60) {
      step *= 0.5;
      next = x.map((xi, i) => xi + step * p[i]);
      trial = fn(next);
      tries++;
    }
    if (trial.value >= value) break;
    const s = next.map((xi, i) => xi - x[i]);
    const y = trial.grad.map((gi, i) => gi - grad[i]);
    const sy = dot(s, y);
    if (sy > 1e-12) {
      const rho = 1 / sy;
      const hy = new Array(n).fill(0);
      for (let i = 0; i < n; i++) { let sum = 0; for (let j = 0; j < n; j++) sum += h[i][j] * y[j]; hy[i] = sum; }
      const yhy = dot(y, hy);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          h[i][j] += rho * rho * (sy + yhy) * s[i] * s[j] - rho * (s[i] * hy[j] + hy[i] * s[j]);
    }
    x = next; value = trial.value; grad = trial.grad;
  }
  return { x, value };
}
function fitWeibull(rows, lambda) {
  const d = rows[0].x.length;
  const fn = (theta) => weibullNllGrad(theta, rows, lambda);
  let best = null;
  for (const k0 of [0.5, 1.0]) {
    const start = new Array(d + 1).fill(0);
    start[0] = Math.log(700);
    start[d] = Math.log(k0);
    const { x, value } = bfgs(start, fn);
    if (best === null || value < best.nll) best = { theta: x, k: Math.exp(x[d]), nll: value };
  }
  return best;
}
function weibullCdf(age, x, fit) {
  let logLam = 0;
  for (let j = 0; j < x.length; j++) logLam += fit.theta[j] * x[j];
  const s = Math.min(30, Math.max(-30, fit.k * (Math.log(Math.max(age, 1)) - logLam)));
  return 1 - Math.exp(-Math.exp(s));
}
function launchOdds(row, fit, horizonDays = M.odds_horizon_days) {
  const f0 = weibullCdf(row.age, row.x, fit);
  const f1 = weibullCdf(row.age + horizonDays, row.x, fit);
  return Math.min(M.odds_cap, Math.max(M.odds_floor, (f1 - f0) / Math.max(1 - f0, 1e-9)));
}
function logLossAuc(predicted, actual) {
  const eps = 1e-12;
  let ll = 0;
  for (let i = 0; i < predicted.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, predicted[i]));
    ll -= actual[i] === 1 ? Math.log(p) : Math.log(1 - p);
  }
  const pos = predicted.filter((_, i) => actual[i] === 1);
  const neg = predicted.filter((_, i) => actual[i] === 0);
  const ranks = ranksOf([...pos, ...neg]);
  let rankSum = 0;
  for (let i = 0; i < pos.length; i++) rankSum += ranks[i];
  const auc = pos.length === 0 || neg.length === 0 ? 0.5 : (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
  return { logLoss: ll / predicted.length, auc };
}
function baseRateLogLoss(rate) {
  const p = Math.min(0.999999, Math.max(0.000001, rate));
  return -(p * Math.log(p) + (1 - p) * Math.log(1 - p));
}
function oddsSplits(SN) {
  const stream = seededStream(42);
  const idx = SN.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(stream() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const dated = SN.map((r, i) => ({ age: r[3], i })).filter((o) => o.age !== null).sort((a, b) => b.age - a.age).map((o) => o.i);
  const undated = SN.map((r, i) => i).filter((i) => SN[i][3] === null);
  const cut = Math.floor(dated.length * 0.7);
  return { idx, heldTrain: [...dated.slice(0, cut), ...undated].sort((a, b) => a - b), heldTest: dated.slice(cut) };
}
function scoreOddsSubset(design, splits, keep) {
  const sub = (rows) => rows.map((r) => ({ x: keep.map((j) => r.x[j]), age: r.age, y: r.y }));
  const cvPred = [], cvAct = [];
  for (let f = 0; f < 5; f++) {
    const testIdx = splits.idx.filter((_, i) => i % 5 === f);
    const trainIdx = splits.idx.filter((_, i) => i % 5 !== f);
    const fit = fitWeibull(sub(trainIdx.map((i) => design.rows[i])), M.odds_lambda);
    for (const i of testIdx) {
      const r = design.rows[i];
      cvPred.push(weibullCdf(r.age, keep.map((j) => r.x[j]), fit));
      cvAct.push(r.y);
    }
  }
  const cv = logLossAuc(cvPred, cvAct);
  const heldFit = fitWeibull(sub(splits.heldTrain.map((i) => design.rows[i])), M.odds_lambda);
  const heldPred = splits.heldTest.map((i) => weibullCdf(design.rows[i].age, keep.map((j) => design.rows[i].x[j]), heldFit));
  const heldAct = splits.heldTest.map((i) => design.rows[i].y);
  const held = logLossAuc(heldPred, heldAct);
  return { cv_log_loss: round4(cv.logLoss), cv_auc: round4(cv.auc), held_log_loss: round4(held.logLoss), held_auc: round4(held.auc), held_n: heldAct.length };
}
function validateOdds(SN, design) {
  const baseRate = meanOf(design.rows.map((r) => r.y));
  const splits = oddsSplits(SN);
  const full = scoreOddsSubset(design, splits, design.rows[0].x.map((_, j) => j));
  const heldRate = meanOf(splits.heldTest.map((i) => design.rows[i].y));
  return {
    base_rate: round4(baseRate), base_rate_log_loss: round4(baseRateLogLoss(baseRate)),
    cv_log_loss: full.cv_log_loss, cv_auc: full.cv_auc,
    heldout_log_loss: full.held_log_loss, heldout_auc: full.held_auc,
    heldout_base_rate_log_loss: round4(baseRateLogLoss(heldRate)), heldout_n: full.held_n,
  };
}
function priceTests(SN, CATS, value, design, validation) {
  const points = value.points;
  const valueTerms = [
    { name: 'flat median multiple', predict: (train, p) => 10 ** p.x * (medianOf(train.map((q) => 10 ** (q.y - q.x))) ?? 0) },
    { name: '+ size curve', predict: (train, p) => { const f = train.length >= 2 ? theilSen(train) : { intercept: 0, slope: 1 }; return 10 ** (f.intercept + f.slope * p.x); } },
    { name: '+ category effect', predict: (train, p) => predictPoint(fitGross(train, M.category_shrink_k), p) },
  ];
  const valueRows = [];
  let prevCv = null, prevWf = null;
  for (let t = 0; t < valueTerms.length; t++) {
    const cv = cvPredict(points, valueTerms[t].predict).bt;
    const wf = wfPredict(points, valueTerms[t].predict);
    const kept = t === 0 ? 'baseline' : (cv.median_factor <= prevCv && wf.median_factor <= prevWf && (cv.median_factor < prevCv || wf.median_factor < prevWf) ? 'kept' : 'tested, not kept');
    valueRows.push({ term: valueTerms[t].name, cv: cv.median_factor, wf: wf.median_factor, kept });
    prevCv = cv.median_factor; prevWf = wf.median_factor;
  }
  const nCols = design.rows[0].x.length;
  const all = design.rows[0].x.map((_, j) => j);
  const splits = oddsSplits(SN);
  const fullCv = validation.cv_log_loss, fullHeld = validation.heldout_log_loss;
  const oddsRows = [
    { term: 'base rate', cv: validation.base_rate_log_loss, held: validation.heldout_base_rate_log_loss, kept: 'baseline' },
    { term: 'full model', cv: fullCv, held: fullHeld, kept: 'kept' },
  ];
  const drops = [
    { name: 'without size, log TVL', keep: all.filter((j) => j !== 1) },
    { name: 'without 7-day growth', keep: all.filter((j) => j !== 2) },
    { name: 'without category effects', keep: [0, 1, 2] },
  ];
  for (const d of drops) {
    const s = scoreOddsSubset(design, splits, d.keep);
    const worse = (s.cv_log_loss > fullCv) + (s.held_log_loss > fullHeld);
    oddsRows.push({ term: d.name, cv: s.cv_log_loss, held: s.held_log_loss, kept: worse === 2 ? 'needed' : worse === 1 ? 'marginal' : 'not needed' });
  }
  return { value: valueRows, odds: oddsRows };
}
function bootstrapRanges(value, recomputed) {
  const points = value.points;
  const res = value.cvResiduals;
  const stream = seededStream(7);
  const n = points.length;
  const rowVals = recomputed.map(() => []);
  const oobVals = points.map(() => []);
  const oobActual = points.map((p) => 10 ** p.y);
  const draw = () => 10 ** (-res[Math.floor(stream() * res.length)]);
  for (let b = 0; b < M.bootstrap_refits; b++) {
    const sample = [];
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const j = Math.floor(stream() * n);
      sample.push(points[j]);
      seen.add(j);
    }
    const f = fitGross(sample, M.category_shrink_k);
    for (let r = 0; r < recomputed.length; r++) {
      const row = recomputed[r];
      const gross = predictPoint(f, { x: Math.log10(Math.max(row.tvl, 1)), y: 0, cat: row.cat, age: row.age, chg: row.chg }) * row.growthMult * row.ageMult;
      rowVals[r].push(gross * row.odds * draw());
    }
    for (let i = 0; i < n; i++) if (!seen.has(i)) oobVals[i].push(predictPoint(f, points[i]) * draw());
  }
  const pct = (xs, q) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
  };
  const ranges = recomputed.map((row, r) => ({ p25: Math.max(1, Math.round(pct(rowVals[r], 0.25))), p75: Math.max(1, Math.round(pct(rowVals[r], 0.75))) }));
  let inside = 0, counted = 0;
  for (let i = 0; i < n; i++) {
    if (oobVals[i].length < 20) continue;
    counted++;
    if (oobActual[i] >= pct(oobVals[i], 0.25) && oobActual[i] <= pct(oobVals[i], 0.75)) inside++;
  }
  return { ranges, honesty: counted === 0 ? 0 : round4(inside / counted), honesty_n: counted, honesty_inside: inside };
}
function ledger(SN) {
  const groups = { ranked: 0, trades: 0, onRecord: 0, derivative: 0 };
  for (const r of SN) {
    if (r[5] === 0) groups.ranked++;
    else if (r[5] === 1) groups.derivative++;
    else if (r[1] > 0) groups.trades++;
    else groups.onRecord++;
  }
  return { ...groups, total: SN.length };
}
function sealOf(rows) {
  let h = 0x811c9dc5;
  for (const r of rows) {
    const s = `${r.rank}:${r.slug}:${r.ev};`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h.toString(16).padStart(8, '0');
}
function checkBoard(recomputed, radarRows) {
  const bySlug = new Map(radarRows.map((r) => [r.slug, r]));
  let rows = 0, ranks = 0, gross = 0, ev = 0;
  for (const r of recomputed) {
    const b = bySlug.get(r.slug);
    if (!b) continue;
    rows++;
    if (b.rank === r.rank) ranks++;
    if (b.gross_value_usd === r.gross) gross++;
    if (b.implied_value_usd === r.ev) ev++;
  }
  return { rows, ranks, gross, ev, total: radarRows.length };
}
const GAS = { Ethereum: 8, Solana: 1, Base: 1, Arbitrum: 1, Optimism: 1, Polygon: 1, Avalanche: 1, Binance: 1, Tron: 1, Monad: 1, 'Hyperliquid L1': 1, Bitcoin: 5 };
function capitalFor(tvl) {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 10_000_000) return 100;
  return 50;
}
function holdDaysFor(age) {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
}
function farmerCountFor(tvl) {
  return Math.max(100, Math.min(5000, Math.round(25 * Math.sqrt(tvl / 1_000_000))));
}
function farmPlan(row, ev, opts = {}) {
  const chain = row.chains.length > 0 ? row.chains[0] : 'its main chain';
  const capital = opts.deposit ?? capitalFor(row.tvl_usd);
  const gas = GAS[chain] ?? 2;
  const hold = holdDaysFor(row.age_days);
  const weeks = Math.ceil(hold / 7);
  const months = Math.ceil(hold / 30);
  const cost = capital + gas * (3 + weeks);
  const hours = Math.round((0.5 + weeks / 6 + months * 0.25 + 0.25) * 100) / 100;
  const farmers = farmerCountFor(row.tvl_usd);
  const share = opts.dropShare ?? M.farmer_share;
  const valueUser = Math.round((ev * share) / farmers);
  const net = valueUser - cost;
  return {
    chain, capital, gas, hold, weeks, cost, hours, farmers, share, valueUser, net,
    netPerHour: Math.round((net / hours) * 100) / 100,
    verdict: valueUser >= M.verdict_multiple * cost ? 'farm' : 'watch',
    tbill: Math.round(capital * M.tbill_rate * hold / 365 * 100) / 100,
  };
}
function comparables(row, liveRows, fit, adjustments) {
  const lt = Math.log10(Math.max(row.tvl_usd, 1));
  return liveRows
    .filter((l) => l.mcap_usd > 0)
    .map((l) => ({ ...l, d: Math.abs(Math.log10(Math.max(l.tvl_usd, 1)) - lt) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((l) => {
      const model = predictPoint({ fit, adjustments }, { x: Math.log10(Math.max(l.tvl_usd, 1)), y: 0, cat: l.category, age: l.age_days, chg: null });
      return { name: l.name, tvl: l.tvl_usd, mcap: l.mcap_usd, model: Math.round(model), miss: round4((l.mcap_usd - model) / model) };
    });
}
function fitAll(SN, CATS, RADAR) {
  // Decode the compact snapshot: [tvl, mcap, cat, age, chg] with the class folded in — a derivative negates its category index, a token on record with no cap stores mcap -1, an unlisted protocol stores age -1. Restored to [tvl, mcap, cat, age, chg, class] for the fits below.
  SN = SN.map((r) => {
    const ci = r[2];
    const der = ci < 0 && ci !== -100;
    return [r[0], r[1] < 0 ? 0 : r[1], ci === -100 || ci === -101 ? -1 : der ? -ci - 1 : ci, r[3] < 0 ? null : r[3], r[4], r[1] !== 0 ? 2 : der ? 1 : 0];
  });
  const value = fitValue(SN, CATS);
  const design = oddsDesign(SN, CATS);
  const odds = fitWeibull(design.rows, M.odds_lambda);
  const validation = validateOdds(SN, design);
  const evidence = priceTests(SN, CATS, value, design, validation);
  const recomputed = RADAR.rows.map((r) => {
    const feat = { tvl: r.tvl_usd, cat: r.category, chg: r.change_7d, age: r.age_days };
    const v = impliedValue(feat, value.fit, value.adjustments);
    const oddsP = launchOdds(designRowFor(feat, design), odds);
    const ev = Math.max(1, Math.round(v.implied * oddsP));
    return {
      slug: r.slug, rank: r.rank, tvl: r.tvl_usd, cat: r.category, chg: r.change_7d, age: r.age_days,
      gross: v.implied, odds: oddsP, ev,
      growthMult: v.growthMult, ageMult: v.ageMult, sizeMult: v.sizeMult, categoryFactor: v.categoryFactor, growthPct: v.growthPct,
    };
  });
  recomputed.sort((a, b) => b.ev - a.ev || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  recomputed.forEach((r, i) => { r.rank = i + 1; });
  const boot = bootstrapRanges(value, recomputed);
  const check = checkBoard(recomputed, RADAR.rows);
  const seal = sealOf(recomputed);
  const led = ledger(SN);
  return { value, design, odds, validation, evidence, recomputed, boot, check, seal, ledger: led };
}
