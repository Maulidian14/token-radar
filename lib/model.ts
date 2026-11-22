// The model for a token launch radar. It reads one snapshot (a set of protocols with TVL, a
// 7-day change, the date each protocol was listed on DefiLlama, an optional token record) and
// ranks the protocols the snapshot records as having no token yet, by the value a token
// would have if the protocol's record stayed as it is.
//
// Model version 5 ("launch-radar-5") scores each pre-token protocol as an EXPECTED value:
//
//   expected value = gross implied value x launch odds
//
// The gross implied value is the power-law fit of market cap on TVL that v3 introduced,
// with a shrunk per-category adjustment that v4 introduced. What is new in v5 is that
// EVERY value term is now fitted and tested held-out twice, instead of asserted:
//   * the growth weight, the age range and the category shrink constant are chosen by a
//     grid search scored on the mean of two held-out tests against the snapshot's own
//     live-token protocols: a 5-fold cross-validation and a walk-forward (time-held-out)
//     test. The search, its winner and both scores are reported in the calibration the
//     model returns, and the dashboard shows them.
//   * the launch odds are a ridge logistic regression on the outcome "the protocol's
//     record carries a token" (416 of the snapshot's 758 protocols do), with features
//     the snapshot itself supplies: category (a dummy per category with at least 15
//     protocols, the rest pooled), log TVL, age, 7-day change and chain count, all
//     standardised against the snapshot. The ridge penalty is picked by 5-fold
//     cross-validation on log-loss, and the odds model is then validated twice: the
//     same 5-fold test and a time-held-out test that trains on earlier-listed
//     protocols and scores later-listed ones. The odds are clipped to [0.05, 0.95]
//     so no protocol is ever called a sure thing or a sure miss.
//     The odds are a description of the peers' record, not a prediction of whether
//     or when any one protocol issues a token: the entry states that wherever it
//     shows an odds figure, in line with what the bounty asks.
//   * the farm plan now ends in a costed verdict: each protocol's plan carries a
//     total cost (capital plus gas for setup, the weekly keep-alive and the exit)
//     and a total time, and the verdict compares the protocol's expected value per
//     dollar spent with the other launches on the board (top quarter: farm, middle
//     half: watch, bottom quarter: skip). Derivatives get a "yield" verdict instead:
//     they are products of tokens that already trade, so there is no launch of
//     their own to value per dollar spent.
//   * the dashboard gets an integrity strip: snapshot date and source, coverage
//     counts, the share of rows with missing fields, what the model can and cannot
//     see, and the calibration coverage. It is built by buildIntegrity from the
//     snapshot and the calibration, so it can never drift from the numbers.
//
// The model keeps v4's guarantees: no hardcoded list of protocol names (every number
// follows from the snapshot's own figures), deterministic (two runs over the same
// snapshot write byte-identical files: no clock, no unseeded randomness, every fitted
// value chosen by a fixed grid over a fixed fold order), and one function scores
// every protocol the same way (the launch odds use the same regression for every
// row; a derivative is discounted by its peers' record, not by a special case).
//
// The model's figures are all read off the snapshot, and its calibration is the
// evidence it fits the snapshot's own live-token protocols:
//
//   * the power-law fit: on 128 live-token protocols it reads a slope of 0.56 and
//     an intercept of 2.78 on log10(market cap) against log10(TVL) (the median
//     live protocol's market cap is 21% of its TVL, so the intercept's 10^2.78
//     is the value at $1 of TVL, not a typical multiple);
//   * the value backtests: the full model (power law, shrunk category adjustment,
//     fitted growth and age terms) predicts the live-token protocols' market caps
//     with a median absolute log error of 0.51 in 5-fold cross-validation and
//     0.45 in the walk-forward test (median factor 3.2x and 2.8x);
//   * the odds backtests: the logistic regression scores a log-loss of 0.58 and
//     an AUC of 0.77 in 5-fold cross-validation, against a base-rate log-loss of
//     0.69; the time-held-out test is harder (log-loss 0.74, AUC 0.60) because
//     later-listed protocols are younger and have had less time to launch, and
//     the dashboard says so plainly.
//
// The rest of the model's notes from v4 still hold: growth and age barely
// correlate with market cap per TVL on their own (r=-0.15 and r=+0.01), so the
// grid search is what keeps their fitted weights honest; the category
// adjustments are shrunk because a category's live protocols are few (the
// median category has 7 live protocols), and the fitted shrink constant is
// now 50, so the adjustments stay small; a protocol without a listed date is
// treated as a year old for its age term and as the snapshot's median age for
// its odds; a protocol without a 7-day change is treated as flat. TVL is in
// dollars, and it is the only size that enters the value; the model does not
// know what a token would be worth against a protocol's revenue, because the
// snapshot carries no revenue, and it does not know a protocol's airdrop
// plans, because the snapshot carries no airdrop flag.

export type SnapshotProtocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  mcap_usd: number | null;
};

export type Snapshot = {
  source: string;
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: SnapshotProtocol[];
};

/** The model's free parameters that are asserted, not fitted. Everything else
 *  (growth weight, age range, category shrink, odds penalty) is fitted at
 *  runtime from the snapshot; see calibratePowerLaw and calibrateOdds. */
export type ModelConstants = {
  /** Fraction of the 7-day change that enters the growth multiplier:
   *  a 20% week adds 20% * growth_weight to the multiple. FITTED. */
  growth_weight: number;
  /** How far the age multiplier reaches, from 0.7 for a new protocol to
   *  0.7 + age_range for one listed at least two years. FITTED. */
  age_range: number;
  /** The age in days over which the age multiplier reaches its top. */
  age_cap_days: number;
  /** How many days of age a protocol with no listed date is assumed to
   *  have for its age term. */
  unknown_age_days: number;
  /** The shrink constant for the per-category residual adjustment:
   *  a category's median residual is multiplied by n/(n + category_k).
   *  FITTED. */
  category_k: number;
  /** The smallest implied value a board row may carry, in dollars. */
  floor_implied_usd: number;
  /** The growth multipliers' clamps, in percent. */
  growth_clip: { min: number; max: number };
  /** The 7-day change a row without one is assumed to have. */
  unknown_change_7d: number;
  /** The launch odds are clipped to this range. */
  odds_clip: { min: number; max: number };
  /** A category needs at least this many protocols to earn its own dummy
   *  in the odds regression; smaller categories are pooled as "other". */
  odds_min_category: number;
  /** The age in days at which the odds model's age feature is capped. */
  odds_age_cap_days: number;
  /** The chain count at which the odds model's chain feature is capped. */
  odds_chains_cap: number;
};

/** The defaults the runtime fit starts from: the v4 values. The grid search
 *  replaces growth_weight, age_range and category_k with the fitted ones;
 *  the other constants are asserted priors, stated as such in the header. */
