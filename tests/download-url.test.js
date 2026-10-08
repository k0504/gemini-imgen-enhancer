'use strict';
// The download rpc's answer, and the address the original is fetched from.
//
// `c8o8Fe` answers with a googleusercontent address. Before the October 2026
// Gemini update it was always `gg/<key>`; since then a token the server has to
// look up again answers `gg-dl/<key>` instead, after about ten seconds. Reading
// only the key out of the answer and re-seeding it under `gg/` turned every
// such answer into an http 400, which read as a dead token while the token
// was fine: the answered address itself, with `=s0`, serves the original
// (measured 2304x1856 and 1696x2528, one of them from a token held 30 days).
//
// Run: node tests/download-url.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BUILT = path.join(__dirname, '..', 'gemini-imgen-enhancer.user.js');
const source = fs.readFileSync(BUILT, 'utf8');

function extract(name) {
  const at = source.indexOf('\n  function ' + name + '(');
  if (at === -1) throw new Error('not found in the built script: ' + name);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return source.slice(at + 1, j + 1);
    }
  }
  throw new Error('unbalanced braces reading ' + name);
}

// originalOf is new; the build before it is still exercised through
// originalByToken, which is where the defect is observable.
const names = ['originalByToken', 'lhKey'];
if (source.indexOf('\n  function originalOf(') !== -1) names.push('originalOf');
if (source.indexOf('\n  function fetchOriginal(') !== -1) names.push('fetchOriginal');
function extractVar(name) {
  const at = source.indexOf('\n  var ' + name + ' =');
  if (at === -1) return '';
  return source.slice(at + 1, source.indexOf(';', at) + 1);
}
const body = extractVar('ORIGINAL_PREFIXES') + '\n' + names.map(extract).join('\n') + '\n; return { '
  + names.map((n) => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(', ') + ' };';

function harness(answer, got) {
  const log = { gets: [] };
  const api = new Function('DOWNLOAD_RPC', 'rpcPost', 'rpcUrl', 'gmGet', body)(
    'c8o8Fe',
    () => Promise.resolve(answer),
    () => '/rpc',
    (url, type) => { log.gets.push([url, type]); return got ? got(url) : Promise.resolve({ type: 'image/png' }); }
  );
  return { api, log };
}

const ROW = { token: '$tok', resp: 'r_0123456789abcdef', rc: 'rc_0123456789abcdef' };
const KEY = 'AHiVA1lNbeipLsiY58YZbSiMdXNubmfONnaoYhLAjP4My3ZWcmTSoMY7rgbY2jTSe1HQSw6E2';

(async () => {
  // The answer the server gives a held token today: a gg-dl address.
  {
    const { api } = harness(['https://lh3.googleusercontent.com/gg-dl/' + KEY]);
    const url = await api.originalByToken(ROW, '0123456789abcdef');
    assert.strictEqual(url, 'https://lh3.googleusercontent.com/gg-dl/' + KEY + '=s0',
      'a gg-dl answer is fetched at its own address with =s0, not re-seeded under gg/');
  }

  // The answer for a token minted moments ago: the gg address, any suffix dropped.
  {
    const { api } = harness(['https://lh3.googleusercontent.com/gg/' + KEY + '=w400']);
    const url = await api.originalByToken(ROW, '0123456789abcdef');
    assert.strictEqual(url, 'https://lh3.googleusercontent.com/gg/' + KEY + '=s0',
      'a gg answer is fetched at its own address with =s0');
  }

  // Anything else is an answer this code does not know, said with what it was.
  {
    const { api } = harness(['https://lh3.googleusercontent.com/other/' + KEY]);
    await assert.rejects(api.originalByToken(ROW, '0123456789abcdef'),
      (err) => /other\//.test(err.message),
      'an unknown address form is refused and named');
    const none = harness([null]);
    await assert.rejects(none.api.originalByToken(ROW, '0123456789abcdef'),
      /named no image/, 'an answer with no address is refused');
  }

  // The fetch takes what the address serves, and refuses anything not an image.
  {
    const { api, log } = harness(null, () => Promise.resolve({ type: 'image/png' }));
    assert.ok(api.fetchOriginal, 'fetchOriginal exists');
    const blob = await api.fetchOriginal('https://lh3.googleusercontent.com/gg-dl/K=s0');
    assert.strictEqual(blob.type, 'image/png');
    assert.deepStrictEqual(log.gets, [['https://lh3.googleusercontent.com/gg-dl/K=s0', 'blob']],
      'one request, at the address as given');
    const text = harness(null, () => Promise.resolve({ type: 'text/plain' }));
    await assert.rejects(text.api.fetchOriginal('https://lh3.googleusercontent.com/gg-dl/K=s0'),
      /text\/plain/, 'a body that is not an image is refused and its type named');
  }

  console.log('ok  the download rpc answer is fetched at its own address, gg and gg-dl alike');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
