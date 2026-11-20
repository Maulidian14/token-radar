# Launch Radar — make.fun token-radar-01

A token launch radar: it reads a sealed DefiLlama snapshot, finds the
protocols that record no token, ranks them by an implied launch value, and
hands in a web dashboard with the board, a detail view per protocol, and a
farm plan for each one.

## The model

One function, `impliedValue` in `lib/model.ts`, scores every protocol from
the snapshot's own figures — TVL, 7-day TVL growth, and how long it has run
with no token. No protocol name is special-cased.

The size multiple is self-calibrating: `calibrateTiers` derives it from the
snapshot's own live-token protocols at run time. Per TVL band it takes the
median of market-cap/TVL (the median, not the mean — a few ratios are
extreme attribution artefacts), falls back to the global median for bands
with fewer than 3 members, and enforces monotonicity with PAVA (pool
adjacent violators, weighted by band size) so a multiple never rises as
TVL grows. Only the method is hardcoded; every number comes from the
snapshot. The derived tiers are conservative — circulating market caps,
not fully diluted values — and no premium factor is assumed. Growth and
age are kept as conservative priors (weight 0.4), not calibrations: neither
correlates with market multiples in this snapshot.

```
sizeMultiple(tvl)  calibrated tier for the protocol's TVL band
                     (this snapshot: >= $5B -> 0.0337, >= $1B -> 0.0337,
                     >= $250M -> 0.0820, >= $50M -> 0.1691, under $50M -> 0.4187)
growthMult         1 + clamp(change_7d, -50, 100) / 100 * 0.4
ageMult            0.70 + min(age_days, 730) / 730 * 0.50
implied            max(1, round(tvl * sizeMultiple * growthMult * ageMult))
```

Model version: `launch-radar-2`.

A protocol is pre-token when the snapshot records no market cap, no
CoinGecko id and no symbol for it. Wrapped, staked and bridged products of
tokens that already trade — bridges, liquid staking, exchanges, versioned
pools — are left off the ranked board. The board covers every slug on the
snapshot's watchlist plus every other rankable pre-token protocol.
Protocols whose token already trades are shown separately, with the market's
own values, never mixed into the ranking.

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
