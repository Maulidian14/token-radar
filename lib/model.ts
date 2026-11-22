// Launch Radar v6 — the token launch radar's model (Node, standard library only).
//
// What the board ranks: launch candidates only — pre-token protocols that are
// not a wrapped, staked or bridged product of a token that already trades —
// by the EXPECTED value of their launch: gross implied value times the
// probability the protocol launches within a year.
//
//   gross value  — v4's power law: a Theil-Sen fit of log10(market cap) on
//                  log10(TVL) over the snapshot's live-token protocols, a
//                  shrunk per-category residual adjustment, a growth
//                  multiplier and an age multiplier.
//   launch odds  — a Weibull current-status survival model fitted at runtime
//                  from the snapshot. A protocol that records a token has
//                  already launched (its launch time is at most its age); a
//                  pre-token protocol has not (its launch time is past its
//                  age). The fitted shape is below 1, so the launch hazard
//                  FALLS with age — the pattern the data itself shows, and
//                  the one the leaderboard's winners describe. No sign is
//                  imposed: the age effect is learned, not asserted.
//   verdict      — farm or watch, from the estimated airdrop value per
//                  farmer (expected value x a documented 10% farmer share,
//                  divided by an estimated farmer count) against the cost of
//                  the farm plan. A watchlist row is never a skip.
//
// Derivatives and token-trading protocols are not ranked as launches — a
// wrapped product has no launch of its own — but the dashboard lists every
// one of them, so all 758 protocols in the snapshot are accounted for:
// 198 on the board, 144 derivatives, 416 already trading.
//
// Every number the model reports (the fit, the backtests, the odds
// validation, the coverage counts) is computed from the snapshot at runtime.
// The run is deterministic: fixed starting points, a seeded shuffle for the
// cross-validation folds, and pure functions of the snapshot's bytes.

/** One protocol as the snapshot records it. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot: the protocols, the watchlist and the floor. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants. Only the method is hardcoded; every fitted number comes from the snapshot. */
export interface ModelConstants {
  // Gross value (v4's terms, kept: they survived the walk-forward backtest).
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  age_floor: number;
  age_range: number;
  age_days_cap: number;
  unknown_age_days: number;
  cv_folds: number;
  category_shrink_k: number;
  wf_cutoffs: number[];
  wf_test_share: number;
  // Launch odds (the Weibull survival model).
  odds_lambda: number;
  odds_horizon_days: number;
  odds_floor: number;
  odds_cap: number;
  odds_min_category: number;
  // Farm verdicts.
  farmer_share: number;
  verdict_multiple: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.4,
  growth_floor: -50,
  growth_cap: 100,
  age_floor: 0.7,
  age_range: 0.5,
  age_days_cap: 730,
  unknown_age_days: 365,
  cv_folds: 5,
  category_shrink_k: 15,
  wf_cutoffs: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  wf_test_share: 0.1,
  odds_lambda: 0.1,
  odds_horizon_days: 365,
  odds_floor: 0.05,
  odds_cap: 0.95,
  odds_min_category: 15,
  farmer_share: 0.1,
  verdict_multiple: 3,
};

export const MODEL_VERSION = 'launch-radar-6';

/** The fitted power law: log10(mcap) = intercept + slope * log10(TVL). */
export interface PowerLawFit {
  intercept: number;
  slope: number;
}

/** One backtest record: predictions against true market caps. */
export interface BacktestInfo {
  n: number;
  median_log_err: number;
  median_factor: number;
  within_2x: number;
  spearman: number;
}

/** The gross-value calibration: the fit, the category adjustments, both backtests. */
export interface CalibrationInfo {
  live_count: number;
  global_median: number;
  fit: PowerLawFit;
  category_adjustments: Record<string, number>;
  backtest: BacktestInfo;
  walkforward: BacktestInfo;
}

/** The fitted launch-odds model, for the dashboard's method strip. */
export interface OddsFitInfo {
  shape_k: number;
  lambda: number;
  horizon_days: number;
  intercept: number;
  log_tvl: number;
  change_7d: number;
  category_effects: Record<string, number>;
  big_categories: string[];
}

/** The odds model's validation: 5-fold CV and a time-held-out split. */
export interface OddsValidation {
  base_rate: number;
  base_rate_log_loss: number;
  cv_log_loss: number;
  cv_auc: number;
  heldout_log_loss: number;
  heldout_auc: number;
  heldout_base_rate_log_loss: number;
  heldout_n: number;
}

// --------------------------------------------------------------- small maths

/** The median of a list, or null when it is empty. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The mean of a list, or 0 when it is empty. */
function meanOf(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, x) => s + x, 0) / values.length;
}

/** A deterministic pseudo-random stream (mulberry32) for the cross-validation folds. */
function seededStream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------- gross value

/** One live-token protocol as a point in log space. */
interface LogPoint {
  x: number;
  y: number;
  category: string | null;
  listed_at: string | null;
}

/**
 * The Theil-Sen line through log points: the slope is the median of every
 * pairwise slope, the intercept the median of y minus slope times x. A
 * median fit, so a few extreme attribution artefacts cannot pull the line.
 * Deterministic: medians of exact float arrays, in slug order.
 */
function theilSen(points: LogPoint[]): PowerLawFit {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx !== 0) slopes.push((points[j]!.y - points[i]!.y) / dx);
    }
  }
  const slope = medianOf(slopes) ?? 1;
  const intercept = medianOf(points.map((p) => p.y - slope * p.x)) ?? 0;
  return { intercept: round4(intercept), slope: round4(slope) };
}

