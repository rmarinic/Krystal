/* describe.js   — shell commands in plain words ("Search for “x”", "Run the
                 tests") for the Activity panel and the transcript's shell chips
   Part of the chat frontend; shares one global scope (see core.js). */

/* --------------------------- commands in plain words --------------------------- */
/* Claude labels a command with its own one-line `description` — but that is
 * optional, and without one the backend falls back to the command's first
 * characters (`cd /c/Users/marin/Desktop/Projekti/k`). So a command is also
 * read here: the first thing it really does, in words, and what *kind* of step
 * it is — `look` (reading, searching, listing), `run` (build, test, start),
 * `change` (install, write, delete, commit) or `other` — which picks its icon and
 * decides what may fold away as looking-around. Deliberately shallow: a handful
 * of common programs, not a shell parser. Anything unknown is "Run <program>". */

// key -> [kind, icon]. The label is `activity.cmd.<key>` with {x}, or
// `activity.cmd.<key>0` when there is nothing to name.
const CMD_KINDS = {
  search: ['look', 'search'], list: ['look', 'folder'], read: ['look', 'read'], count: ['look', 'chart'],
  gitStatus: ['look', 'branch'], gitLog: ['look', 'branch'], gitLook: ['look', 'branch'],
  version: ['look', 'terminal'], where: ['look', 'folder'], checkPath: ['look', 'folder'],
  github: ['look', 'globe'], print: ['look', 'terminal'],
  test: ['run', 'check'], build: ['run', 'package'], start: ['run', 'play'], lint: ['run', 'check'],
  script: ['run', 'play'], runFile: ['run', 'play'], quick: ['run', 'play'],
  fetch: ['run', 'globe'], open: ['run', 'link'], wait: ['other', 'clock'],
  install: ['change', 'package'], gitCommit: ['change', 'branch'], gitPush: ['change', 'branch'],
  gitPull: ['change', 'branch'], gitSwitch: ['change', 'branch'], gitChange: ['change', 'branch'],
  delete: ['change', 'trash'], move: ['change', 'edit'], copy: ['change', 'file'],
  create: ['change', 'folder'], edit: ['change', 'edit'], write: ['change', 'write'], stop: ['change', 'stop'],
  other: ['other', 'terminal'],
};
const CMD_RANK = { look: 0, other: 1, run: 2, change: 3 };
// Pieces that only set the stage (or print a separator) — never what a command is *for*.
const CMD_NOISE = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd', 'popd', 'echo', 'printf',
  'write-host', 'write-output', 'true', 'exit', 'clear', 'cls', 'set', 'export', 'source', '.']);
// Flags that take the next word as their value, per program — so `head -n 40`
// doesn't read as a file called "40".
const CMD_VALUE_FLAGS = {
  grep: ['-A', '-B', '-C', '-m', '-e', '-f', '--max-count'],
  rg: ['-A', '-B', '-C', '-m', '-e', '-g', '-t', '-T', '-M', '-j', '--glob', '--type', '--max-count'],
  head: ['-n', '-c'], tail: ['-n', '-c'], sed: ['-e', '-f'], awk: ['-F', '-v', '-f'],
  find: ['-name', '-iname', '-type', '-maxdepth', '-mindepth', '-path', '-newer', '-size', '-mtime', '-not'],
  'select-string': ['-path', '-literalpath', '-pattern', '-context', '-encoding'],
  'get-childitem': ['-filter', '-include', '-exclude', '-depth', '-path', '-literalpath'],
  'get-content': ['-totalcount', '-tail', '-head', '-encoding', '-path', '-literalpath', '-first', '-last'],
  'new-item': ['-itemtype', '-path', '-name', '-value', '-type'],
  'set-content': ['-path', '-value', '-encoding', '-literalpath'],
  'out-file': ['-filepath', '-encoding', '-path'],
  git: ['-C', '-c', '-m', '-n', '--format', '--pretty', '--author', '--since', '--until', '-b', '-B'],
};
const CMD_ALIAS = {
  egrep: 'grep', fgrep: 'grep', ag: 'rg', ack: 'rg', sls: 'select-string', findstr: 'select-string',
  gci: 'get-childitem', dir: 'get-childitem', ls: 'get-childitem', ll: 'get-childitem', la: 'get-childitem',
  gc: 'get-content', cat: 'get-content', type: 'get-content', bat: 'get-content', less: 'get-content',
  more: 'get-content', nl: 'get-content', jq: 'get-content',
  ni: 'new-item', sc: 'set-content', ac: 'set-content', 'add-content': 'set-content', tee: 'set-content',
  'tee-object': 'set-content', 'out-file': 'set-content',
  python3: 'python', py: 'python', pwsh: 'powershell', yarn: 'npm', pnpm: 'npm', bun: 'npm',
  npx: 'npx', pnpx: 'npx', bunx: 'npx', gradlew: 'gradle', mvnw: 'mvn',
};