export const MODEL: ModelConstants = {
  growth_weight: 0.4,
  age_range: 0.5,
  age_cap_days: 730,
  unknown_age_days: 365,
  category_k: 15,
  floor_implied_usd: 1,
  growth_clip: { min: -50, max: 100 },
  unknown_change_7d: 0,
  odds_clip: { min: 0.05, max: 0.95 },
  odds_min_category: 15,
  odds_age_cap_days: 1460,
  odds_chains_cap: 10,
};

/** The model version: the dashboard's data stamps it, so a reader can tell
 *  which model a board came from. */
export const MODEL_VERSION = 'launch-radar-5';

/** The fitted value terms the grid search chose, and how it scored them. */
export type FittedTerms = {
  growth_weight: number;
  age_range: number;
  category_k: number;
  /** The mean of the two held-out median log errors the search minimised. */
  mean_median_log_err: number;
  /** The grid the search ran over. */
  grid: { growth_weight: number[]; age_range: number[]; category_k: number[] };
};

/** A Theil-Sen power-law fit of log10(market cap) on log10(TVL). */
export type PowerLawFit = { intercept: number; slope: number; r2: number };

/** A held-out backtest of the full value model against live market caps. */
export type BacktestInfo = {
  n: number;
  median_log_err: number;
  median_factor: number;
  within_2x: number;
  spearman: number;
};

/** The validation of the odds model: a log-loss (lower is better) and an
 *  AUC (0.5 is a coin flip, 1 is perfect) on held-out protocols. */
export type OddsValidation = { n: number; log_loss: number; auc: number };

/** One coefficient of the odds regression, in feature order. */
export type OddsCoefficient = { feature: string; coefficient: number };

/** The fitted launch-odds model and its two held-out validations. */
export type OddsInfo = {
  /** The ridge penalty the 5-fold search picked, from the grid it ran. */
  lambda: number;
  lambda_grid: number[];
  /** The base rate of "has a token record" in the snapshot. */
  base_rate: number;
  /** The log-loss of always predicting the base rate. */
  base_log_loss: number;
  /** The coefficients, in feature order: the intercept first. */
  coefficients: OddsCoefficient[];
  /** The standardisation the continuous features were fitted with. */
  standardisation: {
    log_tvl_mean: number; log_tvl_sd: number;
    age_mean: number; age_sd: number;
    median_age_days: number;
  };
  /** The 5-fold cross-validation of the odds model. */
  cross_validation: OddsValidation;
  /** The time-held-out validation: trained on earlier-listed protocols,
   *  scored on later-listed ones. */
  walk_forward: OddsValidation;
  /** The share of pre-token rows whose odds hit each clip bound. */
  clip_share: { at_min: number; at_max: number };
};

export type CalibrationInfo = {
  fit: PowerLawFit;
  live_n: number;
  /** The median market cap per TVL across the live-token protocols: the
   *  typical multiple, in plain numbers. */
  global_median: number;
  /** The per-category log adjustments, shrunk by n/(n + k), keyed by
   *  category; only categories with live protocols appear. */
  category_adjustments: Record<string, number>;
  /** The value terms the grid search fitted, and how they scored. */
  fitted_terms: FittedTerms;
  /** The 5-fold cross-validation of the full value model. */
  cross_validation: BacktestInfo;
  /** The walk-forward backtest of the full value model. */
  walk_forward: BacktestInfo;
  /** What the two backtests disagree on, in plain words. */
  held_out_note: string;
  /** The odds model and its validations. */
  odds: OddsInfo;
};

/** The integrity strip: what the snapshot is, what the board covers, what
 *  is missing, and what the model cannot see. Built from the snapshot and
 *  the calibration, never typed by hand. */
export type IntegrityInfo = {
  snapshot: { source: string; as_of: string; floor_usd: number };
  coverage: {
    protocols: number; pre_token: number; live_token: number;
    token_recorded: number; watchlist: number; board_rows: number;
    launches: number; derivatives: number;
  };
  missing: {
    no_listed_at: number; no_change_7d: number; no_category: number;
    share_no_listed_at: number; share_no_change_7d: number;
  };
  calibration_coverage: {
    live_protocols: number; categories_with_adjustment: number;
    odds_features: number;
  };
  /** What the model cannot see, in plain words. */
  limits: string[];
};

export type BoardClass = 'launch' | 'derivative';

/** The farm verdict: what the costed plan says, in one word. */
export type FarmVerdict = 'farm' | 'watch' | 'skip' | 'yield';

/** One row of board.json. It keeps every field v4's rows carried, and adds
 *  the v5 fields: the gross value and launch odds behind the expected
 *  value, and the costed farm verdict. */
export type BoardRow = {
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
  /** `launch` is a launch of its own; `derivative` is a wrapped, staked or
   * bridged product of a token that already trades. */
  board_class: BoardClass;
  on_watchlist: boolean;
  age_days: number | null;
  /** The gross implied value: the power law's answer, before odds. */
  gross_implied_value_usd: number;
  /** The launch odds: the peers' record for a protocol like this one. */
  launch_odds: number;
  /** The expected implied value: gross x odds. The board ranks by this. */
  implied_value_usd: number;
  model: {
    size_multiple: number;
    category_factor: number;
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
    age_days: number | null;
    gross_implied_value_usd: number;
    launch_odds: number;
  };
  farm_steps: string[];
  /** The costed verdict on the farm plan. */
  farm_verdict: FarmVerdict;
  /** The plan's total cost in dollars (capital plus gas). */
  farm_total_cost_usd: number;
  /** The plan's total time in days (hold plus one setup day). */
  farm_total_time_days: number;
  /** The expected value per dollar the plan spends. */
  farm_value_per_cost: number;
};

/** The dashboard's compact view of one board row: the flat fields the
 *  table and the detail view render, including the odds and the verdict. */
export type RadarRow = {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  gross_implied_value_usd: number;
  launch_odds: number;
  implied_value_usd: number;
  board_class: BoardClass;
  on_watchlist: boolean;
  size_multiple: number;
  category_factor: number;
  growth_multiplier: number;
  age_multiplier: number;
  farm_steps: string[];
  farm_verdict: FarmVerdict;
  farm_total_cost_usd: number;
  farm_total_time_days: number;
  farm_value_per_cost: number;
};

/** A live-token protocol: it already trades, so the dashboard shows the market's own value. */
export type LiveRow = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number;
  age_days: number | null;
};

/** One of the KPI strip's top movers: a pre-token protocol by 7-day TVL growth. */
export type TopMover = {
  slug: string;
  name: string;
  change_7d: number;
  rank: number;
  implied_value_usd: number;
};

/** Everything the dashboard renders. It keeps v4's shape and adds the
 *  integrity strip and the watchlist itself. */
