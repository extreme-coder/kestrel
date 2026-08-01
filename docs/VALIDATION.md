# Validation

Reproduce with `npm run validate --workspace server` (add `-- iec` for the alternative
density correction). It runs against live ERA5 data and takes about a minute cold, a few
seconds once the cache is warm.

## What was being reproduced

The Windsim science-fair report validated the original app by placing a turbine at ten
real offshore wind farms, matching hub height and turbine model to each, and comparing
predicted output against a recorded actual. It reported a **mean error of 1.265%**.

Since the original backend and its upstream data source are both gone, the rebuilt
pipeline is a reimplementation, not a port — so the claim is worth re-checking rather
than inheriting.

## The reference column does not survive inspection

Two problems, both in the report's data rather than in either implementation:

**The units are off by a factor of 1000.** The column is labelled `kWh/month` at
magnitudes that only make sense as `MWh/month`. A V112-3450 producing 1459 kWh in a month
would be sitting at a 0.06% capacity factor. Everything below reads the column as
MWh/month.

**Read that way, several rows are physically impossible.** Converting each reference
figure to the capacity factor it implies:

| Farm | Turbine | Reference (MWh/mo) | Implied CF |
|---|---|---:|---:|
| Nysted | Bonus B82-2300 | 2062.35 | **1.23** |
| Hornsea One | SWT-3.0-101 (entered) | 1746.90 | 0.80 |
| Horns Rev 1 | Vestas V80-2000 | 1079.20 | 0.74 |
| Race Bank | V117-3450 (entered) | 1733.06 | 0.69 |

A capacity factor above 1.0 is more energy than the generator can emit with the wind at
rated speed every hour of the month. Horns Rev 1's 0.74 is roughly double the farm's
real-world output — its ~160 MW produce about 600 GWh/year, a CF near 0.43.

Two rows also entered a different turbine than the farm actually uses: Race Bank
(SWT-6.0-154) was modelled as a V117-3450, and Hornsea One (SWT-7.0-154) as a
SWT-3.0-101 — less than half the nameplate.

**Conclusion: the reference column is not ground truth, and tuning a model to match it
would be fitting to bad data.** The 1.265% figure cannot be reproduced, and should not be.

## What was validated instead

Whether predicted capacity factors land in the well-established band for North Sea and
Baltic offshore wind, once standard array losses are applied.

The API predicts a **single isolated, perfectly available turbine**. A real farm loses
output to its own turbines' wakes, to downtime, and to the export cable. Standard
industry planning values bridge the two:

| Loss | Factor |
|---|---:|
| Wake | 10% |
| Availability | 3% |
| Electrical / collection | 2% |
| Other (soiling, curtailment) | 2% |
| **Combined gross → net** | **0.838** |

### Results — ERA5 2019, linear density correction

| Farm | Turbine | Hub | Wind (m/s) | Shear α | Gross CF | Net CF | In band |
|---|---|---:|---:|---:|---:|---:|:--:|
| Rampion | V112-3450 | 84 m | 9.01 | 0.075 | 0.536 | 0.450 | yes |
| London Array | SWT-3.6-107 | 87 m | 8.57 | 0.088 | 0.480 | 0.403 | yes |
| Race Bank | V117-3450 | 110 m | 9.09 | 0.101 | 0.587 | 0.492 | yes |
| Hornsea One | SWT-3.0-101 | 100 m | 9.62 | 0.093 | 0.591 | 0.495 | yes |
| Robin Rigg | V90-3000 | 80 m | 7.59 | 0.190 | 0.357 | 0.299 | **no** |
| Barrow | V90-3000 | 75 m | 8.94 | 0.082 | 0.476 | 0.399 | yes |
| Nysted | B82-2300 | 69 m | 8.35 | 0.128 | 0.445 | 0.373 | yes |
| Rodsand II | SWT-2.3-93 | 69 m | 7.44 | 0.194 | 0.416 | 0.349 | yes |
| Horns Rev 1 | V80-2000 | 70 m | 9.55 | 0.089 | 0.577 | 0.484 | yes |
| Horns Rev 2 | SWT-2.3-93 | 68 m | 9.51 | 0.094 | 0.616 | 0.516 | yes |

- **Mean net capacity factor: 0.426** — squarely where North Sea offshore sits.
- **9 of 10 inside the 0.32–0.55 band.** Robin Rigg falls just below at 0.299; it is the
  shallowest, most sheltered site in the set, in the Solway Firth rather than open sea.

### An independent check: the shear exponents

Nothing forces the derived wind-shear exponent α to be physical — it is fitted per hour
from the 10 m and 100 m fields. It lands at **0.075–0.10 at the open-sea sites** and rises
to **0.19 at Robin Rigg and Rodsand II**, the two most sheltered. That is exactly the
expected pattern (open water is aerodynamically smooth, coastal water is not), and it was
not tuned for. Assuming the textbook 1/7 ≈ 0.143 everywhere would have overestimated
hub-height wind offshore by several percent, which cubes into power.

### Density correction makes almost no difference here

Linear (the report's method) and IEC 61400-12-1 agree to within 0.2% of capacity factor
across all ten sites, because offshore air density sits close to the 1.225 kg/m³
reference. The distinction matters at altitude or in extreme cold, not at sea level — so
the simpler linear method stays the default. The two diverge meaningfully only at rated
speed in dense air, where the linear correction implies a turbine exceeding its own
nameplate; there is a unit test pinning that difference.

## A bug this exercise caught

The first validation run came back **43% low at every single site** — uniformly negative,
so a bias rather than noise.

The cause was the parametric power curve. It ramped cubically from cut-in all the way to
the *datasheet* rated wind speed, which sounds reasonable and is wrong: a datasheet's
rated speed is where the curve *finishes* arriving at nameplate, not where it starts
levelling off. For a V80-2000 (rated listed at 16 m/s) that formulation implies a power
coefficient of 0.15 at 9 m/s, against a real value near 0.44 — and offshore farms spend
most of their hours in exactly that band.

Replaced with the standard two-region model: the rotor tracks its peak power coefficient
(Cp = 0.45) until the generator saturates, then holds flat at rated. Mean error against
the report's column fell from 43% to 22.5%, the sign of the errors stopped being uniform,
and capacity factors moved into the plausible range.

The unit tests all passed both before and after, which is the interesting part — they
pinned the curve's *shape* (monotonic, zero outside cut-in/cut-out, capped at rated,
under Betz) without pinning its *level*. There is now a regression test that checks the
parametric model against the published V80-2000 curve point by point: mean absolute error
under 7%, no single point off by more than 16%.

## Known limitations

- **ERA5 is a ~25 km reanalysis.** It resolves synoptic weather, not local topographic
  acceleration. This is the dominant error term for any onshore or complex-terrain site,
  and the reason the offshore farms above are the fair test.
- **No measured power curves.** Every model in the catalogue uses the parametric
  fallback. `TurbineModel.curve` accepts a manufacturer table and takes precedence with
  no other code change; populating it is the single highest-value accuracy improvement
  available.
- **Single-turbine, gross output.** Wake interaction between turbines is not modelled
  here — that is what Kestrel's wake-field work addresses.
- **One year (2019).** Chosen to match the original client's default window. Inter-annual
  variability in North Sea wind is roughly ±5%.
