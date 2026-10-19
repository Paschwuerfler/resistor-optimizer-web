// Optimization engine. Runs in a Web Worker so the UI stays responsive and a
// running search can be aborted (main thread calls worker.terminate()).
'use strict';

const EPS = 1e-9;          // slack for range pre-filtering
const TOL_EPS = 1e-12;     // slack for the exact tolerance check
const MAX_STORED = 3e7;    // largest combination list we keep in memory

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.mode === 'divider') divider(m);
    else target(m);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

// Number of multisets of size k from n values: C(n+k-1, k)
function nCombos(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - 1 + i)) / i;
  return Math.round(r);
}

// Iterate all non-decreasing index tuples of length k over [0, n)
function forEachCombo(n, k, cb) {
  const idx = new Int32Array(k);
  for (;;) {
    cb(idx);
    let p = k - 1;
    while (p >= 0 && idx[p] === n - 1) p--;
    if (p < 0) return;
    const v = idx[p] + 1;
    for (let q = p; q < k; q++) idx[q] = v;
  }
}

function comboTotal(idx, vals, parallel) {
  let s = 0;
  if (parallel) {
    for (let i = 0; i < idx.length; i++) s += 1 / vals[idx[i]];
    return 1 / s;
  }
  for (let i = 0; i < idx.length; i++) s += vals[idx[i]];
  return s;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Keeps the best `max` results ordered by |error|
class TopN {
  constructor(max) { this.max = max; this.items = []; }
  worst() { return this.items.length < this.max ? Infinity : this.items[this.items.length - 1].abs; }
  accepts(abs) { return abs < this.worst(); }
  add(item) {
    const a = this.items;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid].abs <= item.abs) lo = mid + 1; else hi = mid;
    }
    a.splice(lo, 0, item);
    if (a.length > this.max) a.pop();
  }
}

function makeProgress(total) {
  let last = 0;
  return (checked, force) => {
    const now = performance.now();
    if (force || now - last > 100) {
      last = now;
      self.postMessage({ type: 'progress', checked, total });
    }
  };
}

// ---------------------------------------------------------------------------
// Resistor divider optimizer
//   d = Rl' / (Rl' + Ru + Rsource),  Rl' = Rl || Rload  (when Rload > 0)
// One side's combinations are stored sorted by their key, the other side is
// streamed and the matching range is found by binary search.
// ---------------------------------------------------------------------------
function divider(m) {
  const t0 = performance.now();
  const vals = m.values;
  const N = vals.length;
  const { nu, nl, upar, lpar, t, tol, rs, rload, ser, par, maxResults } = m;

  const cu = nCombos(N, nu), cl = nCombos(N, nl);
  const total = cu * cl;
  const effLower = (R) => (rload > 0 ? (R * rload) / (R + rload) : R);
  const keyUpper = (R) => R + rs;

  const storeLower = cl <= cu;
  const sk = storeLower ? nl : nu;
  const spar = storeLower ? lpar : upar;
  const scount = storeLower ? cl : cu;
  if (scount > MAX_STORED) {
    throw new Error('Too many combinations to search (' + scount.toLocaleString('en') +
      ' per side). Use fewer resistors per side or deselect some values.');
  }

  // Build stored side
  const rawTmp = new Float64Array(scount);
  const idxTmp = new Int32Array(scount * sk);
  let c = 0;
  forEachCombo(N, sk, (idx) => {
    rawTmp[c] = comboTotal(idx, vals, spar);
    idxTmp.set(idx, c * sk);
    c++;
  });
  const keyTmp = new Float64Array(scount);
  for (let i = 0; i < scount; i++) keyTmp[i] = storeLower ? effLower(rawTmp[i]) : keyUpper(rawTmp[i]);
  const order = new Uint32Array(scount);
  for (let i = 0; i < scount; i++) order[i] = i;
  order.sort((a, b) => keyTmp[a] - keyTmp[b]);
  const sKey = new Float64Array(scount), sRaw = new Float64Array(scount), sIdx = new Int32Array(scount * sk);
  for (let i = 0; i < scount; i++) {
    const o = order[i];
    sKey[i] = keyTmp[o];
    sRaw[i] = rawTmp[o];
    sIdx.set(idxTmp.subarray(o * sk, o * sk + sk), i * sk);
  }

  const dlo = t * (1 - tol), dhi = t * (1 + tol);
  const top = new TopN(maxResults);
  const progress = makeProgress(total);
  const qk = storeLower ? nu : nl;
  const qpar = storeLower ? upar : lpar;
  let matching = 0, streamed = 0;

  forEachCombo(N, qk, (idx) => {
    const R = comboTotal(idx, vals, qpar);
    let lo, hi;
    if (storeLower) {
      const A = keyUpper(R);
      lo = dlo <= 0 ? 0 : (dlo * A) / (1 - dlo);
      hi = dhi >= 1 ? Infinity : (dhi * A) / (1 - dhi);
    } else {
      const x = effLower(R);
      lo = dhi >= 1 ? 0 : (x * (1 - dhi)) / dhi;
      hi = dlo <= 0 ? Infinity : (x * (1 - dlo)) / dlo;
    }
    const hiLim = hi * (1 + EPS);
    for (let j = lowerBound(sKey, lo * (1 - EPS)); j < scount && sKey[j] <= hiLim; j++) {
      const Ru = storeLower ? R : sRaw[j];
      const Rl = storeLower ? sRaw[j] : R;
      const x = effLower(Rl);
      const d = x / (x + Ru + rs);
      const err = (d - t) / t;
      const abs = Math.abs(err);
      if (abs > tol * (1 + TOL_EPS)) continue;
      const rser = Ru + Rl;
      if (ser && (rser < ser[0] || rser > ser[1])) continue;
      const rpar = (Ru * Rl) / (Ru + Rl);
      if (par && (rpar < par[0] || rpar > par[1])) continue;
      matching++;
      if (top.accepts(abs)) {
        const stored = Array.from(sIdx.subarray(j * sk, j * sk + sk));
        const streamedIdx = Array.from(idx);
        top.add({
          abs, err, d, Ru, Rl, rser, rpar,
          u: storeLower ? streamedIdx : stored,
          l: storeLower ? stored : streamedIdx,
        });
      }
    }
    streamed++;
    if ((streamed & 0x3ff) === 0) progress(streamed * scount);
  });

  progress(total, true);
  self.postMessage({
    type: 'done', mode: 'divider', total, matching,
    elapsed: (performance.now() - t0) / 1000, results: top.items,
  });
}