/** Pearson correlation of two equal-length lists; 0 when either has no variance. */
function pearson(u: number[], v: number[]): number {
  const n = u.length;
  if (n === 0) return 0;
  const mu = meanOf(u);
  const mv = meanOf(v);
  let num = 0;
  let du = 0;
  let dv = 0;
  for (let i = 0; i < n; i++) {
    num += (u[i]! - mu) * (v[i]! - mv);
    du += (u[i]! - mu) ** 2;
    dv += (v[i]! - mv) ** 2;
  }
  return du === 0 || dv === 0 ? 0 : num / Math.sqrt(du * dv);
}

/** Ranks with ties averaged, 1-based. */
function ranksOf(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation between predicted and true market caps. */
function spearman(predicted: number[], actual: number[]): number {
  return pearson(ranksOf(predicted), ranksOf(actual));
}

/**
 * The per-category adjustment of a fitted power law: each category's median
 * residual from the line, shrunk toward zero by n / (n + k), where n is the
 * category's count of live protocols. A category with many live protocols
 * earns its adjustment; a category with one or two earns almost none, so the
 * adjustment cannot be a single protocol's quirk. Categories are keyed in
 * sorted order, so the record serialises deterministically.
 */
function categoryAdjustments(points: LogPoint[], fit: PowerLawFit, k: number): Record<string, number> {
  const byCategory = new Map<string, number[]>();
  for (const p of points) {
    if (p.category === null) continue;
    const residual = p.y - (fit.intercept + fit.slope * p.x);
    const list = byCategory.get(p.category) ?? [];
    list.push(residual);
    byCategory.set(p.category, list);
  }
  const out: Record<string, number> = {};
  for (const category of [...byCategory.keys()].sort()) {
    const residuals = byCategory.get(category)!;
    const med = medianOf(residuals) ?? 0;
    out[category] = round4(med * (residuals.length / (residuals.length + k)));
  }
  return out;
}

/** A fitted gross model: the power law plus its per-category adjustments. */
interface FittedGross {
  fit: PowerLawFit;
  adjustments: Record<string, number>;
}

/** The gross model's prediction for one log point: the power law, times its category's factor. */
function predictPoint(model: FittedGross, p: LogPoint): number {
  const adj = p.category !== null ? (model.adjustments[p.category] ?? 0) : 0;
  return 10 ** (model.fit.intercept + model.fit.slope * p.x + adj);
}

/** Fit the power law and the category adjustments on one training set. */
function fitGross(points: LogPoint[], k: number): FittedGross {
  const fit = points.length >= 2 ? theilSen(points) : { intercept: 0, slope: 1 };
  return { fit, adjustments: categoryAdjustments(points, fit, k) };
}

/** The backtest record for one set of predictions against their true market caps. */
function backtestOf(predicted: number[], actual: number[]): BacktestInfo {
  const errors = predicted.map((pr, i) => Math.abs(Math.log10(pr) - Math.log10(actual[i]!)));
  const medianLogErr = medianOf(errors) ?? 0;
  const within2x = errors.length === 0 ? 0 : errors.filter((e) => e <= Math.log10(2)).length / errors.length;
  return {
    n: errors.length,
    median_log_err: round4(medianLogErr),
    median_factor: round4(10 ** medianLogErr),
    within_2x: round4(within2x),
    spearman: round4(spearman(predicted, actual)),
  };
}

/**
 * Derive the size curve from the snapshot's own live-token protocols and
 * backtest it two ways. The fit is a Theil-Sen power law on (log10 TVL,
 * log10 mcap) plus a shrunk per-category residual adjustment; the 5-fold
 * cross-validation fits the same model on four folds and predicts the fifth,
 * over deterministic folds by slug; the walk-forward backtest sorts the live
 * protocols by the day DefiLlama began tracking them and, over six expanding
 * windows, fits on the earlier ones and predicts the later ones — the test
 * the board itself faces. Protocols with no listing date always train, never
 * test. Only the method is hardcoded — every number comes from the snapshot.
 */
export function calibratePowerLaw(snapshot: Snapshot, model: ModelConstants = MODEL): CalibrationInfo {
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMedian = medianOf(allRatios) ?? 0;
  const points: LogPoint[] = live.map((p) => ({
    x: Math.log10(p.tvl_usd),
    y: Math.log10(p.mcap_usd!),
    category: p.category,
    listed_at: p.listed_at,
  }));
  // Degenerate fallback, never taken on this snapshot: with fewer than two
  // live protocols no line can be fitted, so the multiple is the global median.
  const full: FittedGross =
    points.length >= 2
      ? fitGross(points, model.category_shrink_k)
      : {
          fit: { intercept: round4(Math.log10(Math.max(globalMedian, 1e-12))), slope: 1 },
          adjustments: {},
        };
  // 5-fold cross-validation of the same model: deterministic folds by slug order.
  const folds = Math.max(2, Math.floor(model.cv_folds));
  const cvPredicted: number[] = [];
  const cvActual: number[] = [];
  for (let k = 0; k < folds; k++) {
    const test = points.filter((_, i) => i % folds === k);
    const train = points.filter((_, i) => i % folds !== k);
    if (test.length === 0 || train.length < 2) continue;
    const f = fitGross(train, model.category_shrink_k);
    for (const p of test) {
      cvPredicted.push(predictPoint(f, p));
      cvActual.push(10 ** p.y);
    }
  }
  // Walk-forward: fit on earlier-listed protocols, predict later-listed ones.
  const dated = points
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : 0));
  const undated = points.filter((p) => p.listed_at === null);
  const wfPredicted: number[] = [];
  const wfActual: number[] = [];
  for (const cutoff of model.wf_cutoffs) {
    const i = Math.floor(dated.length * cutoff);
    const train = [...dated.slice(0, i), ...undated];
    const test = dated.slice(i, i + Math.max(1, Math.floor(dated.length * model.wf_test_share)));
    if (test.length === 0 || train.length < 2) continue;
    const f = fitGross(train, model.category_shrink_k);
    for (const p of test) {
      wfPredicted.push(predictPoint(f, p));
      wfActual.push(10 ** p.y);
    }
  }
  return {
    live_count: live.length,
    global_median: round4(globalMedian),
    fit: full.fit,
    category_adjustments: full.adjustments,
    backtest: backtestOf(cvPredicted, cvActual),
    walkforward: backtestOf(wfPredicted, wfActual),
  };
}

