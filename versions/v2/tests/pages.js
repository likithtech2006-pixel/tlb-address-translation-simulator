#!/usr/bin/env node
/*
 * Page-level smoke tests for the multi-page app (Version 2).
 * Drives headless Chrome/Edge against the file:// build and checks that every
 * page loads without script errors, renders the shell and its own panels,
 * shows guiding empty states, resolves deep links and shares one session.
 *   node tests/pages.js          (set CHROME=/path/to/chrome to override)
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = candidates.find(p => fs.existsSync(p));
if (!chrome) { console.log('SKIP  no Chrome/Edge found (set CHROME=...)'); process.exit(0); }

const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbscope-'));
const url = (page, q = '') => pathToFileURL(path.join(root, page)).href + q;

/** Loads a page; returns { dom, errors }. The profile (and so localStorage) persists between calls. */
function load(page, q = '') {
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--virtual-time-budget=5000', '--enable-logging=stderr', '--v=0',
    `--user-data-dir=${profile}`, '--dump-dom', url(page, q)], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const errors = (r.stderr || '').split('\n').filter(l => /Uncaught|SyntaxError|ReferenceError|TypeError/.test(l) && /CONSOLE|console/.test(l));
  return { dom: r.stdout || '', errors };
}

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const PAGES = {
  'index.html': ['heroSvg', 'continueCard'],
  'machine.html': ['scenarioGrid', 'vaBits'],
  'translate.html': ['addr', 'cGraph', 'bits', 'datapath'],
  'timeline.html': ['scope', 'trace', 'logBody'],
  'structures.html': ['tlbView', 'ptMap', 'memMap'],
  'analytics.html': ['kpis', 'hitChart', 'eatBars'],
  'lab.html': ['labOut', 'labRun'],
  'learn.html': ['vivaList', 'apps'],
  'verify.html': ['bistOut'],
  'report.html': ['report'],
};

// 1. Fresh session: every page loads cleanly, with shell + own panels; data pages show the empty state.
for (const [page, ids] of Object.entries(PAGES)) {
  const { dom, errors } = load(page);
  test(`${page} loads without script errors`, () => expect(errors.length === 0, errors.join(' | ')));
  test(`${page} renders the shell and its panels`, () => {
    expect(/class="masthead"/.test(dom), 'missing masthead');
    expect(/<h1/.test(dom), 'missing h1');
    for (const id of ids) expect(dom.includes(`id="${id}"`), `missing #${id}`);
    if (page !== 'index.html') expect(dom.includes('class="next-step"'), 'missing next-step hand-off');
  });
}
test('data pages guide the user when the session is empty', () => {
  const { dom } = load('structures.html');
  expect(/id="emptyBanner"(?![^>]*hidden)/.test(dom), 'empty banner should be visible');
});

// 2. One shared session across pages.
test('a scenario loaded on Machine is visible on Structures', () => {
  load('machine.html', '?scenario=belady');
  const { dom } = load('structures.html');
  expect(/id="tlbChip"[^>]*>3 \/ 3 valid/.test(dom), 'TLB should show 3/3 entries after Belady scenario');
  expect(/id="emptyBanner"[^>]*hidden/.test(dom), 'empty banner should be hidden once data exists');
});
test('Analytics reflects the shared session (12 accesses)', () => {
  const { dom } = load('analytics.html');
  expect(/<span>Accesses<\/span><b>12<\/b>/.test(dom), 'expected 12 accesses');
});

// 3. Deep links.
test('translate.html?addr=0x40 translates and updates the context bar', () => {
  const { dom } = load('translate.html', '?addr=0x40');
  expect(/id="ctxOut"[^>]*>[A-Z]+ · 64 →/.test(dom), 'context bar should show VA 64');
});
test('translate.html?explain=1 opens the calculation player', () => {
  const { dom } = load('translate.html', '?explain=1');
  expect(/<section class="card calc-card[^"]*" id="calc"(?![^>]*hidden)/.test(dom), 'calc player should be open');
});
test('timeline.html?t=3 moves the cursor to t = 3', () => {
  const { dom } = load('timeline.html', '?t=3');
  expect(/id="ctxT">3</.test(dom), 'cursor should be 3');
});
test('lab.html?trace=belady&run=1 runs the experiment and flags the anomaly', () => {
  const { dom } = load('lab.html', '?trace=belady&run=1');
  expect(dom.includes("Belady's anomaly detected"), 'anomaly callout expected');
});
test('verify.html auto-runs the suite to 96/96', () => {
  const { dom } = load('verify.html');
  expect(/bist-score pass">96\/96/.test(dom), 'expected 96/96');
});
test('report.html builds every section from the session', () => {
  const { dom } = load('report.html');
  for (const s of ['Machine configuration', 'Translations with working', 'Final TLB and memory state', 'Verification']) expect(dom.includes(s), `missing "${s}"`);
});

fs.rmSync(profile, { recursive: true, force: true });
let pass = 0;
for (const [ok, name, err] of results) { if (ok) pass++; console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${name}${ok ? '' : '\n      ' + err}`); }
console.log(`\n${pass === results.length ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ${pass}/${results.length} page tests`);
process.exitCode = pass === results.length ? 0 : 1;
