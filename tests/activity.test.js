/* Tests for the Activity panel's reading of what Claude ran (src/app/describe.js
 * and src/app/activity.js):
 * commands put into plain words when Claude gave no description, what kind of
 * step each is (which decides its icon and what folds away as looking-around),
 * steps grouped under the message that asked for them, and runs of
 * looking-around folded into one line. Every label is checked against the real
 * dictionary, in English and Croatian, so no key is left without its words.
 *
 * Same approach as the other frontend tests — the files are classic scripts that
 * share one global scope, so each is loaded into a vm context holding just the
 * globals it expects.
 *
 * Run: node tests/activity.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// The real dictionary, behind the same window.I18N the app uses.
const i18nCtx = {
  window: {},
  localStorage: { getItem: () => null, setItem() {} },
  document: { documentElement: {}, querySelectorAll: () => [], dispatchEvent() {} },
  CustomEvent: function CustomEvent() {},
};
vm.runInNewContext(read('src', 'i18n.js'), i18nCtx, { filename: 'i18n.js' });
const I18N = i18nCtx.window.I18N;

function loadActivity() {
  const stub = () => ({ addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const els = new Proxy({}, { get: (o, k) => (o[k] || (o[k] = stub())) });
  const ctx = {
    window: { I18N },
    tr: (k, v, f) => I18N.t(k, v, f),
    escapeHtml: (s) => String(s), icon: () => '',
    isShellTool: (n) => n === 'Bash' || n === 'PowerShell',
    isAgentTool: (n) => n === 'Agent' || n === 'Task',
    state: { activity: [], streaming: false },
    els, document: { addEventListener() {}, createElement: stub },
    Set, Map, JSON, String, Array, Math, Date, Number, Object, RegExp, console,
  };
  const exported = ['describeCommand', 'commandText', 'splitCommand', 'commandWords', 'activityTurns',
    'activitySteps', 'activityFromSegments', 'activityInfo', 'shellStepLabel', 'hasOwnDescription',
    'actPlural', 'CMD_KINDS'];
  // describe.js loads just before activity.js in index.html, as it does here.
  const src = read('src', 'app', 'describe.js') + '\n' + read('src', 'app', 'activity.js');
  return vm.runInNewContext(`${src}\n;({ ${exported.join(', ')} })`, ctx, { filename: 'describe.js+activity.js' });
}

const A = loadActivity();
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
const say = (cmd) => A.commandText(A.describeCommand(cmd));
const kind = (cmd) => A.describeCommand(cmd).kind;

/* ------------------------------- splitting ------------------------------- */

test('splits at && ; || and pipes, outside quotes, and marks piped filters', () => {
  const p = A.splitCommand('cd /x && grep -n "a|b; c" src | head -20; ls');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), [
    { text: 'cd /x', piped: false },
    { text: 'grep -n "a|b; c" src', piped: false },
    { text: 'head -20', piped: true },
    { text: 'ls', piped: false },
  ]);
});

test('a heredoc body is data, not more commands', () => {
  const p = A.splitCommand("cat > notes.md <<'EOF'\nrm -rf everything\nEOF");
  assert.strictEqual(p.length, 1);
});

test('words lose their quotes but keep Windows backslashes', () => {
  assert.deepStrictEqual(Array.from(A.commandWords('Get-Content "C:\\My Docs\\a.txt" -Tail 5')),
    ['Get-Content', 'C:\\My Docs\\a.txt', '-Tail', '5']);
});

/* --------------------------- plain-word labels --------------------------- */

test('the commands from the screenshot read as what they do', () => {
  I18N.setLang('en');
  assert.strictEqual(say('cd /c/Users/marin/Desktop/Projekti/krystal && ls src && wc -l src/*.css 2>/dev/null; grep -c "@keyframes" src/*.css; grep -o "@keyframes [a-zA-Z0-9_-]*" src/*.css | head -120'),
    'List files in src');
  assert.strictEqual(say('cd /c/Users/marin/Desktop/Projekti/krystal && grep -n -A8 "@keyframes msg-in\\|@keyframes composer-fresh" src/chat.css | head -60'),
    'Search for “@keyframes msg-in…”');
});

test('searching, reading, listing, counting', () => {
  assert.strictEqual(say('rg -n "fn tool_detail" src-tauri'), 'Search for “fn tool_detail”');
  assert.strictEqual(say('grep -c foo a.txt'), 'Search for “foo”', '-c counts, it takes no value');
  assert.strictEqual(say('grep -C 3 foo a.txt'), 'Search for “foo”', '-C takes a value');
  assert.strictEqual(say('Select-String -Path src\\*.js -Pattern "copyText"'), 'Search for “copyText”');
  assert.strictEqual(say('head -n 40 src/app/chat.js'), 'Read chat.js');
  assert.strictEqual(say('sed -n 120,160p src/app/chat.js'), 'Read chat.js');
  assert.strictEqual(say('cat a.md b.md c.md'), 'Read a.md +2');
  assert.strictEqual(say('Get-Content C:\\proj\\README.md -TotalCount 20'), 'Read README.md');
  assert.strictEqual(say('ls'), 'List files');
  assert.strictEqual(say('Get-ChildItem -Recurse -Filter *.md | Measure-Object'), 'List files');
  assert.strictEqual(say('wc -l src/app/activity.js'), 'Count lines in activity.js');
});

