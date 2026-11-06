/* The whole frontend loads: every script index.html names, in its order, run
 * in one shared scope as the WebView would. The scripts share one global scope
 * and run top to bottom, so a file moved, split or reordered can leave a
 * top-level statement reaching for something that isn't declared yet — a
 * ReferenceError at boot, which no per-module test would see.
 *
 * It also checks the wiring around that: every file in src/app/ and src/css/
 * is linked exactly once, and the stylesheets start with base.css and end with
 * motion.css (their link order is the cascade).
 *
 * The DOM, Tauri and storage are a catch-all stub: any property is another
 * stub, any call returns one, and none of them ever resolves. That's enough
 * for the load-time code to run; it says nothing about behaviour.
 *
 * Run: node tests/boot.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'src');

/* A value that is anything you ask it to be. */
function stub(name = 'stub') {
  const fn = function () {};
  return new Proxy(fn, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* () {};
      if (key === 'then') return () => stub(name + '.then()');   // a promise that never settles
      if (key === 'length') return 0;
      if (key === 'toString' || key === 'valueOf') return () => '';
      return stub(name + '.' + String(key));
    },
    set() { return true; },
    has() { return true; },
    apply() { return stub(name + '()'); },
    construct() { return stub('new ' + name); },
  });
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const ours = scripts.filter((s) => !s.startsWith('vendor/'));
const sheets = [...html.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)"/g)].map((m) => m[1]);

const errors = [];

// A file nobody links does nothing, silently; one linked twice runs twice.
function linkedOnce(dir, linked) {
  const onDisk = fs.readdirSync(path.join(root, dir)).filter((f) => /\.(js|css)$/.test(f)).map((f) => dir + '/' + f);
  const missing = onDisk.filter((f) => !linked.includes(f));
  const twice = linked.filter((f, i) => linked.indexOf(f) !== i);
  const gone = linked.filter((f) => f.startsWith(dir + '/') && !onDisk.includes(f));
  if (missing.length) errors.push(`link: not linked in index.html: ${missing.join(', ')}`);
  if (twice.length) errors.push(`link: linked twice in index.html: ${twice.join(', ')}`);
  if (gone.length) errors.push(`link: index.html links a missing file: ${gone.join(', ')}`);
}
linkedOnce('app', ours);
linkedOnce('css', sheets);
// base.css sets the variables everything reads; motion.css layers over it all.
if (sheets[0] !== 'css/base.css' || sheets[sheets.length - 1] !== 'css/motion.css') {
  errors.push('link: css/base.css must be linked first and css/motion.css last');
}
/* A fresh global scope; `web` puts the web host in it instead of Tauri. */
function makeSandbox(web) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask() {},
    Promise, Map, Set, WeakMap, WeakSet, JSON, Math, Date, RegExp, Error, TypeError,
    Number, String, Boolean, Array, Object, Symbol, Proxy, Reflect, Intl,
    URL, URLSearchParams, TextDecoder, TextEncoder, encodeURIComponent, decodeURIComponent,
    parseInt, parseFloat, isNaN, isFinite, structuredClone,
    // A store that really stores, so code that reads back what it wrote works.
    localStorage: (() => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
    })(),
  };
  for (const name of ['document', 'navigator', 'location', 'matchMedia', 'getComputedStyle',
    'CustomEvent', 'Event', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver',
    'IntersectionObserver', 'HTMLElement', 'Element', 'Node', 'Image', 'Audio', 'fetch',
    'Blob', 'FileReader', 'DOMParser', 'CSS', 'performance', 'history', 'screen',
    'marked', 'DOMPurify', 'hljs', 'Notification']) {
    sandbox[name] = stub(name);
  }
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'postMessage',
    'scrollTo', 'open', 'close', 'focus', 'blur', 'getSelection', 'alert', 'confirm', 'prompt']) {
    sandbox[name] = stub(name);
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  if (web) {
    // app.krystal.rip: no Tauri at all, the web host's handles instead
    // (krystal-cloud web/desk-host.js). Anything that reaches for __TAURI__ at
    // load without checking for it first fails here.
    sandbox.KRYSTAL_HOST = {
      invoke: stub('host.invoke'), Channel: stub('host.Channel'), listen: stub('host.listen'),
      dialog: stub('host.dialog'), caps: { native: false, web: true, maxUpload: 6 * 1024 * 1024 },
    };
  } else {
    sandbox.__TAURI__ = stub('__TAURI__');
  }
  vm.createContext(sandbox);
  return sandbox;
}

process.on('unhandledRejection', (e) => errors.push('async: ' + (e && e.stack || e)));

// Load every script under one host. Everything in the sandbox is a stub that
// answers any read, so under the web host the one thing that can be undefined
// is `__TAURI__` — a "reading of undefined" there is a script reaching for
// Tauri at load without checking it is there, and counts as real.
function loadAll(web) {
  const sandbox = makeSandbox(web);
  const tag = web ? 'web host: ' : '';
  for (const s of ours) {
    try {
      vm.runInContext(fs.readFileSync(path.join(root, s), 'utf8'), sandbox, { filename: s });
    } catch (e) {
      const msg = String(e && e.message);
      const tauri = web && /of undefined|__TAURI__/.test(msg);
      errors.push(`${tag}${s}: ${tauri ? 'TAURI ' : ''}${msg}`);
    }
  }
}
loadAll(false);
loadAll(true);

// Let anything scheduled as a microtask at load run before judging.
setImmediate(() => {
  // Only a missing or not-yet-declared name is a load-order bug (and, under the
  // web host, a read through the missing __TAURI__); anything else is the stub
  // not being a real DOM.
  const real = errors.filter((e) => /^link:|ReferenceError|is not defined|before initialization|TAURI /.test(e));
  if (real.length) {
    console.log('FAIL the frontend does not load cleanly:\n  ' + real.join('\n  '));
    process.exit(1);
  }
  console.log(`boot.test.js: ok (${ours.length} scripts load in index.html order, under Tauri and the web host; ${sheets.length} stylesheets linked)`);
});