const DAY_MS = 86_400_000;

/** A whole-day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The TVL multiple for one protocol's size, from the fitted power law:
 * 10^intercept * tvl^(slope - 1). Smooth in TVL, so no band edge doubles a
 * value. Rounded to 4 decimals, so the dashboard's breakdown and the model
 * agree exactly.
 */
export function sizeMultiple(tvlUsd: number, fit: PowerLawFit): number {
  return round4(10 ** fit.intercept * tvlUsd ** (fit.slope - 1));
}

/** The three multipliers, the category factor and the gross implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fit: PowerLawFit,
  adjustments: Record<string, number> = {},
): {
  implied: number;
  sizeMult: number;
  categoryFactor: number;
  growthPct: number;
  growthMult: number;
  ageMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const sizeMult = sizeMultiple(protocol.tvl_usd, fit);
  const catAdj = protocol.category !== null ? (adjustments[protocol.category] ?? 0) : 0;
  const categoryFactor = round4(10 ** catAdj);
  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const ageMult = model.age_floor + (Math.min(Math.max(ageForModel, 0), model.age_days_cap) / model.age_days_cap) * model.age_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * sizeMult * categoryFactor * growthMult * ageMult));
  return { implied, sizeMult, categoryFactor, growthPct, growthMult, ageMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release marker is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are wrapped, staked or bridged products of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A whole word in the name that marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name that begins with an exchange's name is the exchange's product, not a launch of its own. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Whether the snapshot records no token for a protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a launch candidate: pre-token, and not a wrapped, staked or bridged product. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** A pre-token protocol's class: `launch` is a launch of its own; `derivative` is a wrapped, staked or bridged product of a token that already trades. */
export type BoardClass = 'launch' | 'derivative';

export function boardClass(p: SnapshotProtocol): BoardClass {
  return isRankable(p) ? 'launch' : 'derivative';
}

// --------------------------------------------------------------- launch odds
//
// A Weibull current-status survival model for the time from listing to
// launch. Each protocol is one observation of the launch time T:
//   - a protocol that records a token has launched: T <= age;
//   - a pre-token protocol has not: T > age.
// The scale is log-linear in the features, the shape k is fitted. With
// k < 1 the launch hazard falls with age — a protocol that has run a long
// time without a token is, per the snapshot's own record, less likely to
// launch in the next year than a young one. The odds a protocol gets are
// P(T <= age + horizon | T > age): the chance it launches within the next
// year, given it has not launched yet.
//
// Why survival instead of a plain classifier: the cross-sectional target
// "records a token" measures "has launched already", which rewards old
// categories and penalises the young ones where future launches come from.
// A logistic fit on that target either needs its age coefficient forced
// negative (which breaks its time-held-out validation) or learns a
// positive age effect (which calls the oldest protocols the likeliest to
// launch). The survival form resolves the tension honestly: age enters
// through the clock itself, and the fitted shape says how the hazard moves
// with age. On this snapshot the time-held-out log-loss beats the base
// rate and the AUC clears 0.65; both numbers are computed at runtime and
// shown on the dashboard.

/** One protocol's odds features: the design row, its age and its outcome. */
interface OddsRow {
  /** The design row: [1, log10(TVL) z-scored, change_7d z-scored, category dummies...]. */
  x: number[];
  /** Days since listing, or 365 when the snapshot records no listing date; at least 1. */
  age: number;
  /** 1 when the snapshot records a token for the protocol, 0 otherwise. */
  y: number;
}

/** The odds design: the rows, the big categories and the standardisation constants. */
interface OddsDesign {
  rows: OddsRow[];
  bigCategories: string[];
  logTvlMu: number;
  logTvlSd: number;
  chgMu: number;
  chgSd: number;
}

