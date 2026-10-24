/* Every backend command is wired up in several places that only agree by
 * convention — nothing in the compiler checks them against each other:
 *
 *   src-tauri/src/*.rs   the #[tauri::command] fn and its parameters
 *   main.rs              its entry in generate_handler!
 *   server.rs `dispatch` the hand-written bridge a phone or another Krystal
 *                        reaches it through, which reads each argument by name
 *   src/app/*.js         the invoke('cmd', { … }) calls, whose keys Tauri maps
 *                        onto the parameters (snake_case → camelCase)
 *
 * A typo in any of them fails quietly: `arg_str` reads a misspelt key as "",
 * and Tauri reads a misspelt optional argument as None. These checks read the
 * sources and make the layers agree.
 *
 * Run: node tests/commands.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const rsDir = 'src-tauri/src';

/* ---------------------------- reading the sources ---------------------------- */

/* The text from `open` (an index just past an opening bracket) to its match. */
function balanced(src, open, pairs) {
  let depth = 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (pairs.open.includes(c)) depth++;
    else if (pairs.close.includes(c) && --depth === 0) return src.slice(open, i);
  }
  throw new Error('unbalanced at ' + open);
}

/* Split on commas that sit at the top level of a parameter or object list. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('<([{'.includes(c)) depth++;
    if ('>)]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/* Parameters Tauri fills in from the type rather than from the caller. */
const injected = (type) => /\b(State|AppHandle|Window|WebviewWindow)\b/.test(type);

/* name → [{ key, optional, channel }] for every #[tauri::command]. */
function commandSignatures() {
  const sigs = new Map();
  for (const file of fs.readdirSync(path.join(root, rsDir))) {
    if (!file.endsWith('.rs')) continue;
    const src = read(path.join(rsDir, file));
    const re = /#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+(\w+)/g;
    let m;
    while ((m = re.exec(src))) {
      let i = re.lastIndex;
      if (src[i] === '<') i += balanced(src, i + 1, { open: '<', close: '>' }).length + 2;
      assert.strictEqual(src[i], '(', `${file}: can't read the parameters of ${m[1]}`);
      const params = splitTop(balanced(src, i + 1, { open: '(', close: ')' }))
        .map((p) => {
          const [name, ...type] = p.split(':');
          return { name: name.trim().replace(/^mut\s+/, ''), type: type.join(':').trim() };
        })
        .filter((p) => !injected(p.type))
        .map((p) => ({
          key: camel(p.name),
          optional: p.type.startsWith('Option<'),
          channel: /\bChannel\b/.test(p.type),
        }));
      sigs.set(m[1], params);
    }
  }
  return sigs;
}

/* The commands main.rs hands to Tauri. */
function registeredCommands() {
  const src = read(path.join(rsDir, 'main.rs'));
  const start = src.indexOf('generate_handler![') + 'generate_handler!['.length;
  return splitTop(balanced(src, start, { open: '[', close: ']' })).map((p) => p.split('::').pop());
}

/* server.rs `dispatch`: [{ name, calls, keys }] for each arm. */
function dispatchArms() {
  const src = read(path.join(rsDir, 'server.rs'));
  const from = src.indexOf('let out = match cmd {');
  const to = src.indexOf('_ => return None', from);
  assert.ok(from > 0 && to > from, "can't find the match in server.rs dispatch");
  const body = src.slice(from, to);
  const heads = [...body.matchAll(/^\s+"(\w+)" =>/gm)];
  return heads.map((h, n) => {
    const text = body.slice(h.index, n + 1 < heads.length ? heads[n + 1].index : body.length);
    const call = text.match(/(?:commands|server)::(\w+)\(/);
    const keys = [
      ...[...text.matchAll(/arg_\w+\(a, "(\w+)"\)/g)].map((k) => k[1]),
      ...[...text.matchAll(/a\.get\("(\w+)"\)/g)].map((k) => k[1]),
    ];
    return { name: h[1], calls: call && call[1], keys };
  });
}

/* server.rs `is_streaming_command`: the commands reached over /api/stream. */
function streamingCommands() {
  const src = read(path.join(rsDir, 'server.rs'));
  const m = src.match(/fn is_streaming_command[\s\S]*?matches!\(cmd,([^)]*)\)/);
  assert.ok(m, "can't find is_streaming_command in server.rs");
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

/* core.js LOCAL_ONLY_COMMANDS: what the desktop never sends to another machine. */
function localOnlyCommands() {
  const src = read('src/app/core.js');
  const m = src.match(/LOCAL_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "can't find LOCAL_ONLY_COMMANDS in core.js");
  return [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'(\w+)'/g)].map((x) => x[1]);
}

/* Every invoke('cmd', …) in the desktop frontend: [{ file, cmd, keys|null }].
 * `keys` is null when the arguments aren't a plain object literal (a variable,
 * a spread) — those can't be checked from the source. */