// ---------------------------------------------------------------------------
// Target resistance optimizer
// Streams the first n-1 resistors, binary-searches the last one (index >= the
// previous one, so every multiset is visited exactly once).
// ---------------------------------------------------------------------------
function target(m) {
  const t0 = performance.now();
  const vals = m.values;
  const N = vals.length;
  const { n, conn, T, tol, maxResults } = m;
  const modes = conn === 'both' ? (n === 1 ? ['ser'] : ['par', 'ser']) : [conn];
  const perMode = nCombos(N, n);
  const total = perMode * modes.length;
  const top = new TopN(maxResults);
  const progress = makeProgress(total);
  const Tlo = T * (1 - tol), Thi = T * (1 + tol);
  let matching = 0, checked = 0, streamed = 0;

  const consider = (prefix, j, parallel, partial) => {
    const r = vals[j];
    const R = parallel ? 1 / (partial + 1 / r) : partial + r;
    const err = (R - T) / T;
    const abs = Math.abs(err);
    if (abs > tol * (1 + TOL_EPS)) return;
    matching++;
    if (top.accepts(abs)) {
      const idx = Array.from(prefix);
      idx.push(j);
      top.add({ abs, err, R, idx, par: parallel && n > 1 });
    }
  };

  for (const mode of modes) {
    const parallel = mode === 'par';
    if (n === 1) {
      for (let j = 0; j < N; j++) consider([], j, false, 0);
      checked += N;
      continue;
    }
    forEachCombo(N, n - 1, (idx) => {
      const start = idx[n - 2];
      let partial = 0;
      for (let i = 0; i < idx.length; i++) partial += parallel ? 1 / vals[idx[i]] : vals[idx[i]];
      let rlo, rhi;
      if (parallel) {
        const glo = 1 / Thi - partial;
        const ghi = tol >= 1 ? Infinity : 1 / Tlo - partial;
        rlo = ghi > 0 ? 1 / ghi : Infinity;
        rhi = glo > 0 ? 1 / glo : Infinity;
      } else {
        rlo = Tlo - partial;
        rhi = Thi - partial;
      }
      if (rhi > 0 && rlo !== Infinity) {
        const hiLim = rhi * (1 + EPS);
        for (let j = Math.max(start, lowerBound(vals, rlo * (1 - EPS))); j < N && vals[j] <= hiLim; j++) {
          consider(idx, j, parallel, partial);
        }
      }
      checked += N - start;
      if ((++streamed & 0x3ff) === 0) progress(checked);
    });
  }

  progress(total, true);
  self.postMessage({
    type: 'done', mode: 'target', total, matching,
    elapsed: (performance.now() - t0) / 1000, results: top.items,
  });
}