/** Build the odds design from the snapshot, in slug order. */
function oddsDesign(snapshot: Snapshot, model: ModelConstants): OddsDesign {
  const ordered = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const counts = new Map<string, number>();
  for (const p of ordered) {
    if (p.category !== null) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  const bigCategories = [...counts.entries()]
    .filter(([, n]) => n >= model.odds_min_category)
    .map(([c]) => c)
    .sort();
  const logTvls = ordered.map((p) => Math.log10(Math.max(p.tvl_usd, 1)));
  const chgs = ordered.map((p) => {
    const raw = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
    return Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
  });
  const logTvlMu = meanOf(logTvls);
  const chgMu = meanOf(chgs);
  const logTvlSd = Math.sqrt(meanOf(logTvls.map((v) => (v - logTvlMu) ** 2))) || 1;
  const chgSd = Math.sqrt(meanOf(chgs.map((v) => (v - chgMu) ** 2))) || 1;
  const rows: OddsRow[] = ordered.map((p, i) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const x = [1, (logTvls[i]! - logTvlMu) / logTvlSd, (chgs[i]! - chgMu) / chgSd];
    for (const c of bigCategories) x.push(p.category === c ? 1 : 0);
    return { x, age: Math.max(age ?? model.unknown_age_days, 1), y: isPreToken(p) ? 0 : 1 };
  });
  return { rows, bigCategories, logTvlMu, logTvlSd, chgMu, chgSd };
}

/** The fitted Weibull: theta is [beta..., log k]. */
interface WeibullFit {
  theta: number[];
  /** The fitted shape k = exp(theta[last]). */
  k: number;
  nll: number;
}

/**
 * The penalised negative log-likelihood of the current-status Weibull, and
 * its analytic gradient. theta is [beta (d), log k]. log u is clamped to
 * [-30, 30] so no exponent overflows; the ridge penalty (lambda) touches
 * every coefficient but the intercept.
 *
 * For one observation, u = (age / lambda)^k with log lambda = x.beta:
 *   y = 1 contributes log(1 - exp(-u));
 *   y = 0 contributes -u.
 * The gradient follows from d log u / d beta = -k x and d log u / d log k =
 * log u, with the helper g(u) = u / (exp(u) - 1) tending to 1 as u -> 0 and
 * to 0 as u grows.
 */
function weibullNllGrad(theta: number[], rows: OddsRow[], lambda: number): { value: number; grad: number[] } {
  const d = theta.length - 1;
  const k = Math.exp(theta[d]!);
  let value = 0;
  const grad = new Array<number>(theta.length).fill(0);
  for (const r of rows) {
    let logLam = 0;
    for (let j = 0; j < d; j++) logLam += theta[j]! * r.x[j]!;
    const s = Math.min(30, Math.max(-30, k * (Math.log(r.age) - logLam)));
    const u = Math.exp(s);
    // g(u) = u / (exp(u) - 1): the derivative of log(1 - exp(-u)) in log u.
    const g = u > 50 ? 0 : u / Math.expm1(u);
    const w = r.y === 1 ? g : -u;
    if (r.y === 1) {
      value -= u < 1e-10 ? Math.log(u) : Math.log1p(-Math.exp(-u));
    } else {
      value += u;
    }
    for (let j = 0; j < d; j++) grad[j]! += k * r.x[j]! * w;
    grad[d]! -= w * s;
  }
  for (let j = 1; j < d; j++) {
    value += lambda * theta[j]! ** 2;
    grad[j]! += 2 * lambda * theta[j]!;
  }
  return { value, grad };
}

/** The dot product of two equal-length vectors. */
function dot(u: number[], v: number[]): number {
  let s = 0;
  for (let i = 0; i < u.length; i++) s += u[i]! * v[i]!;
  return s;
}

/**
 * BFGS minimisation of a smooth function, deterministic: fixed start, an
 * Armijo backtracking line search, and the standard inverse-Hessian update
 * (skipped when the curvature condition fails). Returns the best point
 * found and its value. No randomness anywhere.
 */
function bfgs(
  start: number[],
  fn: (x: number[]) => { value: number; grad: number[] },
  maxIter = 500,
  gradTol = 1e-7,
): { x: number[]; value: number } {
  const n = start.length;
  let x = [...start];
  let { value, grad } = fn(x);
  // The inverse Hessian starts as the identity.
  const h: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let iter = 0; iter < maxIter; iter++) {
    let gmax = 0;
    for (const g of grad) gmax = Math.max(gmax, Math.abs(g));
    if (gmax < gradTol) break;
    // Search direction p = -H g.
    const p = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += h[i]![j]! * grad[j]!;
      p[i] = -s;
    }
    const slope = dot(grad, p);
    if (!(slope < 0)) break;
    // Backtracking line search (Armijo, c = 1e-4).
    let step = 1;
    let next = x.map((xi, i) => xi + step * p[i]!);
    let trial = fn(next);
    let tries = 0;
    while (trial.value > value + 1e-4 * step * slope && tries < 60) {
      step *= 0.5;
      next = x.map((xi, i) => xi + step * p[i]!);
      trial = fn(next);
      tries++;
    }
    if (trial.value >= value) break;
    const s = next.map((xi, i) => xi - x[i]!);
    const y = trial.grad.map((gi, i) => gi - grad[i]!);
    const sy = dot(s, y);
    if (sy > 1e-12) {
      // H <- (I - rho s y^T) H (I - rho y s^T) + rho s s^T, rho = 1 / (s.y).
      const rho = 1 / sy;
      const hy = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += h[i]![j]! * y[j]!;
        hy[i] = sum;
      }
      const yhy = dot(y, hy);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          h[i]![j]! +=
            rho * rho * (sy + yhy) * s[i]! * s[j]! - rho * (s[i]! * hy[j]! + hy[i]! * s[j]!);
        }
      }
    }
    x = next;
    value = trial.value;
    grad = trial.grad;
  }
  return { x, value };
}