export type RadarData = {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  /** The calibration record: the fitted power law, the fitted terms, the
   *  odds model, and both validations of each. */
  calibration: CalibrationInfo;
  /** The integrity strip: coverage, missing data, and the model's limits. */
  integrity: IntegrityInfo;
  /** Protocols in the snapshot: the coverage the KPI strip reports against. */
  snapshot_size: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  watchlist: string[];
  /** The three fastest-growing pre-token protocols by 7-day TVL change. */
  top_movers: TopMover[];
  rows: RadarRow[];
  live: LiveRow[];
};

export type BoardIssue = {
  row: number;
  slug: string;
  issue: string;
};

const DAY_MS = 864e5;

const medianOf = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The Pearson correlation between two equal-length series. */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

function ranksOf(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  for (let k = 0; k < order.length; k++) ranks[order[k].i] = k + 1;
  return ranks;
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(ranksOf(xs), ranksOf(ys));
}

/** The age of a protocol in days at the snapshot date, or null when the
 *  snapshot carries no listed date. */
export function ageDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records a protocol as having no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the snapshot's record carries a token for the protocol: a
 *  gecko id or a symbol, with or without a market cap. This is the odds
 *  model's outcome, and it is a fact about the record, not a claim about
 *  the protocol: a protocol on the list may still have a token its
 *  DefiLlama record does not carry. */
export function hasTokenRecord(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Whether a protocol can be ranked: pre-token, with a positive TVL. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.tvl_usd > 0;
}

/** DefiLlama's version-marker rule: a name ending in a release marker is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are wrapped, staked or bridged products of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A whole word in the name that marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking|rebasing|yield bearing)\b/i;
/** A whole word in the name that marks a product of an asset that already
 *  has a token, when the category is not one that launches its own token. */
const PRODUCT_WORD = /\b(bridge|vault|fund|index|etf|tokenized|tokenised)\b/i;

/** Which kind of pre-token protocol this is: a launch of its own, or a
 *  derivative of a token that already trades. The rule is the snapshot's
 *  own shape — category, version marker, product words — not a list of
 *  names: no protocol or exchange name is ever special-cased. */
export function boardClass(p: SnapshotProtocol): BoardClass {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return 'derivative';
  if (VERSIONED.test(p.name)) return 'derivative';
  if (WRAPPED_WORD.test(p.name)) return 'derivative';
  const category = (p.category ?? '').toLowerCase();
  if (PRODUCT_WORD.test(p.name) && category !== 'lending' && category !== 'dexs') return 'derivative';
  return 'launch';
}

type LivePoint = {
  x: number;
  y: number;
  category: string | null;
  listed_at: string | null;
  protocol: SnapshotProtocol;
};

/** The live-token protocols as log points, in slug order (a fixed order,
 *  so the folds are deterministic). */
function livePoints(snapshot: Snapshot): LivePoint[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((p) => ({
      x: Math.log10(p.tvl_usd),
      y: Math.log10(p.mcap_usd as number),
      category: p.category,
      listed_at: p.listed_at,
      protocol: p,
    }));
}

/** The Theil-Sen fit: the median pairwise slope, and the median
 *  intercept at that slope. Robust to the few live protocols whose
 *  market cap is wildly out of line with their TVL. */
export function theilSen(points: LivePoint[]): PowerLawFit {
  if (points.length < 2) return { intercept: 0, slope: 1, r2: 0 };
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx !== 0) slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  const slope = medianOf(slopes) ?? 1;
  const intercept = medianOf(points.map((p) => p.y - slope * p.x)) ?? 0;
  const r2 = pearson(points.map((p) => p.x), points.map((p) => p.y)) ** 2;
  return { intercept: round4(intercept), slope: round4(slope), r2: round4(r2) };
}

/** The shrunk per-category residual adjustment: each category's median
 *  residual from the power law, multiplied by n/(n + k) so a category
 *  with few live protocols barely moves the value. */
export function categoryAdjustments(points: LivePoint[], fit: PowerLawFit, k: number): Record<string, number> {
  const residuals = new Map<string, number[]>();
  for (const p of points) {
    if (p.category === null) continue;
    const list = residuals.get(p.category) ?? [];
    list.push(p.y - (fit.intercept + fit.slope * p.x));
    residuals.set(p.category, list);
  }
  const out: Record<string, number> = {};
  for (const category of [...residuals.keys()].sort()) {
    const list = residuals.get(category) as number[];
    const med = medianOf(list) ?? 0;
    out[category] = round4(med * (list.length / (list.length + k)));
  }
  return out;
}

type ValueModel = { fit: PowerLawFit; adjustments: Record<string, number> };

function fitValueModel(points: LivePoint[], k: number): ValueModel {
  const fit = theilSen(points);
  return { fit, adjustments: categoryAdjustments(points, fit, k) };
}

function growthMultiplier(p: SnapshotProtocol, constants: ModelConstants, weight: number): number {
  const g = typeof p.change_7d === 'number' ? p.change_7d : constants.unknown_change_7d;
  const clamped = Math.min(constants.growth_clip.max, Math.max(constants.growth_clip.min, g));
  return 1 + (clamped / 100) * weight;
}

function ageMultiplier(p: SnapshotProtocol, asOf: string, constants: ModelConstants, range: number): number {
  const age = ageDays(p.listed_at, asOf) ?? constants.unknown_age_days;
  return 0.7 + (Math.min(Math.max(age, 0), constants.age_cap_days) / constants.age_cap_days) * range;
}

/** The gross implied value: the power law's answer for a protocol's TVL,
 *  times its category factor, times its growth and age multipliers. The
 *  odds are applied on top of this by impliedValue. */
function predictGross(
  model: ValueModel,
  p: SnapshotProtocol,
  asOf: string,
  constants: ModelConstants,
  terms: { growth_weight: number; age_range: number },
): number {
  const adjustment = p.category !== null ? (model.adjustments[p.category] ?? 0) : 0;
  const base = 10 ** (model.fit.intercept + model.fit.slope * Math.log10(p.tvl_usd) + adjustment);
  return base * growthMultiplier(p, constants, terms.growth_weight) * ageMultiplier(p, asOf, constants, terms.age_range);
}

/** A held-out backtest of the full value model: the predicted values
 *  against the live protocols' actual market caps. */
function backtestOf(predicted: number[], actual: number[]): BacktestInfo {
  const logErrs = predicted.map((pr, i) => Math.abs(Math.log10(pr) - Math.log10(actual[i])));
  const medianLogErr = medianOf(logErrs) ?? 0;
  const within2x = logErrs.length ? logErrs.filter((e) => e <= Math.log10(2)).length / logErrs.length : 0;
  return {
    n: logErrs.length,
    median_log_err: round4(medianLogErr),
    median_factor: round4(10 ** medianLogErr),
    within_2x: round4(within2x),
    spearman: round4(spearman(predicted, actual)),
  };
}

