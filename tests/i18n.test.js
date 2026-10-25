/* Both languages say everything: every string the app shows exists in EN and
 * HR, with the same {placeholders}, and none is left empty (src/i18n.js).
 *
 * Run: node tests/i18n.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');

/* src/i18n.js runs against a stub DOM and leaves its tables on window.I18N —
 * but those are private, so read the `dict` literal straight out of the file. */
function objectLiteralAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `can't find "${marker}"`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      return vm.runInNewContext('(' + src.slice(open, i + 1) + ')');
    }
  }
  throw new Error('unbalanced literal after ' + marker);
}

/* { a: 'x', b: { c: 'y' } } → { a: 'x', 'b.c': 'y' } */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flatten(v, prefix + k + '.', out);
    else out[prefix + k] = v;
  }
  return out;
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

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

function checkDictionary(label, dict) {
  const en = flatten(dict.en);
  const hr = flatten(dict.hr);

  check(`${label}: the dictionary is not empty`, () => {
    assert.ok(Object.keys(en).length > 20, `only ${Object.keys(en).length} EN strings found`);
  });

  check(`${label}: every EN string has an HR one, and the other way round`, () => {
    const missingHr = Object.keys(en).filter((k) => !(k in hr));
    const missingEn = Object.keys(hr).filter((k) => !(k in en));
    assert.deepStrictEqual({ missingHr, missingEn }, { missingHr: [], missingEn: [] });
  });

  check(`${label}: both languages fill the same {placeholders}`, () => {
    const differ = Object.keys(en)
      .filter((k) => k in hr && placeholders(en[k]).join() !== placeholders(hr[k]).join())
      .map((k) => `${k}: EN {${placeholders(en[k])}} vs HR {${placeholders(hr[k])}}`);
    assert.deepStrictEqual(differ, []);
  });

  check(`${label}: no string is empty`, () => {
    const empty = [
      ...Object.keys(en).filter((k) => !String(en[k]).trim()).map((k) => 'en ' + k),
      ...Object.keys(hr).filter((k) => !String(hr[k]).trim()).map((k) => 'hr ' + k),
    ];
    assert.deepStrictEqual(empty, []);
  });
}

checkDictionary('desktop', objectLiteralAfter(
  fs.readFileSync(path.join(root, 'src', 'i18n.js'), 'utf8'), 'const dict ='));

if (failures) {
  console.log(`\n${failures} i18n check(s) failed`);
  process.exit(1);
}
console.log('\nall i18n tests passed');