test('building, testing, starting', () => {
  assert.strictEqual(say('cd src-tauri && cargo build 2>&1 | tail -20'), 'Build the project');
  assert.strictEqual(say('cargo test --lib'), 'Run the tests');
  assert.strictEqual(say('npm test'), 'Run the tests');
  assert.strictEqual(say('npm run tauri build'), 'Build the project');
  assert.strictEqual(say('npx tauri build'), 'Build the project');
  assert.strictEqual(say('npm run dev'), 'Start the app');
  assert.strictEqual(say('node tests/activity.test.js'), 'Run the tests');
  assert.strictEqual(say('python -m pytest -q'), 'Run the tests');
  assert.strictEqual(say('node scripts/release.js'), 'Run release.js');
  assert.strictEqual(say('node -e "console.log(1)"'), 'Run a quick script');
  assert.strictEqual(say('npm run gen-icons'), 'Run the “gen-icons” script');
});

test('changing things', () => {
  assert.strictEqual(say('npm install left-pad'), 'Install left-pad');
  assert.strictEqual(say('pip install -r requirements.txt'), 'Install requirements.txt');
  assert.strictEqual(say('git add -A && git commit -m "Fix it"'), 'Change the repository');
  assert.strictEqual(say('git commit -am "Fix it"'), 'Save a commit');
  assert.strictEqual(say('git push origin main'), 'Push the commits');
  assert.strictEqual(say('rm -rf build'), 'Delete build');
  assert.strictEqual(say('Remove-Item -Recurse -Force .\\dist'), 'Delete dist');
  assert.strictEqual(say('mkdir -p src/new'), 'Create new');
  assert.strictEqual(say("cat > notes.md <<'EOF'\nhello\nEOF"), 'Write notes.md');
  assert.strictEqual(say('echo hi > out.txt'), 'Write out.txt');
  assert.strictEqual(say('sed -i "s/a/b/" file.txt'), 'Edit file.txt');
  assert.strictEqual(say('taskkill /F /IM node.exe'), 'Stop a running program');
});

test('git that only looks', () => {
  assert.strictEqual(say('git status --short'), 'Check what changed');
  assert.strictEqual(say('git -C ../other diff HEAD~1'), 'Check what changed');
  assert.strictEqual(say('git log --oneline -n 5'), 'Look through the history');
  assert.strictEqual(say('git branch -a'), 'Check the repository');
  assert.strictEqual(say('git stash list'), 'Check the repository');
});

test('a shell inside a shell is read for what it runs', () => {
  assert.strictEqual(say('powershell -NoProfile -Command "Get-Content C:\\x\\log.txt -Tail 20"'), 'Read log.txt');
  assert.strictEqual(say('bash -c "npm test"'), 'Run the tests');
});

test('the stage-setting is skipped; anything unknown is "Run <program>"', () => {
  assert.strictEqual(say('cd src && echo "---" && ffmpeg -i a.mp4 b.gif'), 'Run ffmpeg');
  assert.strictEqual(say('cd src'), 'Check the current folder');
  assert.strictEqual(say('& "C:\\Tools\\thing.exe" --go'), 'Run thing');
  assert.strictEqual(say('node --version'), 'Check node is available');
  assert.strictEqual(say(''), 'Run a command');
});

/* ---------------------------------- kinds ---------------------------------- */

test('the weightiest piece decides the kind', () => {
  assert.strictEqual(kind('ls && cat a.txt | head'), 'look');
  assert.strictEqual(kind('grep -rn x src > hits.txt'), 'change', 'a redirect into a file writes it');
  assert.strictEqual(kind('grep x a 2>/dev/null'), 'look', 'stderr into the void writes nothing');
  assert.strictEqual(kind('ls && npm test'), 'run');
  assert.strictEqual(kind('npm test && git commit -m x'), 'change');
  assert.strictEqual(kind('cd src && echo hi'), 'look');
});

test('every key has a kind, an icon, and words in both languages', () => {
  const dict = read('src', 'i18n.js');
  for (const key of Object.keys(A.CMD_KINDS)) {
    const [k, ic] = A.CMD_KINDS[key];
    assert.ok(['look', 'run', 'change', 'other'].includes(k), key + ' kind');
    assert.ok(ic, key + ' icon');
    const n = dict.split(`'activity.cmd.${key}':`).length - 1;
    assert.strictEqual(n, 2, `activity.cmd.${key} appears ${n} times (EN + HR expected)`);
    const withX = /\{x\}/.test(I18N.t('activity.cmd.' + key));
    if (withX) {
      const n0 = dict.split(`'activity.cmd.${key}0':`).length - 1;
      assert.strictEqual(n0, 2, `activity.cmd.${key}0 (nothing to name) appears ${n0} times`);
    }
  }
});

