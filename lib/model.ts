// Launch Radar — the value model for make.fun's token-radar-01.
//
// One sealed snapshot in, one ranked board out. The board ranks every protocol
// that records no token and is not a wrapped, staked or bridged product of a
// token that already trades: the watchlist (the floor) plus every other such
// protocol in the snapshot. Protocols whose token already trades are kept in a
// separate Live view and never enter the ranked board.
//
// Implied value comes only from the snapshot's own figures — TVL, 7-day TVL
// growth, and how long the protocol has run with no token — through one
// function, impliedValue, that scores every protocol the same way. No protocol
// name is ever special-cased.
//
// The size multiple is SELF-CALIBRATING: calibratePowerLaw fits it from the
// snapshot's own live-token protocols at run time, so the size curve is the
// snapshot's own evidence, not numbers asserted in code. Only the METHOD is
// hardcoded — the fit, the folds, the fallback:
//   1. Take every protocol that records a token (mcap_usd > 0) and a TVL.
//   2. Fit a power law, log10(mcap) = intercept + slope * log10(TVL), by
//      Theil-Sen: the slope is the MEDIAN of all pairwise slopes and the
//      intercept the median residual. The median, not least squares: a few
//      ratios are extreme (aave-v2 18.96x, rain 400x — DefiLlama attribution
//      artefacts) and least squares would follow them. The fit is smooth, so
//      a protocol's multiple falls gradually as it grows — no band edge where
//      a 1% TVL difference doubles the implied value.
//   3. Backtest the fit by 5-fold cross-validation over the same live-token
//      protocols (deterministic folds, by slug): fit on four folds, predict
//      the fifth, and report the median factor error, the share predicted
//      within 2x, and the rank correlation. The numbers in the dashboard's
//      model panel are that backtest, computed from this snapshot at run time.
//   On this snapshot the fit is log10(mcap) = 2.7837 + 0.5554 * log10(TVL):
//   market cap grows with the square root of TVL, so the largest protocols'
//   tokens really do trade at a far lower TVL multiple than a small
//   protocol's. These values are deliberately conservative: they are
//   circulating market caps, not fully diluted values, and a launch usually
//   prices above them. No premium factor is assumed.
//
//   sizeMultiple(tvl)  the fitted power law's effective multiple at this TVL:
//                      10^intercept * tvl^(slope - 1)
//   growthMult         1 + clamp(change_7d, -50, 100) / 100 * 0.4
//                      (no reported growth counts as 0%). Growth and age are
//                      kept as CONSERVATIVE PRIORS, not calibrations: in this
//                      snapshot neither correlates with mcap/TVL (r = -0.15
//                      and +0.01), so the growth weight is held low at 0.4.
//   ageMult            0.70 + min(age_days, 730) / 730 * 0.50
//                      (no listing date counts as 365 days)
//   implied            max(1, round(tvl * sizeMultiple * growthMult * ageMult))
//
// The model is deterministic: it reads only the snapshot and its own constants,
// never the clock and never randomness, so two runs write identical bytes.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard's model panel. */
export interface ModelConstants {
  /** Weight of 7-day growth in the growth multiplier. */
  growth_weight: number;
  /** 7-day growth is clamped to this range before it is applied. */
  growth_floor: number;
  growth_cap: number;
  /** Age multiplier: floor plus range, over this many days. */
  age_floor: number;
  age_range: number;
  age_days_cap: number;
  /** Age in days assumed when the snapshot lists no date. */
  unknown_age_days: number;
  /** Folds in the backtest cross-validation. */
  cv_folds: number;
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
};

/** The model's version label, shown in the dashboard. */
export const MODEL_VERSION = 'launch-radar-3';

/** The fitted power law: log10(mcap) = intercept + slope * log10(TVL). */
export interface PowerLawFit {
  /** log10(mcap) when log10(TVL) is 0. */
  intercept: number;
  /** How fast log10(mcap) grows with log10(TVL). */
  slope: number;
}

/** The backtest record: 5-fold cross-validation of the power-law fit over the live-token protocols. */
export interface BacktestInfo {
  /** Live-token protocols the backtest predicted. */
  n: number;
  /** Median factor error: the median prediction is within this multiple of the true market cap. */
  median_factor: number;
  /** Share of predictions within 2x of the true market cap. */
  within_2x: number;
  /** Spearman rank correlation between predicted and true market cap. */
  spearman: number;
}

/** The calibration record calibratePowerLaw derives from the snapshot, shown in the dashboard's model panel. */
export interface CalibrationInfo {
  /** Live-token protocols the calibration read. */
  live_count: number;
  /** Median mcap/TVL across all of them. */
  global_median: number;
  /** The fitted power law, rounded to 4 decimals — the fit the model uses. */
  fit: PowerLawFit;
  /** The cross-validation backtest of that fit. */
  backtest: BacktestInfo;
}

/** The median of a sorted-or-not list of numbers; null when empty. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One live-token protocol as a point in log space: log10(TVL) against log10(market cap). */
interface LogPoint {
  x: number;
  y: number;
}