function invokeCalls() {
  const calls = [];
  const files = [
    ...fs.readdirSync(path.join(root, 'src/app')).map((f) => 'src/app/' + f),
    'src/onboarding.js', 'src/updater.js',
  ].filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const src = read(file);
    const re = /\binvoke\('(\w+)'\s*(,\s*\{)?/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;   // an example in a comment
      let keys = [];
      if (m[2]) {
        const parts = splitTop(balanced(src, re.lastIndex, { open: '{', close: '}' }));
        keys = parts.some((p) => p.startsWith('...')) ? null : parts.map((p) => p.split(':')[0].trim());
      } else if (!/^\s*\)/.test(src.slice(re.lastIndex))) {
        keys = null;
      }
      calls.push({ file, cmd: m[1], keys });
    }
  }
  return calls;
}

/* ------------------------------------ tests ------------------------------------ */

const sigs = commandSignatures();
const registered = registeredCommands();
const arms = dispatchArms();
const streaming = streamingCommands();
const localOnly = localOnlyCommands();
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + '\n     ' + e.message.replace(/\n/g, '\n     '));
  }
}

check('the sources parse into something sensible', () => {
  assert.ok(sigs.size > 80, `only ${sigs.size} #[tauri::command] fns found`);
  assert.ok(registered.length > 80, `only ${registered.length} registered commands found`);
  assert.ok(arms.length > 60, `only ${arms.length} dispatch arms found`);
});

check('every registered command is a #[tauri::command] fn, and vice versa', () => {
  const missing = registered.filter((c) => !sigs.has(c));
  const unregistered = [...sigs.keys()].filter((c) => !registered.includes(c));
  assert.deepStrictEqual({ missing, unregistered }, { missing: [], unregistered: [] });
});

check('every dispatch arm calls the command it is named after', () => {
  const wrong = arms.filter((a) => a.calls !== a.name).map((a) => `"${a.name}" calls ${a.calls}`);
  assert.deepStrictEqual(wrong, []);
});

check('every argument dispatch reads is a parameter of that command', () => {
  const bad = [];
  for (const a of arms) {
    const params = (sigs.get(a.name) || []).map((p) => p.key);
    for (const k of a.keys) if (!params.includes(k)) bad.push(`${a.name}: "${k}" (has ${params.join(', ')})`);
  }
  assert.deepStrictEqual(bad, []);
});

check('dispatch passes every required argument', () => {
  const bad = [];
  for (const a of arms) {
    for (const p of sigs.get(a.name) || []) {
      if (!p.optional && !p.channel && !a.keys.includes(p.key)) bad.push(`${a.name}: "${p.key}"`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

check('every command is either bridged for remote callers or marked local-only', () => {
  const bridged = new Set([...arms.map((a) => a.name), ...streaming, ...localOnly]);
  const neither = registered.filter((c) => !bridged.has(c));
  assert.deepStrictEqual(neither, [], 'a remote desktop calling these gets "command not available remotely" — '
    + 'add a dispatch arm in server.rs, or list them in LOCAL_ONLY_COMMANDS (core.js)');
});

check('nothing is both bridged and local-only', () => {
  const both = localOnly.filter((c) => arms.some((a) => a.name === c) || streaming.includes(c));
  assert.deepStrictEqual(both, []);
});

check('every local-only command exists', () => {
  assert.deepStrictEqual(localOnly.filter((c) => !registered.includes(c)), []);
});

check('every invoke() in the frontend names a registered command', () => {
  const calls = invokeCalls();
  assert.ok(calls.length > 80, `only ${calls.length} invoke() calls found`);
  const unknown = calls.filter((c) => !registered.includes(c.cmd)).map((c) => `${c.file}: ${c.cmd}`);
  assert.deepStrictEqual(unknown, []);
});

check("every invoke() argument is one of the command's parameters", () => {
  const bad = [];
  for (const c of invokeCalls()) {
    if (!c.keys || !sigs.has(c.cmd)) continue;
    const params = sigs.get(c.cmd).map((p) => p.key);
    for (const k of c.keys) if (!params.includes(k)) bad.push(`${c.file}: ${c.cmd} "${k}" (has ${params.join(', ')})`);
  }
  assert.deepStrictEqual(bad, []);
});

// Channels are left out: a call bound for another Krystal drops its Channel on
// purpose (`compact` in core.js), and the host's dispatch supplies its own.
check('every invoke() passes the arguments its command requires', () => {
  const bad = [];
  for (const c of invokeCalls()) {
    if (!c.keys || !sigs.has(c.cmd)) continue;
    for (const p of sigs.get(c.cmd)) {
      if (!p.optional && !p.channel && !c.keys.includes(p.key)) bad.push(`${c.file}: ${c.cmd} "${p.key}"`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

if (failures) {
  console.log(`\n${failures} command-wiring check(s) failed`);
  process.exit(1);
}
console.log('\nall command-wiring tests passed');
