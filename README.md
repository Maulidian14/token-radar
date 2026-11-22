# Launch Radar — make.fun token-radar-01

A token launch radar: it reads a sealed DefiLlama snapshot, finds the
protocols that record no token, ranks them by an implied launch value, and
hands in a web dashboard with the board, a detail view per protocol, and a
farm plan for each one.

## The model

One function, `impliedValue` in `lib/model.ts`, scores every protocol from
the snapshot's own figures — TVL, 7-day TVL growth, how long it has run
with no token, and what comparable protocols did. No protocol name is
special-cased. The score is an expected value: the power law's gross
implied value, times the launch odds from the peers' record.

The size multiple is self-calibrating: `calibratePowerLaw` fits it from the
snapshot's own live-token protocols at run time. Market cap grows with the
square root of TVL, so the fit is a power law, log10(mcap) = intercept +
slope * log10(TVL), fitted by Theil-Sen — the slope is the median of every
pairwise slope and the intercept the median residual, so the few extreme
ratios (aave-v2 18.96x, rain 400x — DefiLlama attribution artefacts) cannot
pull the line. The fit is smooth: a protocol's multiple falls gradually as
it grows, with no band edge where a 1% TVL difference doubles the implied
value. On top of the line, each category carries its median residual,
shrunk toward zero by n / (n + k). The model is backtested two ways —
5-fold cross-validation over the live-token protocols (deterministic folds,
by slug) and a walk-forward backtest that fits on earlier-listed live
tokens and predicts the later-listed ones, over six expanding windows — and
the dashboard's model panel reports both. Only the method is hardcoded;
every number comes from the snapshot. The derived fit is conservative —
circulating market caps, not fully diluted values — and no premium factor
is assumed.

Every value term is fitted, not asserted: a grid search over 48
combinations picks the growth weight, the age range and the category shrink
constant, scored on the mean of the two held-out tests of the full model.
On this snapshot it picks growth weight 0.2, age range 0.25 and k = 150
(mean held-out median log error 0.4811; cross-validation 0.5162,
walk-forward 0.4459). Growth and age coefficients, chain counts, OLS,
Huber and piecewise fits were all tried against both validations in earlier
versions and all rejected — none beat the baseline on both at once.

The launch odds are a ridge logistic regression on the outcome "the
protocol's record carries a token" (416 of the snapshot's 758 protocols
do), with category dummies (one per category with at least 15 protocols),
log TVL, age, 7-day change and chain count, all standardised against the
snapshot. The ridge penalty is picked by 5-fold cross-validation on
log-loss (λ = 1 here), and the odds model is validated twice: 5-fold
(log-loss 0.5815, AUC 0.768, against a base-rate log-loss of 0.6884) and
time-held-out (log-loss 0.7372, AUC 0.6025 — harder, because later-listed
protocols are younger and have had less time to launch). The odds are
clipped to [0.05, 0.95]. They describe the peers' record; they do not
predict whether or when any one protocol issues a token.

Each farm plan ends in a costed verdict: the plan's total cost (capital
plus gas for setup, the weekly keep-alive and the exit) and total time,
and a verdict from the protocol's expected value per dollar spent against
the other launches on the board — top quarter farm, middle half watch,
bottom quarter skip. Derivatives get a yield verdict: there is no launch
of their own to value. The dashboard also carries an integrity strip —
snapshot date and source, coverage counts, missing-data shares, and what
the model cannot see — built from the snapshot and the calibration, so it
can never drift from the numbers.

```
sizeMultiple(tvl)  fitted power law's effective multiple at this TVL:
                     10^intercept * tvl^(slope - 1)
                     (this snapshot: log10(mcap) = 2.7837 + 0.5554 * log10(TVL);
                     the multiple falls smoothly from x0.64 at $5M TVL to x0.03 at $5B)
categoryFactor     10^(shrunk median residual of the protocol's category)
growthMult         1 + clamp(change_7d, -50, 100) / 100 * 0.2   (fitted)
ageMult            0.70 + min(age_days, 730) / 730 * 0.25       (fitted)
gross              tvl * sizeMultiple * categoryFactor * growthMult * ageMult
odds               ridge logistic regression on the peers' record, clipped [0.05, 0.95]
implied            max(1, round(gross * odds))
```

Model version: `launch-radar-5`.

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