test('Croatian reads too', () => {
  I18N.setLang('hr');
  assert.strictEqual(say('npm test'), 'Pokretanje testova');
  assert.strictEqual(say('cat src/app/chat.js'), 'Čitanje: chat.js');
  assert.strictEqual(say('ls'), 'Popis datoteka');
  assert.strictEqual(A.actPlural(1, 'activity.n.cmd'), '1 naredba');
  assert.strictEqual(A.actPlural(3, 'activity.n.cmd'), '3 naredbe');
  assert.strictEqual(A.actPlural(12, 'activity.n.cmd'), '12 naredbi');
  assert.strictEqual(A.actPlural(22, 'activity.n.cmd'), '22 naredbe');
  assert.strictEqual(A.actPlural(21, 'activity.n.agent'), '21 pod-agent');
  assert.strictEqual(A.actPlural(4, 'activity.n.failed'), '4 s greškom');
  I18N.setLang('en');
  assert.strictEqual(A.actPlural(1, 'activity.n.cmd'), '1 command');
  assert.strictEqual(A.actPlural(3, 'activity.n.failed'), '3 failed');
});

/* ------------------------------ descriptions ------------------------------ */

test("Claude's own description wins; the backend's fallback is read instead", () => {
  const described = { name: 'Bash', target: 'Run the unit tests', detail: 'npx vitest run --reporter=dot' };
  const bare = { name: 'Bash', target: 'cd /c/Users/marin/Desktop/Projekti/k', detail: 'cd /c/Users/marin/Desktop/Projekti/krystal && git status' };
  assert.strictEqual(A.hasOwnDescription(described), true);
  assert.strictEqual(A.hasOwnDescription(bare), false);
  assert.strictEqual(A.shellStepLabel(described), 'Run the unit tests');
  assert.strictEqual(A.shellStepLabel(bare), 'Check what changed');
  assert.strictEqual(A.activityInfo(described).kind, 'run', 'the kind still comes from the command');
  const agent = { name: 'Agent', target: 'Survey the motion lay', detail: 'Survey the motion layer for loops' };
  assert.strictEqual(A.activityInfo(agent).label, 'Survey the motion layer for loops');
  assert.strictEqual(A.activityInfo(agent).kind, 'agent');
});

/* ------------------------------ turns & folds ------------------------------ */

const sh = (id, cmd, extra) => Object.assign({ id, name: 'Bash', target: cmd.slice(0, 36), detail: cmd, output: '', isError: false, running: false }, extra || {});

test('saved steps remember the message that asked for them', () => {
  const msgs = [
    { id: 1, role: 'user', text: 'Look around' },
    { id: 2, role: 'assistant', segments: [{ type: 'tool', id: 'a', name: 'Bash', detail: 'ls' }, { type: 'tool', id: 'r', name: 'Read', detail: 'x' }] },
    { id: 3, role: 'user', text: 'Now build it' },
    { id: 4, role: 'assistant', segments: [{ type: 'tool', id: 'b', name: 'Bash', detail: 'cargo build' }, { type: 'tool', id: 'c', name: 'Agent', detail: 'Check' }] },
  ];
  const list = A.activityFromSegments(msgs);
  assert.deepStrictEqual(Array.from(list, (a) => a.id), ['a', 'b', 'c'], 'only shells and sub-agents');
  const turns = A.activityTurns(list);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(turns.map((g) => [g.key, g.turn.text, g.items.length]))), [['m1', 'Look around', 1], ['m3', 'Now build it', 2]]);
  assert.strictEqual(turns[1].turn.mid, 3);
});

test('three or more quiet looks in a row fold; a failure or a change breaks the run', () => {
  const kindOf = (a) => A.activityInfo(a).kind;
  const idle = () => false;
  const items = [
    sh('1', 'ls'), sh('2', 'cat a.txt'), sh('3', 'grep x src'),
    sh('4', 'npm test'),
    sh('5', 'git status'), sh('6', 'grep nope src', { isError: true }), sh('7', 'ls src'),
    { id: 'ag', name: 'Agent', target: 'Dig', detail: 'Dig into it', output: null, isError: false, running: false },
  ];
  const steps = A.activitySteps(items, kindOf, idle);
  assert.deepStrictEqual(Array.from(steps, (s) => s.type === "fold" ? "fold:" + s.items.map((a) => a.id).join("") : s.a.id),
    ['ag', 'fold:123', '4', '5', '6', '7'], 'the sub-agent leads; two looks are left as they are');
  const live = A.activitySteps([sh('1', 'ls'), sh('2', 'ls'), sh('3', 'ls')], kindOf, (a) => a.id === '3');
  assert.deepStrictEqual(Array.from(live, (s) => s.type), ['step', 'step', 'step'], 'a running look stays in view, and the rest is too short to fold');
});

console.log(`activity.test.js: ${passed} passed`);