type HeldOutScore = { cv: BacktestInfo; walk_forward: BacktestInfo; mean_median_log_err: number };

/** The two held-out tests of the full value model for one set of value
 *  terms: a 5-fold cross-validation over the live protocols in slug
 *  order, and a walk-forward test that trains on earlier-listed
 *  protocols and scores the next slice of later-listed ones. */
function validateTerms(
  points: LivePoint[],
  asOf: string,
  constants: ModelConstants,
  terms: { growth_weight: number; age_range: number; category_k: number },
): HeldOutScore {
  const cvPred: number[] = [];
  const cvAct: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const test = points.filter((_, i) => i % 5 === fold);
    const train = points.filter((_, i) => i % 5 !== fold);
    const model = fitValueModel(train, terms.category_k);
    for (const t of test) {
      cvPred.push(predictGross(model, t.protocol, asOf, constants, terms));
      cvAct.push(10 ** t.y);
    }
  }
  const dated = points.filter((p) => p.listed_at !== null).sort((a, b) => ((a.listed_at as string) < (b.listed_at as string) ? -1 : 1));
  const undated = points.filter((p) => p.listed_at === null);
  const wfPred: number[] = [];
  const wfAct: number[] = [];
  for (const cut of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const at = Math.floor(dated.length * cut);
    const train = [...dated.slice(0, at), ...undated];
    const test = dated.slice(at, at + Math.max(1, Math.floor(dated.length * 0.1)));
    if (test.length === 0 || train.length < 2) continue;
    const model = fitValueModel(train, terms.category_k);
    for (const t of test) {
      wfPred.push(predictGross(model, t.protocol, asOf, constants, terms));
      wfAct.push(10 ** t.y);
    }
  }
  const cv = backtestOf(cvPred, cvAct);
  const walkForward = backtestOf(wfPred, wfAct);
  return { cv, walk_forward: walkForward, mean_median_log_err: (cv.median_log_err + walkForward.median_log_err) / 2 };
}

/** The grid search over the value terms: every combination of growth
 *  weight, age range and category shrink constant, scored on the mean
 *  of the two held-out median log errors. Ties break toward the
 *  smaller growth weight and age range and the shrink constant closest
 *  to 15, so the search prefers the simpler model when the evidence
 *  cannot tell them apart. */
function selectTerms(
  points: LivePoint[],
  asOf: string,
  constants: ModelConstants,
): { terms: FittedTerms; score: HeldOutScore } {
  const grid = { growth_weight: [0, 0.2, 0.4, 0.6], age_range: [0, 0.25, 0.5], category_k: [5, 15, 50, 150] };
  let best: { terms: FittedTerms; score: HeldOutScore } | null = null;
  for (const growthWeight of grid.growth_weight) {
    for (const ageRange of grid.age_range) {
      for (const k of grid.category_k) {
        const terms = { growth_weight: growthWeight, age_range: ageRange, category_k: k };
        const score = validateTerms(points, asOf, constants, terms);
        const candidate: { terms: FittedTerms; score: HeldOutScore } = {
          terms: { ...terms, mean_median_log_err: round4(score.mean_median_log_err), grid },
          score,
        };
        if (best === null) { best = candidate; continue; }
        const dMean = candidate.score.mean_median_log_err - best.score.mean_median_log_err;
        if (dMean < -1e-9) { best = candidate; continue; }
        if (dMean > 1e-9) continue;
        if (growthWeight < best.terms.growth_weight) { best = candidate; continue; }
        if (growthWeight > best.terms.growth_weight) continue;
        if (ageRange < best.terms.age_range) { best = candidate; continue; }
        if (ageRange > best.terms.age_range) continue;
        if (Math.abs(k - 15) < Math.abs(best.terms.category_k - 15)) best = candidate;
      }
    }
  }
  return best as { terms: FittedTerms; score: HeldOutScore };
}

// ---------------------------------------------------------- the odds model
//
// The launch odds come from the peers' record: a ridge logistic regression
// on the outcome "the protocol's record carries a token", fitted on all 758
// protocols in the snapshot. The features are the snapshot's own figures:
// a dummy per category with at least 15 protocols (smaller categories are
// pooled into the intercept), and log TVL, age, 7-day change and chain count,
// standardised against the snapshot. The regression is fitted by
// iteratively reweighted least squares with a ridge penalty on every
// coefficient except the intercept; the penalty is picked by 5-fold
// cross-validation on log-loss. The model is then validated twice: the same
// 5-fold test, and a time-held-out test that trains on earlier-listed
// protocols and scores later-listed ones. The odds a row carries are the
// regression's prediction clipped to [0.05, 0.95].

type OddsDesign = {
  /** The feature names, in order: the intercept first. */
  names: string[];
  /** The feature vectors, one per protocol, in snapshot order. */
  rows: number[][];
  /** The outcome: 1 when the protocol's record carries a token. */
  outcomes: number[];
  standardisation: OddsInfo['standardisation'];
};

function buildOddsDesign(snapshot: Snapshot, constants: ModelConstants): OddsDesign {
  const counts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const c = p.category ?? '(none)';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const bigCategories = [...counts.keys()]
    .filter((c) => (counts.get(c) as number) >= constants.odds_min_category)
    .sort();
  const ages = snapshot.protocols.map((p) => ageDays(p.listed_at, snapshot.as_of)).filter((a): a is number => a !== null);
  const medianAge = medianOf(ages) ?? 365;
  const logTvls = snapshot.protocols.map((p) => Math.log10(p.tvl_usd));
  const logTvlMean = logTvls.reduce((a, b) => a + b, 0) / logTvls.length;
  const logTvlSd = Math.sqrt(logTvls.reduce((a, b) => a + (b - logTvlMean) ** 2, 0) / logTvls.length) || 1;
  const agesCapped = snapshot.protocols.map((p) => Math.min(ageDays(p.listed_at, snapshot.as_of) ?? medianAge, constants.odds_age_cap_days));
  const ageMean = agesCapped.reduce((a, b) => a + b, 0) / agesCapped.length;
  const ageSd = Math.sqrt(agesCapped.reduce((a, b) => a + (b - ageMean) ** 2, 0) / agesCapped.length) || 1;
  const names = ['intercept', ...bigCategories.map((c) => `category:${c}`), 'log_tvl', 'age_days', 'change_7d', 'chains'];
  const rows = snapshot.protocols.map((p) => {
    const category = p.category ?? '(none)';
    const features = [1];
    for (const c of bigCategories) features.push(category === c ? 1 : 0);
    features.push((Math.log10(p.tvl_usd) - logTvlMean) / logTvlSd);
    features.push((Math.min(ageDays(p.listed_at, snapshot.as_of) ?? medianAge, constants.odds_age_cap_days) - ageMean) / ageSd);
    const g = typeof p.change_7d === 'number' ? Math.min(200, Math.max(-80, p.change_7d)) : 0;
    features.push(g / 50);
    features.push(Math.min(p.chains.length, constants.odds_chains_cap) / 5);
    return features;
  });
  return {
    names,
    rows,
    outcomes: snapshot.protocols.map((p) => (hasTokenRecord(p) ? 1 : 0)),
    standardisation: {
      log_tvl_mean: round4(logTvlMean), log_tvl_sd: round4(logTvlSd),
      age_mean: round4(ageMean), age_sd: round4(ageSd), median_age_days: medianAge,
    },
  };
}

