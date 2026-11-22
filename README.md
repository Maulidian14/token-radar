# Launch Radar v6 — make.fun token-radar-01

A token launch radar: it reads a sealed DefiLlama snapshot, finds the
protocols that record no token, ranks the launch candidates by the
EXPECTED value of their launch, and hands in a web dashboard with the
board, a detail view per protocol, and a farm plan for each one.

## The model (launch-radar-6)

The board ranks launch candidates — pre-token protocols that are not a
wrapped, staked or bridged product of a token that already trades — by:

    expected value = gross implied value × launch odds

**Gross value** is v4's model, kept whole: a Theil-Sen power law of
log10(market cap) on log10(TVL), fitted at runtime from the snapshot's
live-token protocols (intercept 2.7837, slope 0.5554 on this snapshot),
a per-category residual adjustment shrunk by n/(n+15), a growth
multiplier (weight 0.4, growth clamped to −50%…+100%), and an age
multiplier (0.70 + min(age, 730)/730 × 0.50). Backtested two ways:
5-fold CV and a walk-forward test in time.

**Launch odds** are new in v6: a Weibull current-status survival model
for the time from listing to launch, fitted at runtime (BFGS, analytic
gradient). A protocol that records a token has launched (its launch
time is at most its age); a pre-token protocol has not (its launch time
is past its age). The scale is log-linear in log TVL, 7-day growth and
category dummies (14 categories with ≥15 protocols); the shape k is
fitted. On this snapshot k = 0.43 — below 1, so the launch hazard FALLS
with age, which is what the snapshot's own record shows: protocols that
have run years with no token are less likely to launch next year than
young ones. The odds are P(launch within 365 days | not launched yet),
clipped to 5%–95%.

Validation (computed at runtime, shown on the dashboard):

- Time-held-out (train on the earliest-listed 70%, score the latest
  30%): log-loss 0.6164 against a base rate of 0.6884, AUC 0.6688.
- 5-fold cross-validation: log-loss 0.6055, AUC 0.733.

A plain logistic on "records a token" was tried and rejected: the
cross-sectional target measures "has launched already", so its age
coefficient either has to be forced negative (which breaks its
time-held-out validation) or comes out positive (which calls the oldest
protocols the likeliest to launch). The survival form resolves the
tension honestly — age enters through the clock itself.

**Verdict** — farm or watch, never skip. The estimated airdrop value
per farmer is the expected value × a 10% farmer share (a typical
airdrop allocation, stated as an assumption) ÷ an estimated farmer
count (25 × √TVL-in-millions, clamped to 100–5000). Farm when that
figure clears 3× the farm plan's cost (deployed capital + gas); watch
otherwise. On this snapshot: 175 farm, 23 watch; the watchlist is
33 farm, 7 watch, 0 skip.

## The board

198 launch candidates, ranked by expected value. Derivatives (144)
are not ranked — a wrapped product has no launch of its own — but are
listed in their own dashboard view with gross values and farm plans.
All 416 token-trading protocols are listed in the Already trading view
(market cap "—" where the snapshot records none). 198 + 144 + 416 =
758: every protocol in the snapshot is accounted for.

Top 10 on this snapshot: bittensor-dtao, usdd, steakhouse-financial,
sentora-curator, bitfi-basis, veda, defi-saver-asset-management, onre,
polymarket-international, gauntlet — all launches.

## Run it

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

Writes `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json`. The run is deterministic:
two runs write the same bytes.

## Layout

- `main.ts` — the entrypoint: read the snapshot, build the board, write the outputs.
- `lib/model.ts` — the model: gross calibration, Weibull odds, verdicts, farm plans, board builders.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js` (under 64 KB in all).
- `screenshots/` — three screenshots of the dashboard (board, detail, filtered).
- `vendor/makefun-board.ts` — the dossier library, unchanged from the kit.