// Split a command line into its top-level pieces at && || ; | and newlines,
// outside quotes. `piped` marks a piece fed by the one before — a filter like
// `| head -40` says nothing about what the command is for. A heredoc ends the
// splitting: its body is data, not commands.
function splitCommand(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '', q = '', piped = false;
  const push = (next) => { if (cur.trim()) out.push({ text: cur.trim(), piped }); cur = ''; piped = next; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '<' && s[i + 1] === '<') { cur += s.slice(i); break; }
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) { push(false); i++; continue; }
    if (c === '|') { push(true); continue; }
    if (c === ';' || c === '\n') { push(false); continue; }
    cur += c;
  }
  push(false);
  return out;
}

// One piece into words, quotes removed. Backslashes are kept: they are Windows
// paths far more often than escapes.
function commandWords(text) {
  const out = [];
  let cur = '', q = '', had = false;
  for (const c of String(text || '')) {
    if (q) { if (c === q) q = ''; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (/\s/.test(c)) { if (cur || had) out.push(cur); cur = ''; had = false; continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

const cmdBase = (w) => String(w || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || String(w || '');
// Something short enough for a one-line label.
function cmdClip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}
// A search pattern as a person would say it: the first alternative of
// `a\|b|c`, escapes dropped, anchors gone.
function cmdPattern(p) {
  const parts = String(p || '').split(/\\?\|/);
  let s = parts[0].replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1').replace(/\.\*/g, '…');
  if (parts.length > 1) s += '…';
  return cmdClip(s, 40);
}

// Is `w` the flag `name`? A one-letter flag is case-sensitive (`grep -c` counts,
// `-C 3` is context); a long one is not (PowerShell's `-Path` / `-path`).
const cmdIsFlag = (w, name) => (name.length <= 2 ? w === name : w.toLowerCase() === name.toLowerCase());

// The positional words of a piece, skipping flags, the values they take, and
// redirects (`2>/dev/null`, `> out.txt`).
function cmdPositionals(prog, args) {
  const takes = CMD_VALUE_FLAGS[prog] || [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (/^\d*(<<?|>>?)/.test(w)) {
      if (/^\d*(<<?|>>?)&?$/.test(w)) i++;     // the operator alone: its target is the next word
      continue;
    }
    if (/^-/.test(w) && w.length > 1) {
      if (takes.some((f) => cmdIsFlag(w, f))) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}
// The value given to a flag (`-Pattern x`, `-e x`), if any.
function cmdFlag(args, ...names) {
  const i = args.findIndex((w) => names.some((n) => cmdIsFlag(w, n)));
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
// Files named in a label: the first one, "+N" for the rest.
function cmdFiles(list) {
  const f = list.filter((w) => w && w !== '.' && w !== './' && w !== '-');
  if (!f.length) return '';
  return cmdClip(cmdBase(f[0]), 36) + (f.length > 1 ? ` +${f.length - 1}` : '');
}
// What a package-manager script is, from its name: `tauri build` builds,
// `dev` starts, `test:unit` tests.
function cmdScript(name) {
  const n = String(name || '').toLowerCase();
  if (/test|spec/.test(n)) return { key: 'test' };
  if (/build|compile|bundle|pack|dist/.test(n)) return { key: 'build' };
  if (/\b(dev|start|serve|watch|preview)\b/.test(n)) return { key: 'start' };
  if (/lint|check|typecheck|tsc|format|fmt/.test(n)) return { key: 'lint' };
  return n ? { key: 'script', x: cmdClip(name, 30) } : { key: 'other', x: 'npm' };
}

// Read one piece (already split into words). Returns { key, x } or null for an
// empty piece.
function classifyPiece(words) {
  words = words.slice();
  // Prefixes that wrap the real command: env assignments, PowerShell's call
  // operator and variable assignment, `sudo`, `time`, GNU `timeout 60 …`.
  while (words.length) {
    const w = words[0];
    if (/^[A-Za-z_][\w]*=/.test(w) || w === '&' || w === 'sudo' || w === 'time' || w === 'nohup' || w === 'env') { words.shift(); continue; }
    if (/^\$\w+$/.test(w) && words[1] === '=') { words.splice(0, 2); continue; }
    if (w === 'timeout' && /^\d+[smh]?$/.test(words[1] || '') && words.length > 2) { words.splice(0, 2); continue; }
    break;
  }
  if (!words.length) return null;
  const raw = words[0];
  const args = words.slice(1);
  // A script run by path: ./build.sh, .\deploy.ps1, scripts/x.py.
  if (/^\.{1,2}[\\/]/.test(raw) || /\.(ps1|sh|py|js|mjs|ts|rb|pl)$/i.test(raw)) {
    return /test|spec/i.test(raw) ? { key: 'test' } : { key: 'runFile', x: cmdClip(cmdBase(raw), 36) };
  }
  const named = cmdBase(raw).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  const prog = CMD_ALIAS[named] || named;
  const pos = cmdPositionals(prog, args);
  const lower = args.map((w) => w.toLowerCase());
  if (args.length === 1 && /^(--version|-v|-V|version)$/.test(args[0])) return { key: 'version', x: named };

  switch (prog) {
    case 'cd': case 'set-location': case 'sl': case 'chdir': case 'pushd': case 'popd':
    case 'pwd': case 'get-location': case 'gl':
      return { key: 'where' };
    case 'echo': case 'printf': case 'write-host': case 'write-output':
      return { key: 'print' };
    case 'grep': case 'rg': {
      const p = cmdFlag(args, '-e', '--regexp') || pos[0];
      return p ? { key: 'search', x: cmdPattern(p) } : { key: 'search' };
    }
    case 'select-string': {
      const p = cmdFlag(args, '-pattern') || pos[0];
      return p ? { key: 'search', x: cmdPattern(p) } : { key: 'search' };
    }
    case 'get-childitem': case 'tree': case 'fd':
      return { key: 'list', x: cmdFiles(pos.slice(0, 1)) };
    case 'find':
      return { key: 'list', x: cmdFiles(pos.slice(0, 1)) };
    case 'get-content': case 'head': case 'tail': case 'awk': case 'xxd': case 'od': case 'strings':
      return { key: 'read', x: cmdFiles(prog === 'awk' ? pos.slice(1) : pos) };
    case 'sed':
      // `sed -i` rewrites the file; plain `sed`/`sed -n` only prints it.
      if (lower.some((w) => /^-i/.test(w) || w === '--in-place')) return { key: 'edit', x: cmdFiles(pos.slice(1)) };
      return { key: 'read', x: cmdFiles(pos.slice(1)) };
    case 'wc': case 'measure-object':
      return { key: 'count', x: cmdFiles(pos) };
    case 'test-path':
      return { key: 'checkPath', x: cmdFiles(pos.slice(0, 1)) };
    case 'which': case 'where': case 'whereis': case 'get-command': case 'gcm': case 'command':
      return { key: 'version', x: cmdClip(pos[pos.length - 1] || named, 24) };
    case 'git': {
      const sub = (pos[0] || '').toLowerCase();
      const rest = pos.slice(1);
      if (sub === 'status' || sub === 'diff') return { key: 'gitStatus' };
      if (['log', 'show', 'blame', 'shortlog', 'reflog'].includes(sub)) return { key: 'gitLog' };
      if (['remote', 'rev-parse', 'ls-files', 'describe', 'grep', 'ls-remote', 'rev-list'].includes(sub)) return { key: 'gitLook' };
      if (((sub === 'branch' || sub === 'tag') && !rest.length) || (sub === 'stash' && rest[0] === 'list')) return { key: 'gitLook' };
      if (sub === 'config' && lower.some((w) => w === '--get' || w === '--list' || w === '-l')) return { key: 'gitLook' };
      if (sub === 'commit') return { key: 'gitCommit' };
      if (sub === 'push') return { key: 'gitPush' };
      if (sub === 'pull' || sub === 'fetch') return { key: 'gitPull' };
      if (sub === 'checkout' || sub === 'switch') return { key: 'gitSwitch' };
      return { key: 'gitChange' };
    }
    case 'gh': {
      const verb = (pos[1] || '').toLowerCase();
      return ['create', 'merge', 'close', 'edit', 'comment', 'delete', 'rerun', 'cancel', 'review'].includes(verb)
        ? { key: 'gitChange' } : { key: 'github' };
    }
    case 'npm': {
      const sub = (pos[0] || '').toLowerCase();
      if (!sub) return { key: 'install' };
      if (sub === 'test' || sub === 't') return { key: 'test' };
      if (['install', 'i', 'add', 'ci', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade'].includes(sub)) {
        return { key: 'install', x: cmdClip(pos.slice(1).join(' '), 30) };
      }
      if (sub === 'run' || sub === 'run-script') return cmdScript(pos.slice(1).join(' '));
      if (sub === 'exec' || sub === 'x' || sub === 'dlx') return classifyPiece(pos.slice(1));
      return cmdScript(pos.join(' '));     // `yarn build`, `npm start`
    }
    case 'npx':
      return classifyPiece(args.filter((w) => !/^-/.test(w)));
    case 'node': case 'python': case 'deno': case 'ruby': case 'php': case 'perl': {
      if (lower.some((w) => w === '-e' || w === '-c' || w === '--eval' || w === '-p')) return { key: 'quick' };
      if (prog === 'python' && lower[0] === '-m') {
        const mod = (args[1] || '').toLowerCase();
        if (mod === 'pytest' || mod === 'unittest') return { key: 'test' };
        if (mod === 'pip') return { key: 'install', x: cmdClip(pos.slice(2).join(' '), 30) };
        if (mod === 'http.server') return { key: 'start' };
        return { key: 'runFile', x: mod };
      }
      const file = pos[0];
      if (!file) return { key: 'quick' };
      return /test|spec/i.test(file) ? { key: 'test' } : { key: 'runFile', x: cmdClip(cmdBase(file), 36) };
    }
    case 'powershell': case 'bash': case 'sh': case 'cmd': case 'zsh': case 'wsl': {
      // A shell handed a command line: read that line instead.
      const inner = cmdFlag(args, '-command', '-c', '/c', '/k');
      if (inner) return describePieces(inner).main;
      const file = cmdFlag(args, '-file') || pos[0];
      return file ? { key: 'runFile', x: cmdClip(cmdBase(file), 36) } : { key: 'quick' };
    }
    case 'pytest': case 'jest': case 'vitest': case 'mocha': case 'ava': case 'tap': case 'playwright': case 'cypress':
      return { key: 'test' };
    case 'tsc': case 'eslint': case 'prettier': case 'biome': case 'ruff': case 'flake8': case 'mypy': case 'black':
    case 'clippy': case 'rustfmt': case 'gofmt': case 'stylelint':
      return { key: 'lint' };
    case 'cargo': case 'go': case 'dotnet': case 'swift': case 'zig': {
      const sub = (pos[0] || '').toLowerCase();
      if (sub === 'test' || sub === 'nextest') return { key: 'test' };
      if (sub === 'build' || sub === 'publish' || sub === 'pack') return { key: 'build' };
      if (sub === 'run' || sub === 'watch') return { key: 'start' };
      if (['check', 'clippy', 'fmt', 'vet', 'format', 'lint'].includes(sub)) return { key: 'lint' };
      if (['add', 'install', 'get', 'remove', 'restore', 'update', 'mod'].includes(sub)) return { key: 'install', x: cmdClip(pos.slice(1).join(' '), 30) };
      return { key: 'other', x: named };
    }
    case 'make': case 'cmake': case 'msbuild': case 'gradle': case 'mvn': case 'ninja': case 'webpack': case 'rollup': case 'esbuild':
      return /test/.test(lower.join(' ')) ? { key: 'test' } : { key: 'build' };
    case 'tauri': case 'vite': case 'next': case 'nuxt': case 'astro': case 'expo': {
      const sub = (pos[0] || '').toLowerCase();
      if (sub === 'build') return { key: 'build' };
      return { key: 'start' };
    }
    case 'pip': case 'pip3': case 'uv': case 'poetry': case 'conda': case 'winget': case 'choco': case 'scoop':
    case 'apt': case 'apt-get': case 'brew': case 'gem': case 'composer': case 'install-module': {
      const rest = pos.filter((w) => !['install', 'add', 'i', 'pip', 'upgrade', 'update', 'remove', 'uninstall'].includes(w.toLowerCase()));
      return { key: 'install', x: cmdClip(rest.join(' '), 30) };
    }
    case 'rm': case 'del': case 'erase': case 'rmdir': case 'rd': case 'remove-item': case 'ri': case 'unlink':
      return { key: 'delete', x: cmdFiles(pos) };
    case 'mv': case 'move': case 'move-item': case 'mi': case 'ren': case 'rename': case 'rename-item':
      return { key: 'move', x: cmdFiles(pos.slice(0, 1)) };
    case 'cp': case 'copy': case 'copy-item': case 'cpi': case 'xcopy': case 'robocopy':
      return { key: 'copy', x: cmdFiles(pos.slice(0, 1)) };
    case 'mkdir': case 'md': case 'new-item': case 'touch':
      return { key: 'create', x: cmdFiles([cmdFlag(args, '-path', '-name') || pos[0]].filter(Boolean)) };
    case 'set-content':
      return { key: 'write', x: cmdFiles([cmdFlag(args, '-path', '-filepath', '-literalpath') || pos[0]].filter(Boolean)) };
    case 'chmod': case 'chown': case 'icacls': case 'attrib':
      return { key: 'edit', x: cmdFiles(pos.slice(-1)) };
    case 'kill': case 'pkill': case 'killall': case 'taskkill': case 'stop-process': case 'spps':
      return { key: 'stop' };
    case 'start': case 'start-process': case 'saps': case 'explorer': case 'open': case 'xdg-open': case 'invoke-item': case 'ii':
      return { key: 'open', x: cmdFiles(pos.filter(Boolean).slice(0, 1)) };
    case 'curl': case 'wget': case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm': case 'http': {
      const url = cmdFlag(args, '-uri') || pos.find((w) => /^https?:\/\//i.test(w)) || pos[0] || '';
      const host = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
      return { key: 'fetch', x: cmdClip(host, 36) };
    }
    case 'sleep': case 'start-sleep':
      return { key: 'wait' };
    default:
      return { key: 'other', x: cmdClip(cmdBase(raw).replace(/\.(exe|cmd|bat|com)$/i, ''), 24) };
  }
}

// A redirect into a real file (`> notes.md`, `>> log.txt`) — not stderr, not
// the bit bucket.
function cmdRedirect(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^(\d?)(>>?)(.*)$/.exec(w);
    if (!m || m[1] === '2') continue;
    const target = m[3] || words[i + 1] || '';
    if (!target || /^&\d$/.test(target) || /^(\/dev\/null|nul|\$null)$/i.test(target)) continue;
    return target;
  }
  return null;
}

// The pieces of a command, read: `main` is the first one that does something
// (cd and echo only set the stage), `kind` the weightiest kind among them.
function describePieces(cmd) {
  const pieces = splitCommand(cmd).filter((p) => !p.piped);
  let main = null, rank = -1, kind = 'other';
  for (const p of pieces) {
    const words = commandWords(p.text);
    let c = classifyPiece(words);
    if (!c) continue;
    const target = cmdRedirect(words);
    // `cat > notes.md <<EOF`, `echo x > file`: the point is the file written.
    if (target && ['read', 'print'].includes(c.key)) c = { key: 'write', x: cmdFiles([target]) };
    let k = (CMD_KINDS[c.key] || CMD_KINDS.other)[0];
    if (target && k !== 'change') k = 'change';
    const noise = c.key === 'where' || c.key === 'print';
    if (!main || (main.noise && !noise)) main = Object.assign({ noise }, c);
    if (!noise && CMD_RANK[k] > rank) { rank = CMD_RANK[k]; kind = k; }
  }
  if (!main) main = { key: 'other', x: '' };
  if (rank < 0) kind = (CMD_KINDS[main.key] || CMD_KINDS.other)[0];
  return { main, kind };
}

// A command in plain words: { key, x, kind, icon }.
function describeCommand(cmd) {
  const { main, kind } = describePieces(cmd);
  return { key: main.key, x: main.x || '', kind, icon: (CMD_KINDS[main.key] || CMD_KINDS.other)[1] };
}

// The words for a reading. A label that names something has a `…0` twin for
// when there is nothing to name ("Read chat.css" / "Read a file").
function commandText(d) {
  const base = 'activity.cmd.' + d.key;
  return d.x ? tr(base, { x: d.x }) : tr(base + '0', null, tr(base));
}

// Did Claude say what this shell step is for? The backend falls back to the
// command's own first characters when it didn't — which is the case to read.
function hasOwnDescription(seg) {
  const t = String(seg.target || '').trim();
  return !!t && !String(seg.detail || '').trim().startsWith(t);
}

// How one step reads: { label, kind, icon }. The command's reading is cached on
// the entry (entries live as long as the chat is open); the words are not,
// since the language can change under them.
function activityInfo(a) {
  if (isAgentTool(a.name)) {
    return { label: a.detail || a.target || tr('activity.kindAgent'), kind: 'agent', icon: 'agent' };
  }
  const d = a._cmd || (a._cmd = describeCommand(a.detail || a.target || ''));
  return { label: hasOwnDescription(a) ? a.target : commandText(d), kind: d.kind, icon: d.icon };
}

/* The label an action chip in the transcript wears for a shell step: Claude's
 * own description, or the command read the same way the panel reads it. */
function shellStepLabel(seg) {
  if (hasOwnDescription(seg)) return seg.target;
  return seg.detail ? commandText(describeCommand(seg.detail)) : (seg.target || '');
}
