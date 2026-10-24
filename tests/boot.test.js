/* The whole frontend loads: every script index.html names, in its order, run
 * in one shared scope as the WebView would. The scripts share one global scope
 * and run top to bottom, so a file moved, split or reordered can leave a
 * top-level statement reaching for something that isn't declared yet — a
 * ReferenceError at boot, which no per-module test would see.
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

const scripts = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const ours = scripts.filter((s) => !s.startsWith('vendor/'));

const errors = [];
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
sandbox.__TAURI__ = stub('__TAURI__');
vm.createContext(sandbox);

process.on('unhandledRejection', (e) => errors.push('async: ' + (e && e.stack || e)));

for (const s of ours) {
  try {
    vm.runInContext(fs.readFileSync(path.join(root, s), 'utf8'), sandbox, { filename: s });
  } catch (e) {
    errors.push(`${s}: ${e && e.message}`);
  }
}

// Let anything scheduled as a microtask at load run before judging.
setImmediate(() => {
  // Only a missing or not-yet-declared name is a load-order bug; anything else
  // is the stub not being a real DOM.
  const real = errors.filter((e) => /ReferenceError|is not defined|before initialization/.test(e));
  if (real.length) {
    console.log('FAIL the frontend does not load cleanly:\n  ' + real.join('\n  '));
    process.exit(1);
  }
  console.log(`boot.test.js: ok (${ours.length} scripts load in index.html order)`);
});