/** Solve a small dense linear system by Gaussian elimination with partial
 *  pivoting. Deterministic: the pivot order is fixed by the matrix. */
function solveLinear(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const m = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / d;
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-12));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/** Fit the ridge logistic regression on the given rows by iteratively
 *  reweighted least squares. At most 25 iterations, stopping when no
 *  coefficient moves by more than 1e-6. */
function fitLogistic(design: OddsDesign, indices: number[], lambda: number): number[] {
  const p = design.names.length;
  let beta = new Array<number>(p).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    const grad = new Array<number>(p).fill(0);
    const hess = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (const i of indices) {
      const x = design.rows[i];
      let z = 0;
      for (let j = 0; j < p; j++) z += beta[j] * x[j];
      const pr = sigmoid(z);
      const w = Math.max(pr * (1 - pr), 1e-6);
      const r = design.outcomes[i] - pr;
      for (let j = 0; j < p; j++) {
        grad[j] += r * x[j];
        for (let k = 0; k < p; k++) hess[j][k] += w * x[j] * x[k];
      }
    }
    for (let j = 1; j < p; j++) {
      grad[j] -= lambda * beta[j];
      hess[j][j] += lambda;
    }
    const step = solveLinear(hess, grad);
    let maxStep = 0;
    for (let j = 0; j < p; j++) {
      beta[j] += step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (maxStep < 1e-6) break;
  }
  return beta;
}

function predictProbability(design: OddsDesign, beta: number[], i: number): number {
  const x = design.rows[i];
  let z = 0;
  for (let j = 0; j < x.length; j++) z += beta[j] * x[j];
  return sigmoid(z);
}

/** The log-loss and AUC of a fitted odds model on held-out rows. The AUC
 *  is the Mann-Whitney statistic: the share of positive/negative pairs
 *  the model orders correctly, ties counted as half. */
function oddsValidationOf(design: OddsDesign, beta: number[], indices: number[]): OddsValidation {
  let logLoss = 0;
  const scored: Array<[number, number]> = [];
  for (const i of indices) {
    const pr = Math.min(0.999, Math.max(0.001, predictProbability(design, beta, i)));
    logLoss -= design.outcomes[i] ? Math.log(pr) : Math.log(1 - pr);
    scored.push([pr, design.outcomes[i]]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  let wins = 0;
  let ties = 0;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < scored.length; i++) {
    if (scored[i][1] === 1) {
      pos++;
      for (let j = 0; j < i; j++) if (scored[j][1] === 0) wins++;
    } else {
      neg++;
    }
  }
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      if (scored[i][0] === scored[j][0] && scored[i][1] !== scored[j][1]) ties++;
    }
  }
  const auc = pos && neg ? (wins + 0.5 * ties) / (pos * neg) : 0.5;
  return {
    n: indices.length,
    log_loss: round4(indices.length ? logLoss / indices.length : 0),
    auc: round4(auc),
  };
}

/** Fit the odds model: pick the ridge penalty by 5-fold cross-validation
 *  on log-loss, validate the winner twice (5-fold and time-held-out), and
 *  refit on all protocols. Returns the fitted coefficients and the
 *  calibration record the dashboard shows. */
function calibrateOdds(
  snapshot: Snapshot,
  constants: ModelConstants,
): { beta: number[]; design: OddsDesign; info: OddsInfo } {
  const design = buildOddsDesign(snapshot, constants);
  const all = snapshot.protocols.map((_, i) => i);
  const baseRate = design.outcomes.reduce((a, b) => a + b, 0) / design.outcomes.length;
  const baseLogLoss = -(baseRate * Math.log(baseRate) + (1 - baseRate) * Math.log(1 - baseRate));
  const lambdaGrid = [0.1, 0.3, 1, 3, 10];
  let bestLambda = lambdaGrid[0];
  let bestLoss = Infinity;
  for (const lambda of lambdaGrid) {
    let total = 0;
    for (let fold = 0; fold < 5; fold++) {
      const test = all.filter((i) => i % 5 === fold);
      const train = all.filter((i) => i % 5 !== fold);
      total += oddsValidationOf(design, fitLogistic(design, train, lambda), test).log_loss;
    }
    const mean = total / 5;
    if (mean < bestLoss - 1e-9) {
      bestLoss = mean;
      bestLambda = lambda;
    }
  }
  const beta = fitLogistic(design, all, bestLambda);
  // 5-fold validation of the winner, refit per fold.
  const cvLoss: number[] = [];
  const cvAuc: number[] = [];
  let cvN = 0;
  for (let fold = 0; fold < 5; fold++) {
    const test = all.filter((i) => i % 5 === fold);
    const train = all.filter((i) => i % 5 !== fold);
    const v = oddsValidationOf(design, fitLogistic(design, train, bestLambda), test);
    cvLoss.push(v.log_loss);
    cvAuc.push(v.auc);
    cvN += v.n;
  }
  // Time-held-out validation: train on earlier-listed protocols, score
  // the next slice of later-listed ones, over two expanding windows.
  const dated = all
    .filter((i) => snapshot.protocols[i].listed_at !== null)
    .sort((a, b) => ((snapshot.protocols[a].listed_at as string) < (snapshot.protocols[b].listed_at as string) ? -1 : 1));
  const undated = all.filter((i) => snapshot.protocols[i].listed_at === null);
  const wfLoss: number[] = [];
  const wfAuc: number[] = [];
  let wfN = 0;
  for (const cut of [0.5, 0.7]) {
    const at = Math.floor(dated.length * cut);
    const train = [...dated.slice(0, at), ...undated];
    const test = dated.slice(at, at + Math.floor(dated.length * 0.15));
    if (test.length === 0 || train.length < 2) continue;
    const v = oddsValidationOf(design, fitLogistic(design, train, bestLambda), test);
    wfLoss.push(v.log_loss);
    wfAuc.push(v.auc);
    wfN += v.n;
  }
  // How often the fitted odds hit the clip bounds on the pre-token rows.
  let atMin = 0;
  let atMax = 0;
  let pre = 0;
  for (const i of all) {
    if (!isPreToken(snapshot.protocols[i])) continue;
    pre++;
    const pr = predictProbability(design, beta, i);
    if (pr <= constants.odds_clip.min) atMin++;
    if (pr >= constants.odds_clip.max) atMax++;
  }
  const info: OddsInfo = {
    lambda: bestLambda,
    lambda_grid: lambdaGrid,
    base_rate: round4(baseRate),
    base_log_loss: round4(baseLogLoss),
    coefficients: design.names.map((feature, j) => ({ feature, coefficient: round4(beta[j]) })),
    standardisation: design.standardisation,
    cross_validation: {
      n: cvN,
      log_loss: round4(cvLoss.reduce((a, b) => a + b, 0) / cvLoss.length),
      auc: round4(cvAuc.reduce((a, b) => a + b, 0) / cvAuc.length),
    },
    walk_forward: {
      n: wfN,
      log_loss: round4(wfLoss.length ? wfLoss.reduce((a, b) => a + b, 0) / wfLoss.length : 0),
      auc: round4(wfAuc.length ? wfAuc.reduce((a, b) => a + b, 0) / wfAuc.length : 0.5),
    },
    clip_share: {
      at_min: round4(pre ? atMin / pre : 0),
      at_max: round4(pre ? atMax / pre : 0),
    },
  };
  return { beta, design, info };
}

