/* Tests for MCP calls in the transcript (src/app/mcp.js, with the chips.js and
 * typer.js paths that use it): readable names, laid-out output, runs of calls to
 * one server folding into one chip, and one chip per call while it streams.
 *
 * The scripts share one global scope, so they are loaded into a vm context with
 * a small fake DOM — just what these paths touch.
 *
 * Run: node tests/mcp.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

/* ------------------------------- a fake DOM -------------------------------- */

class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null;
    this.dataset = {}; this.attrs = {}; this.style = {}; this.hidden = false;
    this.textContent = ''; this.innerHTML = ''; this.title = '';
    const cls = this._cls = new Set();
    this.classList = {
      contains: (c) => cls.has(c),
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => { if (on === undefined) on = !cls.has(c); if (on) cls.add(c); else cls.delete(c); return on; },
    };
  }
  set className(v) { this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._cls.add(c)); }
  get className() { return [...this._cls].join(' '); }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  remove() { const p = this.parentNode; if (!p) return; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
  before(n) { const p = this.parentNode; if (n.parentNode) n.remove(); n.parentNode = p; p.children.splice(p.children.indexOf(this), 0, n); }
  replaceWith(n) { const p = this.parentNode; if (n.parentNode) n.remove(); p.children[p.children.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
  get previousElementSibling() { const p = this.parentNode; const i = p ? p.children.indexOf(this) : -1; return i > 0 ? p.children[i - 1] : null; }
  get childElementCount() { return this.children.length; }
  matches(sel) { return matchCompound(this, sel); }
  closest(sel) { for (let e = this; e; e = e.parentNode) if (e.matches && e.matches(sel)) return e; return null; }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    const out = [];
    const walk = (e) => { for (const c of e.children) { if (matchChain(c, parts, this)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { top: 0, bottom: 0 }; }
}
// `.a.b[data-id="x"]` / `[data-id]` / `tag`
function matchCompound(e, sel) {
  const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel);
  if (!m) throw new Error('fake DOM: selector ' + sel);
  if (m[1] && e.tagName !== m[1]) return false;
  for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!e.classList.contains(c.slice(1))) return false;
  for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
    const [, k, v] = /^\[data-([\w-]+)(?:="(.*)")?\]$/.exec(a);
    if (v === undefined ? e.dataset[k] == null : e.dataset[k] !== v) return false;
  }
  return true;
}
function matchChain(e, parts, root) {
  if (!matchCompound(e, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let p = e.parentNode; i >= 0 && p && p !== root; p = p.parentNode) if (matchCompound(p, parts[i])) i--;
  return i < 0;
}

/* ------------------------------- the scripts ------------------------------- */

function load(files, extra) {
  const ctx = Object.assign({
    document: {
      createElement: (t) => new El(t), querySelectorAll: () => [],
      createTextNode: (t) => Object.assign(new El("#text"), { textContent: t }),
    },
    window: {}, CSS: { escape: (s) => s },
    tr: (k, vars, fb) => (fb != null ? fb : k + (vars ? ' ' + JSON.stringify(vars) : '')),
    renderMarkdown: (s) => s, decorateCode() {},
    escapeHtml: (s) => String(s), icon: (n) => `<${n}>`,
    fmtDur: (ms) => Math.round(ms / 1000) + 's',
    isAgentTool: () => false, isShellTool: (n) => n === 'Bash' || n === 'PowerShell',
    shellStepLabel: () => '', shellPrompt: () => '', isImagePath: () => false,
    motionOK: () => false, maybeFollow() {}, replayClass() {}, setInterval: () => 1, clearInterval() {},
    COPY_ICON: '<copy>', copyFromButton() {},
    Set, Map, JSON, String, Array, Math, Date, Object, RegExp, Infinity, console,
  }, extra || {});
  const src = files.map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'app', f), 'utf8')).join('\n;\n');
  vm.runInNewContext(src, ctx, { filename: files.join('+') });
  return ctx;
}

const g = load(['messages.js', 'chips.js', 'mcp.js']);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

/* ---------------------------------- names ---------------------------------- */

test('an MCP tool reads as its service and what it did', () => {
  const p = g.mcpParts('mcp__cloudflare-api__execute');
  assert.deepStrictEqual({ ...p }, { key: 'cloudflare-api', server: 'Cloudflare API', tool: 'Execute' });
  assert.strictEqual(g.mcpParts('mcp__claude_ai_Atlassian_MCP__getJiraIssue').server, 'Atlassian');
  assert.strictEqual(g.mcpParts('mcp__claude_ai_Atlassian_MCP__getJiraIssue').tool, 'Get Jira Issue');
  assert.strictEqual(g.mcpParts('mcp__claude_ai_Google_Drive__list_files').server, 'Google Drive');
  assert.strictEqual(g.mcpParts('mcp__claude_ai_Google_Drive__list_files').tool, 'List files');
  assert.strictEqual(g.mcpParts('mcp__github__create_pull_request').server, 'GitHub');
  // Not MCP, or Krystal's own artifact tool (which has a card): nothing.
  assert.strictEqual(g.mcpParts('Read'), null);
  assert.strictEqual(g.mcpParts('mcp__krystal__artifact'), null);
  // The working line and the agent inspector get the same name.
  assert.strictEqual(g.toolLabel('mcp__cloudflare-api__docs'), 'Cloudflare API · Docs');
});