/** Fit the Weibull on a set of odds rows, from two starting shapes, keeping the better fit. */
function fitWeibull(rows: OddsRow[], lambda: number): WeibullFit {
  const d = rows[0]!.x.length;
  const fn = (theta: number[]) => weibullNllGrad(theta, rows, lambda);
  let best: WeibullFit | null = null;
  for (const k0 of [0.5, 1.0]) {
    const start = new Array<number>(d + 1).fill(0);
    start[0] = Math.log(700);
    start[d] = Math.log(k0);
    const { x, value } = bfgs(start, fn);
    if (best === null || value < best.nll) best = { theta: x, k: Math.exp(x[d]!), nll: value };
  }
  return best!;
}

/** The Weibull CDF at age t for one design row under a fitted model. */
function weibullCdf(age: number, x: number[], fit: WeibullFit): number {
  const d = x.length;
  let logLam = 0;
  for (let j = 0; j < d; j++) logLam += fit.theta[j]! * x[j]!;
  const s = Math.min(30, Math.max(-30, fit.k * (Math.log(Math.max(age, 1)) - logLam)));
  return 1 - Math.exp(-Math.exp(s));
}

/** One protocol's launch odds: P(launch within the horizon | not launched yet), clipped to the model's floor and cap. */
function launchOdds(row: OddsRow, fit: WeibullFit, model: ModelConstants): number {
  const f0 = weibullCdf(row.age, row.x, fit);
  const f1 = weibullCdf(row.age + model.odds_horizon_days, row.x, fit);
  const odds = (f1 - f0) / Math.max(1 - f0, 1e-9);
  return Math.min(model.odds_cap, Math.max(model.odds_floor, odds));
}

/** Log-loss of predicted probabilities against binary outcomes, and the AUC (Mann-Whitney, ties averaged). */
function logLossAuc(predicted: number[], actual: number[]): { logLoss: number; auc: number } {
  const eps = 1e-12;
  let ll = 0;
  for (let i = 0; i < predicted.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, predicted[i]!));
    ll -= actual[i] === 1 ? Math.log(p) : Math.log(1 - p);
  }
  const pos = predicted.filter((_, i) => actual[i] === 1);
  const neg = predicted.filter((_, i) => actual[i] === 0);
  const all = [...pos, ...neg];
  const ranks = ranksOf(all);
  let rankSum = 0;
  for (let i = 0; i < pos.length; i++) rankSum += ranks[i]!;
  const auc = pos.length === 0 || neg.length === 0 ? 0.5 : (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
  return { logLoss: ll / predicted.length, auc };
}

/** The log-loss of always predicting the base rate. */
function baseRateLogLoss(rate: number): number {
  const p = Math.min(0.999999, Math.max(0.000001, rate));
  return -(p * Math.log(p) + (1 - p) * Math.log(1 - p));
}

/**
 * Validate the odds model two ways, both computed from the snapshot:
 * 5-fold cross-validation over a seeded shuffle, and a time-held-out split
 * that trains on the earliest-listed 70% (plus every undated protocol) and
 * scores the latest-listed 30%. Each test predicts "records a token" at the
 * protocol's own age — the CDF the survival model implies — and reports
 * log-loss against the base rate and the AUC.
 */
function validateOdds(snapshot: Snapshot, design: OddsDesign, model: ModelConstants): OddsValidation {
  const ordered = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const baseRate = meanOf(design.rows.map((r) => r.y));
  // 5-fold CV over a seeded shuffle of the design rows.
  const stream = seededStream(42);
  const idx = design.rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(stream() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const folds = 5;
  const cvPred: number[] = [];
  const cvActual: number[] = [];
  for (let f = 0; f < folds; f++) {
    const testIdx = idx.filter((_, i) => i % folds === f);
    const trainIdx = idx.filter((_, i) => i % folds !== f);
    const fit = fitWeibull(trainIdx.map((i) => design.rows[i]!), model.odds_lambda);
    for (const i of testIdx) {
      const r = design.rows[i]!;
      cvPred.push(weibullCdf(r.age, r.x, fit));
      cvActual.push(r.y);
    }
  }
  const cv = logLossAuc(cvPred, cvActual);
  // Time-held-out: train on the earliest-listed 70% plus the undated, test on the latest 30%.
  const dated = ordered
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.listed_at !== null)
    .sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : a.p.listed_at! > b.p.listed_at! ? 1 : a.p.slug < b.p.slug ? -1 : 1));
  const undatedIdx = ordered.map((p, i) => ({ p, i })).filter(({ p }) => p.listed_at === null).map(({ i }) => i);
  const cut = Math.floor(dated.length * 0.7);
  const trainIdx = [...dated.slice(0, cut).map(({ i }) => i), ...undatedIdx].sort((a, b) => a - b);
  const testIdx = dated.slice(cut).map(({ i }) => i);
  const heldFit = fitWeibull(trainIdx.map((i) => design.rows[i]!), model.odds_lambda);
  const heldPred = testIdx.map((i) => weibullCdf(design.rows[i]!.age, design.rows[i]!.x, heldFit));
  const heldActual = testIdx.map((i) => design.rows[i]!.y);
  const held = logLossAuc(heldPred, heldActual);
  const heldRate = meanOf(heldActual);
  return {
    base_rate: round4(baseRate),
    base_rate_log_loss: round4(baseRateLogLoss(baseRate)),
    cv_log_loss: round4(cv.logLoss),
    cv_auc: round4(cv.auc),
    heldout_log_loss: round4(held.logLoss),
    heldout_auc: round4(held.auc),
    heldout_base_rate_log_loss: round4(baseRateLogLoss(heldRate)),
    heldout_n: testIdx.length,
  };
}

