'use strict';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'resopt.config.v1';

// ---------------------------------------------------------------------------
// Number parsing / formatting
// ---------------------------------------------------------------------------
const PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, '': 1, r: 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

// Accepts "4700", "4.7k", "4k7", "470R", "1e3", "2M2", "10 kΩ"
function parseValue(str) {
  let s = String(str).trim().replace(/\s+/g, '').replace(/(Ω|ohms?)$/i, '').replace(',', '.');
  if (!s) return NaN;
  let m = s.match(/^([-+]?)(\d+)([pnuµmrRkKMG])(\d+)$/);
  if (m) return Number(m[1] + m[2] + '.' + m[4]) * PREFIX[m[3]];
  m = s.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([pnuµmrRkKMG]?)$/);
  if (m) return Number(m[1]) * PREFIX[m[2]];
  return NaN;
}

// Division factor as decimal or "a/b" (both may be negative, e.g. -1.2/-15)
function parseFactor(str) {
  const parts = String(str).split('/');
  if (parts.length === 1) return parseValue(parts[0]);
  if (parts.length !== 2) return NaN;
  const a = parseValue(parts[0]), b = parseValue(parts[1]);
  return b === 0 ? NaN : a / b;
}

function fmtR(v, digits = 2) {
  const a = Math.abs(v);
  let scale = 1, p = '';
  if (a >= 1e9) { scale = 1e9; p = 'G'; }
  else if (a >= 1e6) { scale = 1e6; p = 'M'; }
  else if (a >= 1e3) { scale = 1e3; p = 'k'; }
  else if (a >= 1 || a === 0) { scale = 1; p = ''; }
  else if (a >= 1e-3) { scale = 1e-3; p = 'm'; }
  else { scale = 1e-6; p = 'µ'; }
  return (v / scale).toFixed(digits) + ' ' + p + 'Ω';
}

function fmtErr(err) {
  const a = Math.abs(err);
  if (a < 1e-12) return 'Zero';
  const sign = err > 0 ? '+' : '−';
  if (a < 1e-4) return sign + (a * 1e6).toFixed(1) + ' ppm';
  return sign + (a * 100).toFixed(3) + ' %';
}

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const trimNum = (x) => String(Number(x.toPrecision(12)));

// ---------------------------------------------------------------------------
// Resistor series (.ser files)
// ---------------------------------------------------------------------------
function parseSer(text) {
  const sec = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    for (const tok of line.split(/\s+/)) {
      if (/^(baseval|decades|minimum|maximum)$/i.test(tok)) { cur = tok.toLowerCase(); sec[cur] = []; continue; }
      if (!cur) throw new Error('Unexpected value "' + tok + '" before any section keyword');
      const n = Number(tok);
      if (!Number.isFinite(n)) throw new Error('Invalid number "' + tok + '"');
      sec[cur].push(n);
    }
  }
  if (!sec.baseval || !sec.baseval.length) throw new Error('No "baseval" section found');
  const decades = sec.decades && sec.decades.length ? sec.decades : [0];
  const min = sec.minimum && sec.minimum.length ? sec.minimum[0] : 0;
  const max = sec.maximum && sec.maximum.length ? sec.maximum[0] : Infinity;
  const set = new Set();
  for (const d of decades) {
    for (const b of sec.baseval) {
      const v = Number((b * Math.pow(10, d)).toPrecision(10));
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9) && v > 0) set.add(v);
    }
  }
  return [...set].sort((a, b) => a - b);
}

const series = {};           // name -> sorted values
for (const [name, txt] of Object.entries(BUILTIN_SERIES)) series[name] = parseSer(txt);

let currentSeries = 'E12';
let values = [];             // values of current series
let enabled = [];            // parallel booleans
const disabledBySeries = {}; // name -> array of disabled values (persisted)

function renderValueList() {
  const list = $('valueList');
  const frag = document.createDocumentFragment();
  values.forEach((v, i) => {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = enabled[i]; cb.dataset.i = i;
    lab.className = enabled[i] ? '' : 'off';
    lab.append(cb, ' ' + fmtR(v));
    frag.append(lab);
  });
  list.replaceChildren(frag);
  updateValueCount();
}

function updateValueCount() {
  const on = enabled.filter(Boolean).length;
  $('valueCount').textContent = on === values.length
    ? values.length + ' resistor values loaded.'
    : values.length + ' resistor values loaded, ' + on + ' selected.';
}