test('loading several tools of one service says so', () => {
  const q = 'select:mcp__cloudflare-api__whoami,mcp__cloudflare-api__docs,mcp__cloudflare-api__execute,mcp__cloudflare-api__search';
  assert.strictEqual(g.mcpToolSearchTarget(q), 'chip.mcpTools {"n":4,"server":"Cloudflare API"}');
  assert.strictEqual(g.mcpToolSearchTarget('select:mcp__cloudflare-api__docs'), null);        // one: its name does
  assert.strictEqual(g.mcpToolSearchTarget('select:mcp__a__x,mcp__b__y'), null);              // two services
  assert.strictEqual(g.mcpToolSearchTarget('select:WebFetch,mcp__a__x'), null);
  assert.strictEqual(g.mcpToolSearchTarget('notebook jupyter'), null);
});

test('JSON output is laid out; anything else is left as it came', () => {
  assert.strictEqual(g.prettyJson('{"a":1,"b":[2]}'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.strictEqual(g.prettyJson('{"a":1,"b":[2'), '{"a":1,"b":[2');      // cut off by the cap
  assert.strictEqual(g.prettyJson('plain text'), 'plain text');
});

test('urls in the output become links, trailing punctuation left out', () => {
  const pre = new El('pre');
  g.fillLinked(pre, 'see https://example.com/a. and http://x.io/b)');
  const links = pre.children.filter((c) => c.tagName === 'a');
  assert.deepStrictEqual(links.map((a) => a.href), ['https://example.com/a', 'http://x.io/b']);
  assert.strictEqual(pre.children.map((c) => c.textContent).join(''), 'see https://example.com/a. and http://x.io/b)');
});

/* ------------------------------- the chip --------------------------------- */

test('an MCP chip names its service and lists what it was asked', () => {
  const seg = { name: 'mcp__cloudflare-api__docs', id: 't1', target: 'email sending',
    args: [['query', 'email sending'], ['code', 'line 1\nline 2']] };
  const chip = g.renderActionChip(seg, false);
  assert.strictEqual(chip.dataset.mcp, 'cloudflare-api');
  const row = chip.querySelector('.chip-row');
  assert.ok(row.innerHTML.includes('<span class="chip-src">Cloudflare API</span> · Docs · email sending'));
  assert.ok(row.innerHTML.includes('<plug>'));
  const args = chip.querySelector('.chip-args');
  assert.strictEqual(args.children.length, 2);
  assert.ok(!args.children[0].classList.contains('block'));
  assert.ok(args.children[1].classList.contains('block'));    // multi-line: a box of its own
});

test('a failed MCP call is red on reload too, its error first', () => {
  const chip = g.renderActionChip({ name: 'mcp__x__y', id: 't2', isError: true, output: 'HTTP 403',
    args: [['q', 'a']] }, false);
  assert.ok(chip.classList.contains('error'));
  const details = chip.querySelector('.chip-details');
  assert.strictEqual(details.children[0].className, 'chip-out-head');
  assert.ok(details.children[1].classList.contains('err'));
  assert.ok(details.children[2].classList.contains('chip-args'));
});

/* ------------------------------ folded runs -------------------------------- */

const chipOf = (name, id, working) => g.renderActionChip({ name, id }, !!working);
function addTo(bubble, el, live) { bubble.appendChild(el); g.foldMcpRun(el, !!live); return el; }

test('three calls in a row to one service fold into one chip', () => {
  const b = new El('div');
  addTo(b, chipOf('mcp__cloudflare-api__whoami', 'a'));
  addTo(b, chipOf('mcp__cloudflare-api__docs', 'b'));
  assert.strictEqual(b.children.length, 2);                   // two lines aren't a wall yet
  addTo(b, chipOf('mcp__cloudflare-api__execute', 'c'));
  assert.strictEqual(b.children.length, 1);
  const group = b.children[0];
  assert.ok(group.classList.contains('chip-group'));
  assert.strictEqual(g.chipGroupChips(group).map((c) => c.dataset.id).join(), 'a,b,c');
  const label = group.querySelector('.chip-label').innerHTML;
  assert.ok(label.includes('Cloudflare API') && label.includes('chip.mcpCalls {"n":3}') && label.includes('Whoami, Docs, Execute'));
  assert.ok(group.querySelector('.chip-group-body').hidden);  // closed
  // The fourth joins it.
  addTo(b, chipOf('mcp__cloudflare-api__docs', 'd'));
  assert.strictEqual(b.children.length, 1);
  assert.strictEqual(g.chipGroupChips(group).length, 4);
  assert.ok(group.querySelector('.chip-label').innerHTML.includes('Whoami, Docs, Execute<'), 'each tool named once');
});

test('text between calls, or another service, breaks the run', () => {
  const b = new El('div');
  addTo(b, chipOf('mcp__cf__a', 'a'));
  addTo(b, chipOf('mcp__cf__b', 'b'));
  b.appendChild(new El('div'));                                // Claude said something
  addTo(b, chipOf('mcp__cf__c', 'c'));
  addTo(b, chipOf('mcp__other__d', 'd'));
  addTo(b, chipOf('Read', 'e'));
  assert.strictEqual(b.children.length, 6);
  assert.ok(!b.querySelector('.chip-group'));
});

test("the run's head works while any call does, and shows a failure", () => {
  const b = new El('div');
  ['a', 'b', 'c'].forEach((id) => addTo(b, chipOf('mcp__cf__x', id, true), true));
  const group = b.children[0];
  const head = group.querySelector('.chip-group-head');
  assert.ok(head.classList.contains('working'));
  const [a, bb, c] = g.chipGroupChips(group);
  for (const chip of [a, bb]) { chip.classList.remove('working'); chip.classList.add('done'); g.syncChipGroupOf(chip, true); }
  assert.ok(head.classList.contains('working'), 'one still out');
  c.classList.remove('working'); c.classList.add('done', 'error'); g.syncChipGroupOf(c, true);
  assert.ok(head.classList.contains('done') && !head.classList.contains('working'));
  assert.ok(head.classList.contains('error'));
  // A beat of light for a folded call lands on the head while the run is closed.
  assert.strictEqual(g.visibleChip(c), head);
  group.classList.add('open');
  assert.strictEqual(g.visibleChip(c), c);
});

test('a reloaded transcript folds the same way', () => {
  const b = new El('div');
  g.renderSegments(b, [
    { type: 'text', text: 'Checking Cloudflare.' },
    { type: 'tool', name: 'mcp__cf__a', id: 'a' },
    { type: 'tool', name: 'mcp__cf__b', id: 'b' },
    { type: 'tool', name: 'mcp__cf__c', id: 'c' },
  ]);
  assert.strictEqual(b.children.length, 2);
  assert.ok(b.children[1].classList.contains('chip-group'));
});

/* --------------------------- one chip per call ----------------------------- */

test('a call with nothing to show is still one chip, and it settles', () => {
  const work = { phase: '', toolId: '', set(p) { Object.assign(this, p); }, beat() {}, end() {}, detach() {} };
  const t = load(['messages.js', 'chips.js', 'mcp.js', 'typer.js'], {
    makeWorkLine: () => work, lightMode() {}, mascotMode() {}, lightWords() {}, mascotWords() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, makeLiveMarkdown: () => ({ update() {} }),
    renderMarkdown: (s) => s, decorateCode() {},
  });
  const b = new El('div');
  const typer = t.makeTyper(b);
  // start (name only), then stop (its input — no target for whoami)
  typer.setTool({ type: 'tool', name: 'mcp__cloudflare-api__whoami', id: 'w1' });
  typer.setTool({ type: 'tool', name: 'mcp__cloudflare-api__whoami', id: 'w1', args: [] });
  assert.strictEqual(b.children.length, 1, 'the second event refines the first chip');
  typer.setToolResult({ id: 'w1', output: '{"id":"u"}' }, true);
  assert.ok(b.children[0].classList.contains('done'));
  assert.ok(!b.querySelector('.action-chip.working'), 'nothing left spinning');
  // Two calls of the same tool are still two chips.
  typer.setTool({ type: 'tool', name: 'mcp__cloudflare-api__docs', id: 'd1' });
  typer.setTool({ type: 'tool', name: 'mcp__cloudflare-api__docs', id: 'd1', target: 'x' });
  typer.setTool({ type: 'tool', name: 'mcp__cloudflare-api__docs', id: 'd2' });
  typer.setTool({ type: 'tool', name: 'mcp__cloudflare-api__docs', id: 'd2', target: 'y' });
  // …and with whoami before them, three calls to one service fold.
  assert.strictEqual(b.children.length, 1);
  assert.strictEqual(g.chipGroupChips.call(null, b.children[0]).length, 3);
});

console.log(`\nall passing (${passed})`);