/** The fitted odds model as a dashboard record. */
function oddsFitInfo(fit: WeibullFit, design: OddsDesign, model: ModelConstants): OddsFitInfo {
  const effects: Record<string, number> = {};
  for (let j = 0; j < design.bigCategories.length; j++) {
    effects[design.bigCategories[j]!] = round4(fit.theta[3 + j]!);
  }
  return {
    shape_k: round4(fit.k),
    lambda: model.odds_lambda,
    horizon_days: model.odds_horizon_days,
    intercept: round4(fit.theta[0]!),
    log_tvl: round4(fit.theta[1]!),
    change_7d: round4(fit.theta[2]!),
    category_effects: effects,
    big_categories: design.bigCategories,
  };
}

// --------------------------------------------------------------- board rows

/** One row of board.json: a launch candidate ranked by expected value. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  /** Every board row is a launch: derivatives are listed separately, not ranked. */
  board_class: 'launch';
  on_watchlist: boolean;
  age_days: number | null;
  /** The expected value of the launch: gross implied value x launch odds. The board ranks on this. */
  implied_value_usd: number;
  gross_value_usd: number;
  launch_odds: number;
  /** farm or watch — never skip: a watchlist row is always worth watching. */
  verdict: 'farm' | 'watch';
  value_per_user_usd: number;
  plan_cost_usd: number;
  farmer_count: number;
  model: {
    size_multiple: number;
    category_factor: number;
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  gross_value_usd: number;
  launch_odds: number;
  verdict: 'farm' | 'watch';
  value_per_user_usd: number;
  plan_cost_usd: number;
  farmer_count: number;
  on_watchlist: boolean;
  size_multiple: number;
  category_factor: number;
  growth_multiplier: number;
  age_multiplier: number;
  farm_steps: string[];
}

/** A derivative protocol: listed in the dashboard with its gross value, never ranked as a launch. */
export interface DerivativeRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  gross_value_usd: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the dashboard shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One of the KPI strip's top movers: a pre-token protocol by 7-day TVL growth. No rank is shown. */
export interface TopMover {
  slug: string;
  name: string;
  change_7d: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  /** The calibration record: the fitted power law and its backtests. */
  calibration: CalibrationInfo;
  /** The fitted odds model and its validation. */
  odds_fit: OddsFitInfo;
  odds_validation: OddsValidation;
  /** Protocols in the snapshot: the coverage the KPI strip reports against. */
  snapshot_size: number;
  watchlist_size: number;
  board_size: number;
  derivative_size: number;
  live_size: number;
  /** The three fastest-growing pre-token protocols by 7-day TVL change. */
  top_movers: TopMover[];
  rows: RadarRow[];
  derivatives: DerivativeRow[];
  live: LiveRow[];
}

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// --------------------------------------------------------------- farm verdicts

/** Typical gas for one transaction on a chain, in whole dollars, from the chain's own fees. */
function gasUsd(chain: string): number {
  const table: Record<string, number> = {
    Ethereum: 8,
    Solana: 1,
    Base: 1,
    Arbitrum: 1,
    Optimism: 1,
    Polygon: 1,
    Avalanche: 1,
    Binance: 1,
    Tron: 1,
    Monad: 1,
    'Hyperliquid L1': 1,
    Bitcoin: 5,
  };
  return table[chain] ?? 2;
}

/** The capital a farm plan deploys, by the protocol's TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 10_000_000) return 100;
  return 50;
}

/** How long a farm plan holds, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * What a farm plan costs out of pocket: the capital it deploys plus the gas
 * for the bridge, the setup, one weekly action across the hold, and the exit.
 * The capital is counted in full — it is locked for the hold, so the verdict
 * treats it as committed money, not as a free option.
 */
export function planCostUsd(p: SnapshotProtocol, age: number | null): number {
  const gas = gasUsd(chainOf(p));
  const weeks = Math.ceil(holdDaysFor(age) / 7);
  return capitalFor(p) + gas * (3 + weeks);
}

/**
 * How many farmers share the airdrop, estimated from TVL: 25 times the
 * square root of TVL in millions, clamped to 100..5000. Sublinear, because
 * TVL concentrates in a few large wallets while the farmer count grows
 * slowly. An assumption, stated as one on the dashboard — the snapshot
 * records no farmer count.
 */
export function farmerCountFor(p: SnapshotProtocol): number {
  return Math.max(100, Math.min(5000, Math.round(25 * Math.sqrt(p.tvl_usd / 1_000_000))));
}

/**
 * The estimated airdrop value per farmer: the launch's expected value times
 * the farmer share (10% of the token's value to farmers, a typical airdrop
 * allocation, stated as an assumption), divided by the estimated farmer
 * count. This is the number the verdict is built on — a per-user figure,
 * not a protocol total divided by a plan cost.
 */
export function valuePerUserUsd(expectedValueUsd: number, p: SnapshotProtocol, model: ModelConstants = MODEL): number {
  return Math.round((expectedValueUsd * model.farmer_share) / farmerCountFor(p));
}

/**
 * The farm verdict: farm when the estimated value per farmer clears three
 * times the plan's cost — a margin that pays for the gas and the locked
 * capital with room to spare — and watch otherwise. There is no skip: a
 * protocol on the board is a launch candidate, and the worst advice the
 * radar gives about one is to watch it.
 */
