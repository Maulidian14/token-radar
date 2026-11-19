# Launch Radar — make.fun token-radar-01

A token launch radar: it reads a sealed DefiLlama snapshot, finds the
protocols that record no token, ranks them by an implied launch value, and
hands in a web dashboard with the board, a detail view per protocol, and a
farm plan for each one.

## The model

One function, `impliedValue` in `lib/model.ts`, scores every protocol from
the snapshot's own figures — TVL, 7-day TVL growth, and how long it has run
with no token. No protocol name is special-cased.

```
sizeMultiple(tvl)  TVL tiers (a giant trades at a lower multiple):
                     >= $5B -> 0.12, >= $1B -> 0.18, >= $250M -> 0.25,
                     >= $50M -> 0.32, under $50M -> 0.40
growthMult         1 + clamp(change_7d, -50, 100) / 100 * 0.6
ageMult            0.70 + min(age_days, 730) / 730 * 0.50
implied            max(1, round(tvl * sizeMultiple * growthMult * ageMult))
```

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