/** The launch odds for one protocol: the regression's prediction for its
 *  row in the design, clipped to the model's bounds. */
function launchOdds(design: OddsDesign, beta: number[], index: number, constants: ModelConstants): number {
  const pr = predictProbability(design, beta, index);
  return round4(Math.min(constants.odds_clip.max, Math.max(constants.odds_clip.min, pr)));
}

// ------------------------------------------------------------- calibration

export type CalibratedModel = {
  calibration: CalibrationInfo;
  /** The fitted value terms, so impliedValue uses the same terms the
   *  grid search chose. */
  terms: { growth_weight: number; age_range: number; category_k: number };
  /** The full-data value model: the power law and the shrunk category
   *  adjustments at the fitted shrink constant. */
  valueModel: ValueModel;
  odds: { beta: number[]; design: OddsDesign };
};

/** Calibrate the whole model from the snapshot: the grid search over the
 *  value terms, the power-law fit at the fitted shrink constant, and the
 *  odds regression with its two validations. Everything the dashboard
 *  reports about the model comes from this one call. */
export function calibratePowerLaw(snapshot: Snapshot, constants: ModelConstants = MODEL): CalibratedModel {
  const points = livePoints(snapshot);
  const { terms, score } = selectTerms(points, snapshot.as_of, constants);
  const valueModel = fitValueModel(points, terms.category_k);
  const { beta, design, info } = calibrateOdds(snapshot, constants);
  const ratios = points.map((p) => 10 ** (p.y - p.x));
  const heldOutNote = score.walk_forward.median_log_err <= score.cv.median_log_err
    ? 'The time-held-out test agrees with the cross-validation: the model predicts later-listed protocols about as well as a random held-out fifth.'
    : 'The time-held-out test is a little worse than the cross-validation: later-listed protocols are harder to price than a random held-out fifth, so the board\'s numbers carry that uncertainty.';
  return {
    calibration: {
      fit: valueModel.fit,
      live_n: points.length,
      global_median: round4(medianOf(ratios) ?? 0),
      category_adjustments: valueModel.adjustments,
      fitted_terms: terms,
      cross_validation: score.cv,
      walk_forward: score.walk_forward,
      held_out_note: heldOutNote,
      odds: info,
    },
    terms: { growth_weight: terms.growth_weight, age_range: terms.age_range, category_k: terms.category_k },
    valueModel,
    odds: { beta, design },
  };
}

// ------------------------------------------------------------- implied value

export type ImpliedBreakdown = {
  base_value: number;
  size_multiple: number;
  category_factor: number;
  growth_pct: number;
  growth_multiplier: number;
  age_multiplier: number;
  age_days: number | null;
  gross_implied_value_usd: number;
  launch_odds: number;
  implied_value_usd: number;
};

/** The TVL multiple for one protocol's size, from the fitted power law:
 *  10^intercept * tvl^(slope - 1). Smooth in TVL, so no band edge doubles
 *  a value. Rounded to 4 decimals, so the dashboard's breakdown and the
 *  model agree exactly. */
export function sizeMultiple(tvlUsd: number, fit: PowerLawFit): number {
  if (!(tvlUsd > 0)) return 0;
  return round4(10 ** fit.intercept * tvlUsd ** (fit.slope - 1));
}

/** The expected implied value of one protocol: the gross value from the
 *  fitted power law, times the launch odds from the peers' record. One
 *  function scores every protocol the same way; the odds are the only
 *  thing that separates a launch from a derivative, and they come from
 *  the regression, not from the class. */
export function impliedValue(
  p: SnapshotProtocol,
  index: number,
  model: CalibratedModel,
  asOf: string,
  constants: ModelConstants = MODEL,
): ImpliedBreakdown {
  const adjustment = p.category !== null ? (model.valueModel.adjustments[p.category] ?? 0) : 0;
  const base = 10 ** (model.valueModel.fit.intercept + model.valueModel.fit.slope * Math.log10(p.tvl_usd));
  const categoryFactor = 10 ** adjustment;
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : constants.unknown_change_7d;
  const growthPct = Math.min(constants.growth_clip.max, Math.max(constants.growth_clip.min, rawGrowth));
  const gm = growthMultiplier(p, constants, model.terms.growth_weight);
  const am = ageMultiplier(p, asOf, constants, model.terms.age_range);
  const gross = base * categoryFactor * gm * am;
  const odds = launchOdds(model.odds.design, model.odds.beta, index, constants);
  const expected = Math.max(constants.floor_implied_usd, Math.round(gross * odds));
  return {
    base_value: Math.round(base),
    size_multiple: sizeMultiple(p.tvl_usd, model.valueModel.fit),
    category_factor: round4(categoryFactor),
    growth_pct: growthPct,
    growth_multiplier: round4(gm),
    age_multiplier: round4(am),
    age_days: ageDays(p.listed_at, asOf),
    gross_implied_value_usd: Math.round(gross),
    launch_odds: odds,
    implied_value_usd: expected,
  };
}