export function farmVerdict(expectedValueUsd: number, p: SnapshotProtocol, age: number | null, model: ModelConstants = MODEL): 'farm' | 'watch' {
  return valuePerUserUsd(expectedValueUsd, p, model) >= model.verdict_multiple * planCostUsd(p, age) ? 'farm' : 'watch';
}

// --------------------------------------------------------------- farm plans

/** How to get funds onto a chain, in words specific to that chain's own bridge routes. */
function bridgeFor(capital: number, chain: string): string {
  switch (chain) {
    case 'Ethereum':
      return `Send $${capital} of USDC to the farm wallet on Ethereum — no bridge needed, the farm runs on mainnet.`;
    case 'Solana':
      return `Bridge $${capital} of USDC to Solana with Wormhole or Allbridge, and take native USDC, not a wrapped copy.`;
    case 'Base':
    case 'Arbitrum':
    case 'Optimism':
      return `Bridge $${capital} of USDC to ${chain} from Ethereum mainnet with the chain's official bridge.`;
    case 'Polygon':
      return `Bridge $${capital} of USDC to Polygon from Ethereum with the Polygon PoS bridge.`;
    case 'Avalanche':
      return `Bridge $${capital} of USDC to Avalanche with the Avalanche Bridge (Core) or another canonical route.`;
    case 'Binance':
      return `Bridge $${capital} of USDC to BNB Chain with the official BNB bridge or Celer.`;
    case 'Tron':
      return `Move $${capital} of USDT onto Tron with a Tron-supported bridge, or send it natively from an exchange.`;
    case 'Bitcoin':
      return `Move $${capital} to a Bitcoin-side wallet the protocol supports, following its own documented route.`;
    default:
      return `Bridge $${capital} of USDC to ${chain} with the bridge the protocol documents for this chain.`;
  }
}

/** The weekly action that keeps a wallet active, specific to the protocol's category. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `repay a small part of a borrow or top up the supply by $5 to $10`;
  }
  if (c.includes('dex')) {
    return `swap $5 to $10 through the pool, or add a little more liquidity`;
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('curator') || c.includes('allocator')) {
    return `deposit another $5 to $10 into the vault, or claim and restake its rewards`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `open and close one small position`;
  }
  if (c.includes('rwa')) {
    return `check the asset's yield accrual and add $5 to $10 while the window is open`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `restake any rewards the position pays out`;
  }
  if (c.includes('prediction')) {
    return `place one small position on a new market`;
  }
  if (c.includes('insurance')) {
    return `check the policy's status and renew cover before it lapses`;
  }
  if (c.includes('payment') || c.includes('card')) {
    return `route one small real payment through it`;
  }
  if (c.includes('basis')) {
    return `check the funding rate and rebalance if it has flipped`;
  }
  return `make one small deposit or swap on it`;
}

/** The category's main farming action, in words a reader can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name}'s lending market on ${chain} and leave it supplied.`;
  }
  if (c.includes('dex')) {
    return `Add $${capital} of liquidity to ${name}'s busiest pool on ${chain} — a stable pair if one is offered — and keep the LP position.`;
  }
  if (c.includes('yield') || c.includes('leveraged farm')) {
    return `Deposit $${capital} into ${name}'s main yield vault on ${chain} and hold the receipt token.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Allocate $${capital} to a ${name} curated vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('rwa')) {
    return `Buy $${capital} of ${name}'s tokenised asset on ${chain} and hold it in the farming wallet.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name}, open one small position, and close it after a week.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  }
  if (c.includes('prediction')) {
    return `Fund the wallet with $${capital} and place one market position on ${name}.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy for the full term.`;
  }
  if (c.includes('payment') || c.includes('card')) {
    return `Route $${capital} of spending through ${name} on ${chain} over the next month.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis strategy on ${chain} and keep the position.`;
  }
  if (c.includes('bridge')) {
    return `Route $${capital} through ${name} on ${chain} — bridge a real amount you actually need moved, and keep the receipt.`;
  }
  if (c.includes('cex')) {
    return `Open an account on ${name}, complete its verification, and deposit $${capital} to use its on-chain products.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with what it costs and
 * how long it takes. Every figure comes from the protocol's own record
 * (category, chains, TVL, age); no protocol name is ever special-cased. A
 * derivative row's plan says so up front — it farms yield and the parent
 * token's ecosystem, not a launch of its own — and its last step claims
 * nothing, because there is no token of its own to claim.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, kind: BoardClass = 'launch'): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  if (kind === 'derivative') {
    return [
      `Know what this is: ${p.name} is a wrapped, staked or bridged product of a token that already trades, so it has no launch of its own to farm — the plan below earns yield and positions you in the parent token's ecosystem. Cost: $0 to read. Time: 5 minutes.`,
      `${bridgeFor(capital, chain)} Cost: about $${gas} in bridge and gas fees. Time: about 10 minutes.`,
      `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${gas} of gas. Time: 15 minutes to set up.`,
      `Each week, ${weeklyFor(p)} so the wallet stays active across snapshots. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
      `Keep the position open for at least ${hold} days; the yield compounds and the parent ecosystem's snapshots reward long-held positions. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
      `There is no token of its own to claim — exit by unwinding the position on the protocol's own site, and never follow a claim link from DMs or ads. Cost: gas for the exit only. Time: 15 minutes.`,
    ];
  }
  return [
    `Set up a fresh wallet just for this farm and store its seed phrase offline on paper. Cost: $0 to create the wallet. Time: 5 minutes.`,
    `${bridgeFor(capital, chain)} Cost: about $${gas} in bridge and gas fees. Time: about 10 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${gas} of gas. Time: 15 minutes to set up.`,
    `Each week, ${weeklyFor(p)} so the wallet stays active across snapshots. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days; airdrop snapshots usually reward wallets active across several months. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `When a token is announced, claim only from the link the protocol publishes on its own site or X account — never from DMs or ads. Cost: gas for the claim only. Time: 15 minutes.`,
  ];
}

// --------------------------------------------------------------- the board

/**
 * The ranked board: every launch candidate in the snapshot, most valuable
 * first, ranks 1..N, by the EXPECTED value of the launch (gross implied
 * value times launch odds). Derivatives are not ranked — a wrapped product
 * has no launch of its own, so ranking it as one would put the biggest
 * wrapped products at the top of a launch radar. The dashboard lists them
 * separately with their gross values, so nothing is hidden.
 */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
  calibration?: CalibrationInfo,
  oddsFit?: WeibullFit,
  design?: OddsDesign,
): BoardRow[] {
  const cal = calibration ?? calibratePowerLaw(snapshot, model);
  const des = design ?? oddsDesign(snapshot, model);
  const fit = oddsFit ?? fitWeibull(des.rows, model.odds_lambda);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);
  const missing = snapshot.watchlist.filter((s) => !index.has(s));
  if (missing.length > 0) throw new SnapshotError(`watchlist slugs missing from protocols: ${missing.slice(0, 5).join(', ')}`);
  const ordered = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const rowBySlug = new Map(ordered.map((p, i) => [p.slug, des.rows[i]!]));
  const chosen = snapshot.protocols.filter((p) => isRankable(p));
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, cal.fit, cal.category_adjustments);
    const odds = launchOdds(rowBySlug.get(p.slug)!, fit, model);
    const expected = Math.max(1, Math.round(v.implied * odds));
    return { p, ...v, odds, expected };
  });
  scored.sort((a, b) => b.expected - a.expected || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    board_class: 'launch',
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.expected,
    gross_value_usd: s.implied,
    launch_odds: round4(s.odds),
    verdict: farmVerdict(s.expected, s.p, s.age, model),
    value_per_user_usd: valuePerUserUsd(s.expected, s.p, model),
    plan_cost_usd: planCostUsd(s.p, s.age),
    farmer_count: farmerCountFor(s.p),
    model: {
      size_multiple: s.sizeMult,
      category_factor: s.categoryFactor,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      age_multiplier: round4(s.ageMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, 'launch'),
  }));
}