/**
 * The Theil-Sen fit of y on x: the slope is the median of every pairwise slope,
 * the intercept the median of y - slope * x. A median fit, so the few extreme
 * attribution artefacts in the snapshot cannot pull the line. Deterministic:
 * medians of exact float arrays, in slug order.
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
  const mu = u.reduce((s, x) => s + x, 0) / n;
  const mv = v.reduce((s, x) => s + x, 0) / n;
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
 * Derive the size curve from the snapshot's own live-token protocols and
 * backtest it by cross-validation. The fit is a Theil-Sen power law on
 * (log10 TVL, log10 mcap); the backtest fits the same line on four folds and
 * predicts the fifth, over deterministic folds by slug, and reports the median
 * factor error, the share within 2x, and the rank correlation. Only the method
 * is hardcoded — every number comes from the snapshot. Deterministic: medians
 * and folds are pure functions of the snapshot's bytes.
 */
export function calibratePowerLaw(snapshot: Snapshot, model: ModelConstants = MODEL): CalibrationInfo {
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMedian = medianOf(allRatios) ?? 0;
  const points: LogPoint[] = live.map((p) => ({ x: Math.log10(p.tvl_usd), y: Math.log10(p.mcap_usd!) }));
  // Degenerate fallback, never taken on this snapshot: with fewer than two
  // live protocols no line can be fitted, so the multiple is the global median.
  const fit = points.length >= 2 ? theilSen(points) : { intercept: round4(Math.log10(Math.max(globalMedian, 1e-12))), slope: 1 };
  // 5-fold cross-validation of the same fit: deterministic folds by slug order.
  const folds = Math.max(2, Math.floor(model.cv_folds));
  const errors: number[] = [];
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let k = 0; k < folds; k++) {
    const test = points.filter((_, i) => i % folds === k);
    const train = points.filter((_, i) => i % folds !== k);
    if (test.length === 0 || train.length < 2) continue;
    const f = theilSen(train);
    for (const p of test) {
      const pred = 10 ** (f.intercept + f.slope * p.x);
      errors.push(Math.abs(Math.log10(pred) - p.y));
      predicted.push(pred);
      actual.push(10 ** p.y);
    }
  }
  const medianLogErr = medianOf(errors) ?? 0;
  const within2x = errors.length === 0 ? 0 : errors.filter((e) => e <= Math.log10(2)).length / errors.length;
  return {
    live_count: live.length,
    global_median: round4(globalMedian),
    fit,
    backtest: {
      n: errors.length,
      median_factor: round4(10 ** medianLogErr),
      within_2x: round4(within2x),
      spearman: round4(spearman(predicted, actual)),
    },
  };
}

/** How many live-token protocols the Live view carries, by market cap. */
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;

/** A whole-day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The TVL multiple for one protocol's size, from the fitted power law: 10^intercept * tvl^(slope - 1). Smooth in TVL, so no band edge doubles a value. Rounded to 4 decimals, so the dashboard's breakdown and the model agree exactly. */
export function sizeMultiple(tvlUsd: number, fit: PowerLawFit): number {
  return round4(10 ** fit.intercept * tvlUsd ** (fit.slope - 1));
}

/** The three multipliers and the implied value one protocol gets under `model` and the calibrated `fit`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fit: PowerLawFit,
): { implied: number; sizeMult: number; growthPct: number; growthMult: number; ageMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const sizeMult = sizeMultiple(protocol.tvl_usd, fit);
  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const ageMult = model.age_floor + (Math.min(Math.max(ageForModel, 0), model.age_days_cap) / model.age_days_cap) * model.age_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * sizeMult * growthMult * ageMult));
  return { implied, sizeMult, growthPct, growthMult, ageMult, age };
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

/** Whether a protocol may be ranked: pre-token, and not a wrapped, staked or bridged product. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** One row of board.json. */
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
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    size_multiple: number;
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
  on_watchlist: boolean;
  size_multiple: number;
  growth_multiplier: number;
  age_multiplier: number;
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

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  /** The calibration record: the fitted power law and its backtest. */
  calibration: CalibrationInfo;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The ranked board: every rankable protocol, most valuable first, ranks 1..N. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, calibration?: CalibrationInfo): BoardRow[] {
  const fit = (calibration ?? calibratePowerLaw(snapshot, model)).fit;
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);
  // The watchlist is the floor: every slug on it is ranked. The rest of the
  // board is every other rankable protocol in the snapshot.
  const chosen = snapshot.protocols.filter((p) => watchlist.has(p.slug) || isRankable(p));
  const missing = snapshot.watchlist.filter((s) => !index.has(s));
  if (missing.length > 0) throw new SnapshotError(`watchlist slugs missing from protocols: ${missing.slice(0, 5).join(', ')}`);
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, fit);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
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
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      size_multiple: s.sizeMult,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      age_multiplier: round4(s.ageMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
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
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with what it costs and how
 * long it takes. Every figure comes from the protocol's own record (category,
 * chains, TVL, age); no protocol name is ever special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
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

// --------------------------------------------------------------- live view

/** The live-token protocols, by market cap, for the dashboard's separate Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
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
    implied_value_usd: row.implied_value_usd,
    on_watchlist: row.on_watchlist,
    size_multiple: row.model.size_multiple,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibratePowerLaw(snapshot, model);
  const board = buildBoard(snapshot, model, calibration);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
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
