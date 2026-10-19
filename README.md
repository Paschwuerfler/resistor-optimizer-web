# Resistor Optimizer — web port

A browser re-implementation of **[Resistor Optimizer](https://jahonen.kapsi.fi/Electronics/ResOptimizer/)**,
the Win32/MFC utility written by **Janne Ahonen** (© JTA 2002–2025). This port is based on version 0.59.

All credit for the tool's idea, its design and the bundled resistor series (`.ser`) data goes to the original
author. This is an unofficial port and is not affiliated with or endorsed by him; any bugs are the port's own.
For the original Windows application, see the [project page](https://jahonen.kapsi.fi/Electronics/ResOptimizer/).

## Features

- **Resistor divider optimizer** — finds upper/lower resistor combinations (1–4 per side, parallel or series)
  for a target division factor, with optional series/parallel resistance limits and source/load resistances.
  Division factor as decimal or ratio (`1.25/3.3`, `-1.2/-15`), plus the dB-attenuator and voltage-regulator
  (with UGND offset) helper calculators.
- **Target resistance optimizer** — finds 1–4 resistors in parallel, series, or either, for a target resistance.
- E6 … E192 and E96+E24 series built in; load your own `.ser` files; exclude individual values.
- Sortable results, progress and abort, settings remembered in the browser.

Additions over the original: inputs accept SI prefixes and RKM codes (`4.7k`, `4k7`, `2M2`).

Results match the original: for the default example (E12, 1.25/3.3, 5 %, 1 upper + 2 parallel lower,
series 1k–100k) both report 310 675 combinations, 668 matches and the same top results.

## Running locally

Static files only — serve `site/` with any web server (the optimizer runs in a Web Worker, so `file://` won't work):

```sh
python -m http.server -d site
```