/** The derivative rows: every pre-token protocol that is not a launch candidate, by gross value, for the dashboard's own view. */
export function derivativeRows(snapshot: Snapshot, model: ModelConstants = MODEL, calibration?: CalibrationInfo): DerivativeRow[] {
  const cal = calibration ?? calibratePowerLaw(snapshot, model);
  const chosen = snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p));
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, cal.fit, cal.category_adjustments);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s) => ({
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    gross_value_usd: s.implied,
    farm_steps: farmSteps(s.p, s.age, 'derivative'),
  }));
}

/** The live rows: EVERY protocol that records a token, by market cap where recorded, for the Already trading view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const live = snapshot.protocols.filter((p) => !isPreToken(p));
  live.sort((a, b) => (b.mcap_usd ?? -1) - (a.mcap_usd ?? -1) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return live.map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** The three fastest-growing pre-token protocols by 7-day TVL change. */
export function topMovers(snapshot: Snapshot): TopMover[] {
  const movers = snapshot.protocols
    .filter((p) => isPreToken(p) && typeof p.change_7d === 'number' && Number.isFinite(p.change_7d))
    .sort((a, b) => b.change_7d! - a.change_7d! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 3);
  return movers.map((p) => ({ slug: p.slug, name: p.name, change_7d: p.change_7d! }));
}

/** The dashboard's compact view of one board row. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    gross_value_usd: row.gross_value_usd,
    launch_odds: row.launch_odds,
    verdict: row.verdict,
    value_per_user_usd: row.value_per_user_usd,
    plan_cost_usd: row.plan_cost_usd,
    farmer_count: row.farmer_count,
    on_watchlist: row.on_watchlist,
    size_multiple: row.model.size_multiple,
    category_factor: row.model.category_factor,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Build the board and the dashboard's dataset in one pass, sharing the fits. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibratePowerLaw(snapshot, model);
  const design = oddsDesign(snapshot, model);
  const oddsFit = fitWeibull(design.rows, model.odds_lambda);
  const validation = validateOdds(snapshot, design, model);
  const board = buildBoard(snapshot, model, calibration, oddsFit, design);
  const derivatives = derivativeRows(snapshot, model, calibration);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    odds_fit: oddsFitInfo(oddsFit, design, model),
    odds_validation: validation,
    snapshot_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    derivative_size: derivatives.length,
    live_size: live.length,
    top_movers: topMovers(snapshot),
    rows: board.map(radarRow),
    derivatives,
    live,
  };
  return { board, radar };
}

// --------------------------------------------------------------- parsing

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// --------------------------------------------------------------- validation

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, fewer than the 100 the gate requires`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: window.RADAR, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