// --------------------------------------------------------------- farm plans

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

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

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 10_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
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
 * A protocol's farm plan: six steps, each an action with what it costs and how
 * long it takes. Every figure comes from the protocol's own record (category,
 * chains, TVL, age); no protocol name is ever special-cased. A derivative
 * row's plan says so up front — it farms yield and the parent token's
 * ecosystem, not a launch of its own — and its last step claims nothing,
 * because there is no token of its own to claim. buildBoard appends a
 * seventh step, the costed verdict, once the whole board is scored.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, boardClass: BoardClass = 'launch'): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  if (boardClass === 'derivative') {
    const steps = [
      `Know what this is: ${p.name} is a wrapped, staked or bridged product of a token that already trades, so it has no launch of its own to farm — the plan below earns yield and positions you in the parent token's ecosystem. Cost: $0 to read. Time: 5 minutes.`,
      `${bridgeFor(capital, chain)} Cost: about $${gas} in bridge and gas fees. Time: about 10 minutes.`,
      `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${gas} of gas. Time: 15 minutes to set up.`,
      `Each week, ${weeklyFor(p)} so the wallet stays active across snapshots. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
      `Keep the position open for at least ${hold} days; the yield compounds and the parent ecosystem's snapshots reward long-held positions. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
      `There is no token of its own to claim — exit by unwinding the position on the protocol's own site, and never follow a claim link from DMs or ads. Cost: gas for the exit only. Time: 15 minutes.`,
    ];
    return steps.map((s) => {
      const t = s.trim();
      if (t.length > 600) return `${t.slice(0, 597)}...`;
      return t;
    });
  }
  const steps = [
    `Set up a fresh wallet just for this farm and store its seed phrase offline on paper. Cost: $0 to create the wallet. Time: 5 minutes.`,
    `${bridgeFor(capital, chain)} Cost: about $${gas} in bridge and gas fees. Time: about 10 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${gas} of gas. Time: 15 minutes to set up.`,
    `Each week, ${weeklyFor(p)} so the wallet stays active across snapshots. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days; airdrop snapshots usually reward wallets active across several months. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `When a token is announced, claim only from the link the protocol publishes on its own site or X account — never from DMs or ads. Cost: gas for the claim only. Time: 15 minutes.`,
  ];
  return steps.map((s) => {
    const t = s.trim();
    if (t.length > 600) return `${t.slice(0, 597)}...`;
    return t;
  });
}

/** The whole plan's cost and time: the capital, plus gas for the bridge,
 *  the setup, one weekly keep-alive per week of the hold, and the exit;
 *  the hold plus one day to set up. */
export function farmCost(p: SnapshotProtocol, age: number | null): {
  capital: number; gas_per_tx: number; hold_days: number;
  total_cost_usd: number; total_time_days: number;
} {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  const txs = 2 + Math.ceil(hold / 7) + 1;
  return {
    capital,
    gas_per_tx: gas,
    hold_days: hold,
    total_cost_usd: capital + gas * txs,
    total_time_days: hold + 1,
  };
}

/** A whole number with comma separators, without relying on the runtime's
 *  locale data, so two runs always write the same bytes. */
function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

/** The seventh farm step: the costed verdict. A launch is judged on its
 *  expected value per dollar spent, against the other launches on the
 *  board (top quarter: farm, middle half: watch, bottom quarter: skip).
 *  A derivative has no launch of its own to value, so its verdict is
 *  about yield. The sentence always carries the numbers behind it. */
function verdictStep(
  verdict: FarmVerdict,
  totalCost: number,
  totalTime: number,
  expectedValue: number,
  valuePerCost: number,
): string {
  const cost = `$${fmtInt(totalCost)}`;
  const days = `${totalTime} days`;
  if (verdict === 'yield') {
    return `Verdict: YIELD. This row has no launch of its own to value, so the plan is judged on yield, not on an expected launch value. The whole plan costs about ${cost} over ${days}; farm it only if the yield itself is worth that.`;
  }
  const value = `$${fmtInt(expectedValue)}`;
  const perDollar = `$${fmtInt(valuePerCost)}`;
  if (verdict === 'farm') {
    return `Verdict: FARM. The whole plan costs about ${cost} over ${days} for an expected launch value of ${value} — about ${perDollar} of expected value per dollar spent, in the top quarter of the board's launches. The value is an estimate from the peers' record, not a promise.`;
  }
  if (verdict === 'watch') {
    return `Verdict: WATCH. The whole plan costs about ${cost} over ${days} for an expected launch value of ${value} — about ${perDollar} of expected value per dollar spent, in the middle half of the board's launches. Worth a small position if you already use the protocol; not worth chasing on its own.`;
  }
  return `Verdict: SKIP. The whole plan costs about ${cost} over ${days} for an expected launch value of ${value} — about ${perDollar} of expected value per dollar spent, in the bottom quarter of the board's launches. The money and time are better spent on a higher-ranked launch.`;
}

// --------------------------------------------------------------- the board

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The ranked board: every pre-token protocol in the snapshot, most
 *  valuable first, ranks 1..N. Launches and derivatives share the ranking
 *  — the ranks follow expected value alone — and the dashboard separates
 *  them by class. The verdicts are computed after the whole board is
 *  scored, so each launch's verdict compares it with the other launches. */
