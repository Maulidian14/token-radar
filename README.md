# Launch Radar — make.fun token-radar-01

A token launch radar: it reads a sealed DefiLlama snapshot, finds the
protocols that record no token, ranks them by an implied launch value, and
hands in a web dashboard with the board, a detail view per protocol, and a
farm plan for each one.

## The model

One function, `impliedValue` in `lib/model.ts`, scores every protocol from
the snapshot's own figures — TVL, 7-day TVL growth, and how long it has run
with no token. No protocol name is special-cased.

The size multiple is self-calibrating: `calibratePowerLaw` fits it from the
snapshot's own live-token protocols at run time. Market cap grows with the
square root of TVL, so the fit is a power law, log10(mcap) = intercept +
slope * log10(TVL), fitted by Theil-Sen — the slope is the median of every
pairwise slope and the intercept the median residual, so the few extreme
ratios (aave-v2 18.96x, rain 400x — DefiLlama attribution artefacts) cannot
pull the line. The fit is smooth: a protocol's multiple falls gradually as
it grows, with no band edge where a 1% TVL difference doubles the implied
value. On top of the line, each category carries its median residual,
shrunk toward zero by n / (n + 15): a category with many live protocols
earns its adjustment, a category with one or two earns almost none. The
model is backtested two ways — 5-fold cross-validation over the live-token
protocols (deterministic folds, by slug) and a walk-forward backtest that
fits on earlier-listed live tokens and predicts the later-listed ones, over
six expanding windows — and the dashboard's model panel reports both. Only
the method is hardcoded; every number comes from the snapshot. The derived
fit is conservative — circulating market caps, not fully diluted values —
and no premium factor is assumed. Growth and age are kept as conservative
priors (weight 0.4), not calibrations: neither correlates with market
multiples in this snapshot. Growth and age coefficients, chain counts, OLS,
Huber and piecewise fits were all tried against both validations and all
rejected — none beat the baseline on both at once.

```
sizeMultiple(tvl)  fitted power law's effective multiple at this TVL:
                     10^intercept * tvl^(slope - 1)
                     (this snapshot: log10(mcap) = 2.7837 + 0.5554 * log10(TVL);
                     the multiple falls smoothly from x0.64 at $5M TVL to x0.03 at $5B)
categoryFactor     10^(shrunk median residual of the protocol's category)
growthMult         1 + clamp(change_7d, -50, 100) / 100 * 0.4
ageMult            0.70 + min(age_days, 730) / 730 * 0.50
implied            max(1, round(tvl * sizeMultiple * categoryFactor * growthMult * ageMult))
```

Model version: `launch-radar-4`.

A protocol is pre-token when the snapshot records no market cap, no
CoinGecko id and no symbol for it. The board ranks every pre-token protocol
in the snapshot — 342 rows — each classed as a launch (a launch of its own)
or a derivative (a wrapped, staked or bridged product of a token that
already trades, which farms the parent token's ecosystem rather than a new
launch). The board covers every slug on the snapshot's watchlist. Protocols
whose token already trades are shown separately, with the market's own
values, never mixed into the ranking.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` into the output directory. Two runs write identical bytes.

## Layout

- `main.ts` — the entrypoint (Node 22, standard library only, no network)
- `lib/model.ts` — the value model, the board builder, the farm plans
- `vendor/makefun-board.ts` — make.fun's dossier library, copied unchanged
- `dashboard/` — the page: `index.html`, `app.css`, `app.js` (no network)
- `screenshots/` — the board, a detail view, a filtered view