function rememberDisabled() {
  disabledBySeries[currentSeries] = values.filter((v, i) => !enabled[i]);
  saveConfig();
}

function selectSeries(name) {
  currentSeries = name;
  values = series[name];
  const off = new Set(disabledBySeries[name] || []);
  enabled = values.map((v) => !off.has(v));
  $('seriesSel').value = name;
  renderValueList();
}

function fillSeriesSelect() {
  $('seriesSel').replaceChildren(...Object.keys(series).map((n) => new Option(n, n)));
}

$('valueList').addEventListener('change', (e) => {
  const i = Number(e.target.dataset.i);
  enabled[i] = e.target.checked;
  e.target.parentElement.className = e.target.checked ? '' : 'off';
  updateValueCount();
  rememberDisabled();
});

document.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => {
  const op = b.dataset.sel;
  enabled = enabled.map((x) => (op === 'all' ? true : op === 'none' ? false : !x));
  renderValueList();
  rememberDisabled();
}));

$('seriesSel').addEventListener('change', (e) => { selectSeries(e.target.value); saveConfig(); });

$('serFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const vals = parseSer(await f.text());
    if (!vals.length) throw new Error('No values in range');
    const name = f.name.replace(/\.(ser|txt)$/i, '');
    series[name] = vals;
    fillSeriesSelect();
    selectSeries(name);
    setStatus('Loaded "' + name + '" with ' + vals.length + ' values.');
  } catch (err) {
    setStatus('Loading failed: ' + err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
const saved = document.querySelectorAll('[data-save]');
let activeTab = 'divider';

function saveConfig() {
  const cfg = { fields: {}, series: currentSeries, disabled: disabledBySeries, tab: activeTab };
  saved.forEach((el) => { cfg.fields[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (_) { /* storage unavailable */ }
}

function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (_) { /* ignore */ }
  if (!cfg) return;
  saved.forEach((el) => {
    if (!(el.id in cfg.fields)) return;
    if (el.type === 'checkbox') el.checked = !!cfg.fields[el.id]; else el.value = cfg.fields[el.id];
  });
  Object.assign(disabledBySeries, cfg.disabled || {});
  if (cfg.series && series[cfg.series]) currentSeries = cfg.series;
  if (cfg.tab) activeTab = cfg.tab;
}
saved.forEach((el) => el.addEventListener('change', saveConfig));

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(name) {
  activeTab = name;
  for (const t of ['divider', 'target']) {
    $('tab-' + t).setAttribute('aria-selected', String(t === name));
    $('page-' + t).hidden = t !== name;
  }
  renderResults();
}
$('tab-divider').addEventListener('click', () => { showTab('divider'); saveConfig(); });
$('tab-target').addEventListener('click', () => { showTab('target'); saveConfig(); });

// ---------------------------------------------------------------------------
// Auxiliary calculators
// ---------------------------------------------------------------------------
$('calcDb').addEventListener('click', () => {
  const att = parseValue($('attDb').value);
  if (!Number.isFinite(att) || att <= 0) { markInvalid($('attDb')); return setStatus('Attenuation must be a positive number of dB.', true); }
  $('divFactor').value = Math.pow(10, -att / 20).toFixed(8);
  saveConfig();
  setStatus('Division factor set from ' + att + ' dB.');
});

$('calcReg').addEventListener('click', () => {
  const out = parseValue($('uOut').value), ref = parseValue($('uRef').value), gnd = parseValue($('uGnd').value);
  if (![out, ref, gnd].every(Number.isFinite) || !(Math.abs(gnd) < Math.abs(ref) && Math.abs(ref) < Math.abs(out))) {
    return setStatus('Invalid voltages detected. Check that |Ugnd| < |Uref| < |Uout|.', true);
  }
  const d = (ref - gnd) / (out - gnd);
  if (!(d > 0 && d < 1)) return setStatus('Resulting division factor ' + d.toFixed(6) + ' is not between 0 and 1.', true);
  $('divFactor').value = trimNum(ref - gnd) + '/' + trimNum(out - gnd);
  saveConfig();
  setStatus('Division factor set from regulator voltages.');
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
class InputError extends Error {
  constructor(msg, el) { super(msg); this.el = el; }
}
function markInvalid(el) {
  el.classList.add('invalid');
  el.addEventListener('input', () => el.classList.remove('invalid'), { once: true });
  el.focus();
}
function num(id, { min = -Infinity, int = false, label, allowZero = true } = {}) {
  const el = $(id);
  const v = parseValue(el.value);
  const bad = !Number.isFinite(v) || v < min || (!allowZero && v === 0) || (int && !Number.isInteger(v));
  if (bad) throw new InputError('Please check "' + label + '".', el);
  return v;
}
function rangeOf(fromId, toId, enId, label) {
  if (!$(enId).checked) return null;
  const a = num(fromId, { min: 0, label }), b = num(toId, { min: 0, label });
  if (a > b) throw new InputError('Please check ' + label.toLowerCase() + ' constraints.', $(fromId));
  return [a, b];
}
function selectedValues() {
  return values.filter((v, i) => enabled[i]);
}

function readDivider() {
  const t = parseFactor($('divFactor').value);
  if (!(t > 0 && t < 1)) throw new InputError('The division factor must be greater than 0 and less than 1.', $('divFactor'));
  const tol = num('divTol', { min: 0, label: 'Required tolerance' });
  const maxResults = num('divMax', { min: 1, int: true, label: 'Max number of results' });
  if (maxResults > 1000) throw new InputError('Max number of results is limited to 1000.', $('divMax'));
  return {
    mode: 'divider', t, tol, maxResults,
    ser: rangeOf('serFrom', 'serTo', 'serEn', 'Series resistance'),
    par: rangeOf('parFrom', 'parTo', 'parEn', 'Parallel resistance'),
    rs: num('rSource', { min: 0, label: 'Source resistance' }),
    rload: num('rLoad', { min: 0, label: 'Load resistance' }),
    nu: Number($('nUpper').value), nl: Number($('nLower').value),
    upar: $('cUpper').value === 'par', lpar: $('cLower').value === 'par',
  };
}

function readTarget() {
  const T = num('tgtR', { min: 0, allowZero: false, label: 'Target resistance' });
  const tol = num('tgtTol', { min: 0, label: 'Required tolerance' });
  const maxResults = num('tgtMax', { min: 1, int: true, label: 'Max number of results' });
  if (maxResults > 1000) throw new InputError('Max number of results is limited to 1000.', $('tgtMax'));
  return { mode: 'target', T, tol, maxResults, n: Number($('tgtN').value), conn: $('tgtConn').value };
}

// ---------------------------------------------------------------------------
// Running the optimizer
// ---------------------------------------------------------------------------
let worker = null;
let runMode = null;
const resultsBy = { divider: null, target: null };

function setStatus(text, isError) {
  $('statusText').textContent = text;
  $('statusText').style.color = isError ? 'var(--bad)' : '';
}
function setBar(frac) { $('barFill').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%'; }

function setRunning(mode) {
  runMode = mode;
  for (const [m, id] of [['divider', 'goDivider'], ['target', 'goTarget']]) {
    const b = $(id);
    const running = mode === m;
    b.textContent = running ? 'Abort!' : 'Optimize!';
    b.classList.toggle('running', running);
    b.disabled = !!mode && !running;
  }
}

function start(mode) {
  if (worker) {  // acts as abort button
    worker.terminate(); worker = null;
    setRunning(null);
    setStatus('Optimization aborted by user');
    return;
  }
  let params;
  try {
    params = mode === 'divider' ? readDivider() : readTarget();
  } catch (err) {
    if (err.el) markInvalid(err.el);
    setStatus('Error: ' + err.message, true);
    return;
  }
  const vals = selectedValues();
  if (!vals.length) return setStatus('Not enough resistor values available.', true);
  params.values = vals;

  saveConfig();
  setRunning(mode);
  setBar(0);
  setStatus('Optimizing…');
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      setBar(m.checked / m.total);
      setStatus('Optimizing, ' + fmtInt(m.checked) + ' combinations checked');
    } else if (m.type === 'done') {
      finish();
      setBar(1);
      setStatus('Optimization finished');
      resultsBy[m.mode] = { ...m, labels: vals, upar: params.upar, lpar: params.lpar, sort: { key: 'rank', dir: 1 } };
      renderResults();
    } else if (m.type === 'error') {
      finish();
      setBar(0);
      setStatus('Error: ' + m.message, true);
    }
  };
  worker.onerror = (e) => { finish(); setStatus('Error: ' + (e.message || 'worker failed'), true); };
  worker.postMessage(params);
}
function finish() { if (worker) worker.terminate(); worker = null; setRunning(null); }

$('page-divider').addEventListener('submit', (e) => { e.preventDefault(); start('divider'); });
$('page-target').addEventListener('submit', (e) => { e.preventDefault(); start('target'); });

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------
const COLS = {
  divider: [
    { key: 'rank', label: 'Rank', num: true },
    { key: 'ru', label: 'Ru' },
    { key: 'rl', label: 'Rl' },
    { key: 'Ru', label: 'Ru total', num: true },
    { key: 'Rl', label: 'Rl total', num: true },
    { key: 'rser', label: 'Rser total', num: true },
    { key: 'rpar', label: 'Rpar total', num: true },
    { key: 'd', label: 'Division factor', num: true },
    { key: 'err', label: 'Error', num: true },
  ],
  target: [
    { key: 'rank', label: 'Rank', num: true },
    { key: 'res', label: 'Resistors' },
    { key: 'R', label: 'R total', num: true },
    { key: 'err', label: 'Error', num: true },
  ],
};

function comboLabel(idx, vals, parallel) {
  return idx.map((i) => fmtR(vals[i])).join(parallel ? ' || ' : ' + ');
}

function rowsFor(mode, data) {
  const v = data.labels;
  return data.results.map((r, i) => {
    if (mode === 'divider') {
      return {
        rank: i + 1,
        ru: comboLabel(r.u, v, data.upar), rl: comboLabel(r.l, v, data.lpar),
        Ru: r.Ru, Rl: r.Rl, rser: r.rser, rpar: r.rpar, d: r.d, err: r.err,
        cells: [i + 1, comboLabel(r.u, v, data.upar), comboLabel(r.l, v, data.lpar),
          r.Ru.toFixed(2), r.Rl.toFixed(2), r.rser.toFixed(3), r.rpar.toFixed(3), r.d.toFixed(8), fmtErr(r.err)],
      };
    }
    return {
      rank: i + 1, res: comboLabel(r.idx, v, r.par), R: r.R, err: r.err,
      cells: [i + 1, comboLabel(r.idx, v, r.par), fmtR(r.R, 4), fmtErr(r.err)],
    };
  });
}

function renderResults() {
  const mode = activeTab;
  const cols = COLS[mode];
  const data = resultsBy[mode];
  const thead = $('resTable').tHead, tbody = $('resTable').tBodies[0];
  const sort = data ? data.sort : { key: 'rank', dir: 1 };

  const tr = document.createElement('tr');
  cols.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.className = c.num ? 'num' : '';
    th.scope = 'col';
    if (sort.key === c.key) {
      const a = document.createElement('span');
      a.className = 'arrow'; a.textContent = sort.dir > 0 ? '▲' : '▼';
      th.append(a);
      th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
    }
    th.addEventListener('click', () => {
      if (!data) return;
      data.sort = { key: c.key, dir: data.sort.key === c.key ? -data.sort.dir : 1 };
      renderResults();
    });
    tr.append(th);
  });
  thead.replaceChildren(tr);

  if (!data) {
    tbody.innerHTML = '<tr class="empty"><td colspan="' + cols.length + '">Set the parameters and press <b>Optimize!</b></td></tr>';
    $('summary').textContent = '';
    return;
  }

  $('summary').innerHTML = 'Total possible combinations = <b>' + fmtInt(data.total) + '</b> · Matching = <b>' +
    fmtInt(data.matching) + '</b> · took <b>' + data.elapsed.toFixed(3) + ' s</b>';

  if (!data.results.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="' + cols.length + '">No combinations within tolerance. Try a larger tolerance, relaxed constraints or more resistors.</td></tr>';
    return;
  }

  const rows = rowsFor(mode, data);
  const k = sort.key;
  rows.sort((a, b) => {
    let x = a[k], y = b[k];
    if (k === 'err') { x = Math.abs(x); y = Math.abs(y); }
    const c = typeof x === 'string' ? x.localeCompare(y, 'en', { numeric: true }) : x - y;
    return (c || a.rank - b.rank) * sort.dir;
  });

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const row = document.createElement('tr');
    r.cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cols[i].num) td.className = 'num';
      if (cols[i].key === 'err' && text === 'Zero') td.className += ' zero';
      row.append(td);
    });
    frag.append(row);
  }
  tbody.replaceChildren(frag);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
fillSeriesSelect();
loadConfig();
selectSeries(currentSeries);
showTab(activeTab);