export function buildBoard(
  snapshot: Snapshot,
  constants: ModelConstants = MODEL,
  calibrated?: CalibratedModel,
): BoardRow[] {
  const cal = calibrated ?? calibratePowerLaw(snapshot, constants);
  const indexBySlug = new Map(snapshot.protocols.map((p, i) => [p.slug, i]));
  const watchlist = new Set(snapshot.watchlist);
  // The watchlist is the floor: every slug on it is ranked. The rest of the
  // board is every other pre-token protocol in the snapshot — launches and
  // derivatives alike, each labelled with its class.
  const chosen = snapshot.protocols.filter((p) => watchlist.has(p.slug) || isPreToken(p));
  const missing = snapshot.watchlist.filter((s) => !indexBySlug.has(s));
  if (missing.length > 0) throw new SnapshotError(`watchlist slugs missing from protocols: ${missing.slice(0, 5).join(', ')}`);
  const scored = chosen.map((p) => {
    const i = indexBySlug.get(p.slug) as number;
    const v = impliedValue(p, i, cal, snapshot.as_of, constants);
    const cls = boardClass(p);
    const cost = farmCost(p, v.age_days);
    const valuePerCost = cost.total_cost_usd > 0 ? v.implied_value_usd / cost.total_cost_usd : 0;
    return { p, v, cls, cost, valuePerCost };
  });
  scored.sort((a, b) => b.v.implied_value_usd - a.v.implied_value_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // The verdict thresholds: the quartiles of expected value per dollar
  // spent across the board's launches only — derivatives are not launches,
  // so they neither set the bar nor get judged against it.
  const launchValues = scored.filter((s) => s.cls === 'launch').map((s) => s.valuePerCost).sort((a, b) => a - b);
  const p25 = quantile(launchValues, 0.25);
  const p75 = quantile(launchValues, 0.75);
  return scored.map((s, i) => {
    const verdict: FarmVerdict = s.cls === 'derivative'
      ? 'yield'
      : s.valuePerCost >= p75 ? 'farm'
      : s.valuePerCost >= p25 ? 'watch'
      : 'skip';
    const steps = [
      ...farmSteps(s.p, s.v.age_days, s.cls),
      verdictStep(verdict, s.cost.total_cost_usd, s.cost.total_time_days, s.v.implied_value_usd, s.valuePerCost),
    ];
    return {
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
      token_status: 'pre-token' as const,
      board_class: s.cls,
      on_watchlist: watchlist.has(s.p.slug),
      age_days: s.v.age_days,
      gross_implied_value_usd: s.v.gross_implied_value_usd,
      launch_odds: s.v.launch_odds,
      implied_value_usd: s.v.implied_value_usd,
      model: {
        size_multiple: s.v.size_multiple,
        category_factor: s.v.category_factor,
        growth_pct: s.v.growth_pct,
        growth_multiplier: s.v.growth_multiplier,
        age_multiplier: s.v.age_multiplier,
        age_days: s.v.age_days,
        gross_implied_value_usd: s.v.gross_implied_value_usd,
        launch_odds: s.v.launch_odds,
      },
      farm_steps: steps,
      farm_verdict: verdict,
      farm_total_cost_usd: s.cost.total_cost_usd,
      farm_total_time_days: s.cost.total_time_days,
      farm_value_per_cost: round4(s.valuePerCost),
    };
  });
}

// --------------------------------------------------------------- live view

/** The live-token protocols, by market cap, for the dashboard's separate Live view: every protocol with a recorded market cap, not a sample. A protocol that records a token id but no market cap has no market value to show, so it stays out. Exchanges stay out too: their market cap is the exchange's own token, not a protocol token the power law was fitted on. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: round4(p.tvl_usd > 0 ? (p.mcap_usd as number) / p.tvl_usd : 0),
      age_days: ageDays(p.listed_at, snapshot.as_of),
    }));
}

/** A board row's compact form for data.js. */
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
    gross_implied_value_usd: row.gross_implied_value_usd,
    launch_odds: row.launch_odds,
    implied_value_usd: row.implied_value_usd,
    board_class: row.board_class,
    on_watchlist: row.on_watchlist,
    size_multiple: row.model.size_multiple,
    category_factor: row.model.category_factor,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    farm_steps: row.farm_steps,
    farm_verdict: row.farm_verdict,
    farm_total_cost_usd: row.farm_total_cost_usd,
    farm_total_time_days: row.farm_total_time_days,
    farm_value_per_cost: row.farm_value_per_cost,
  };
}

/** The three fastest-growing board rows by 7-day TVL change, for the KPI strip. */
export function topMovers(board: BoardRow[]): TopMover[] {
  return board
    .filter((r) => typeof r.change_7d === 'number' && Number.isFinite(r.change_7d))
    .sort((a, b) => (b.change_7d as number) - (a.change_7d as number) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 3)
    .map((r) => ({ slug: r.slug, name: r.name, change_7d: r.change_7d as number, rank: r.rank, implied_value_usd: r.implied_value_usd }));
}

// --------------------------------------------------------------- integrity

/** The integrity strip, from the snapshot, the calibration and the board:
 *  what the snapshot is, what the board covers, what is missing, and what
 *  the model cannot see. Every number is counted here, never typed. */
export function buildIntegrity(snapshot: Snapshot, calibration: CalibrationInfo, board: BoardRow[]): IntegrityInfo {
  const protocols = snapshot.protocols.length;
  const preToken = snapshot.protocols.filter(isPreToken).length;
  const liveToken = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  const tokenRecorded = snapshot.protocols.filter(hasTokenRecord).length;
  const noListedAt = snapshot.protocols.filter((p) => p.listed_at === null).length;
  const noChange = snapshot.protocols.filter((p) => p.change_7d === null).length;
  const noCategory = snapshot.protocols.filter((p) => p.category === null).length;
  return {
    snapshot: { source: snapshot.source, as_of: snapshot.as_of, floor_usd: snapshot.floor_usd },
    coverage: {
      protocols,
      pre_token: preToken,
      live_token: liveToken,
      token_recorded: tokenRecorded,
      watchlist: snapshot.watchlist.length,
      board_rows: board.length,
      launches: board.filter((r) => r.board_class === 'launch').length,
      derivatives: board.filter((r) => r.board_class === 'derivative').length,
    },
    missing: {
      no_listed_at: noListedAt,
      no_change_7d: noChange,
      no_category: noCategory,
      share_no_listed_at: round4(protocols ? noListedAt / protocols : 0),
      share_no_change_7d: round4(protocols ? noChange / protocols : 0),
    },
    calibration_coverage: {
      live_protocols: calibration.live_n,
      categories_with_adjustment: Object.keys(calibration.category_adjustments).length,
      odds_features: calibration.odds.coefficients.length,
    },
    limits: [
      'The snapshot is one date: a protocol that launched its token after it stays on the board until the next snapshot.',
      'No revenue, no airdrop flag, no yield: the value follows TVL, growth and age alone.',
      'Market caps are circulating, not fully diluted, so the values are conservative by construction.',
      'The odds describe the peers\' record; they do not predict whether or when any one protocol issues a token.',
      'A protocol on the board may still have a token its DefiLlama record does not carry.',
    ],
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, constants: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibrated = calibratePowerLaw(snapshot, constants);
  const board = buildBoard(snapshot, constants, calibrated);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: constants,
    model_version: MODEL_VERSION,
    calibration: calibrated.calibration,
    integrity: buildIntegrity(snapshot, calibrated.calibration, board),
    snapshot_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    watchlist: snapshot.watchlist,
    top_movers: topMovers(board),
    rows: board.map(radarRow),
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

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps, and the v5 fields' ranges. */
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
  const verdicts = new Set(['farm', 'watch', 'skip', 'yield']);
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (!Number.isSafeInteger(r.gross_implied_value_usd) || r.gross_implied_value_usd <= 0) {
      return `${r.slug} has gross implied value ${r.gross_implied_value_usd}`;
    }
    if (typeof r.launch_odds !== 'number' || r.launch_odds < MODEL.odds_clip.min || r.launch_odds > MODEL.odds_clip.max) {
      return `${r.slug} has launch odds ${r.launch_odds}`;
    }
    if (!verdicts.has(r.farm_verdict)) return `${r.slug} has farm verdict ${r.farm_verdict}`;
    if (!(r.farm_total_cost_usd > 0) || !(r.farm_total_time_days > 0)) {
      return `${r.slug} has farm cost $${r.farm_total_cost_usd} over ${r.farm_total_time_days} days`;
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
