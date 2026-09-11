'use strict';
// The recent-generations buffer: the original key of each generated image,
// resolved the moment the generation lands and kept apart from the ledger.
//
// The ledger drops a turn's rows as soon as the library listing stops naming
// it, which is the very moment a lost image is noticed. This buffer is what
// answers after that: a small ring in localStorage holding the `gg/<key>` the
// download rpc gave for each of the last few generations. Recovery walks the
// download chain from that key and asks the server nothing else - which is
// also the experiment: a key that still serves says the file outlived its
// links, a 404 says it did not.
//
// Run: node tests/recent-generations.test.js

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

const names = ['recentPush', 'recentRowsFrom', 'resolveRecent', 'rememberRecent',
  'recoverRecent', 'readRecent', 'writeRecent'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';

function harness(stubs) {
  const store = {};
  const log = { said: [], info: [], dbg: [], saved: [], chains: [], rpc: [], menus: 0 };
  const api = new Function(
    'RECENT_STORE', 'RECENT_KEEP', 'localStorage', 'tokenEntries', 'conversationIn',
    'originalByToken', 'followChain', 'seedUrl', 'saveBlob', 'saveName', 'say', 'info', 'dbg',
    'progress', 'renderMenu', 'LOG_IMG', 'Date',
    body)(
    'gpieRecent', 3,
    {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    stubs.tokenEntries || (() => []),
    stubs.conversationIn || (() => null),
    stubs.originalByToken || (() => Promise.reject(new Error('no rpc in this test'))),
    stubs.followChain || ((url) => { log.chains.push(url); return Promise.resolve({ type: 'image/jpeg' }); }),
    (key) => 'seed:' + key,
    (blob, name) => { log.saved.push(name); },
    (id, type) => 'gemini-' + id.slice(-12).replace(/[^A-Za-z0-9]/g, '') + '.' + (/jpeg/.test(type) ? 'jpg' : 'img'),
    (level, tag, ...rest) => { log.said.push([level, rest.join(' ')]); },
    (...rest) => { log.info.push(rest.join(' ')); },
    (...rest) => { log.dbg.push(rest.join(' ')); },
    () => { },
    () => { log.menus++; },
    '[gpie]',
    { now: () => 1000 }
  );
  return { api, store, log };
}

// --- the ring ---------------------------------------------------------------

{
  const { api } = harness({});
  const e = (key, resp) => ({ key, resp, slot: 0, conv: 'c', at: 1 });
  let list = [];
  list = api.recentPush(list, e('K1', 'r_1'), 3);
  list = api.recentPush(list, e('K2', 'r_2'), 3);
  list = api.recentPush(list, e('K3', 'r_3'), 3);
  assert.deepStrictEqual(list.map((x) => x.key), ['K3', 'K2', 'K1'], 'newest first');
  list = api.recentPush(list, e('K4', 'r_4'), 3);
  assert.deepStrictEqual(list.map((x) => x.key), ['K4', 'K3', 'K2'], 'the oldest falls off at the cap');
  list = api.recentPush(list, e('K3', 'r_3'), 3);
  assert.deepStrictEqual(list.map((x) => x.key), ['K3', 'K4', 'K2'],
    'a key already held moves to the front rather than appearing twice');
  const same = api.recentPush(list, { key: 'K9', resp: 'r_4', slot: 0, conv: 'c', at: 2 }, 3);
  assert.deepStrictEqual(same.map((x) => x.key), ['K9', 'K3', 'K2'],
    'a new key for the same turn and slot replaces the old one');
  console.log('ok  recentPush keeps the newest few, one per key and per image');
}

// --- reading the generation answer ------------------------------------------

{
  // A generation streams in chunks and the image node is repeated across them;
  // one chunk names no conversation and contributes nothing.
  const chunkA = { id: 'A' };
  const chunkB = { id: 'B' };
  const chunkC = { id: 'C' };
  const rows = {
    A: [{ token: '$small', resp: 'r_aa', rc: 'rc_aa', slot: 0, bytes: 100 }],
    B: [{ token: '$small', resp: 'r_aa', rc: 'rc_aa', slot: 0, bytes: 100 },
      { token: '$big', resp: 'r_aa', rc: 'rc_aa', slot: 0, bytes: 900 }],
    C: [{ token: '$lost', resp: 'r_cc', rc: 'rc_cc', slot: 0, bytes: 500 }]
  };
  const { api } = harness({
    tokenEntries: (chunk) => rows[chunk.id],
    conversationIn: (chunk) => (chunk.id === 'C' ? null : 'conv1')
  });
  const turns = api.recentRowsFrom([chunkA, chunkB, chunkC]);
  assert.strictEqual(turns.length, 1, 'one turn, the chunk without a conversation dropped');
  assert.strictEqual(turns[0].resp, 'r_aa');
  assert.strictEqual(turns[0].conv, 'conv1');
  assert.deepStrictEqual(turns[0].rows.map((r) => r.token), ['$big', '$small'],
    'one row per token, the one declaring the most bytes first');
  console.log('ok  recentRowsFrom reads one turn out of the chunks, largest token first');
}

// --- resolving on landing ---------------------------------------------------

(async () => {
  const asked = [];
  const { api, store, log } = harness({
    tokenEntries: () => [
      { token: '$preview', resp: 'r_11', rc: 'rc_11', slot: 0, bytes: 100 },
      { token: '$orig', resp: 'r_11', rc: 'rc_11', slot: 0, bytes: 900 }
    ],
    conversationIn: () => 'conv1',
    originalByToken: (row, conv) => {
      asked.push(row.token + '@' + conv);
      return row.token === '$orig' ? Promise.resolve('KEY_ORIG')
        : Promise.reject(new Error('the download rpc named no image'));
    }
  });
  await api.rememberRecent([{}]);
  assert.deepStrictEqual(asked, ['$orig@conv1'],
    'the largest token is asked first and answers, so the other is never asked');
  const kept = JSON.parse(store.gpieRecent);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].key, 'KEY_ORIG');
  assert.strictEqual(kept[0].resp, 'r_11');
  assert.strictEqual(kept[0].conv, 'conv1');
  assert.strictEqual(kept[0].at, 1000);
  assert.strictEqual(log.menus, 1, 'the menu caption is redrawn with the new count');
  assert.ok(log.info.some((l) => /recent: kept the original key/.test(l)), 'one info line per landing');

  // The other order: the first token asked is refused, the next answers.
  const asked2 = [];
  const h2 = harness({
    tokenEntries: () => [
      { token: '$a', resp: 'r_22', rc: 'rc_22', slot: 0, bytes: 900 },
      { token: '$b', resp: 'r_22', rc: 'rc_22', slot: 0, bytes: 900 }
    ],
    conversationIn: () => 'conv2',
    originalByToken: (row) => {
      asked2.push(row.token);
      return row.token === '$b' ? Promise.resolve('KEY_B') : Promise.reject(new Error('BardErrorInfo [1003]'));
    }
  });
  await h2.api.rememberRecent([{}]);
  assert.deepStrictEqual(asked2, ['$a', '$b']);
  assert.strictEqual(JSON.parse(h2.store.gpieRecent)[0].key, 'KEY_B');

  // Every token refused: nothing is written and the failure is said, not swallowed.
  const h3 = harness({
    tokenEntries: () => [{ token: '$x', resp: 'r_33', rc: 'rc_33', slot: 0, bytes: 1 }],
    conversationIn: () => 'conv3',
    originalByToken: () => Promise.reject(new Error('BardErrorInfo [1003]'))
  });
  await h3.api.rememberRecent([{}]);
  assert.strictEqual(h3.store.gpieRecent, undefined, 'nothing kept when no key was answered');
  assert.ok(h3.log.said.some((s) => s[0] === 'warn' && /r_33/.test(s[1])), 'the refusal names the turn');

  // No image in the answer: a text turn contributes nothing and asks nothing.
  const h4 = harness({ tokenEntries: () => [], conversationIn: () => 'conv4' });
  await h4.api.rememberRecent([{}]);
  assert.strictEqual(h4.store.gpieRecent, undefined);
  assert.strictEqual(h4.log.said.length, 0);
  console.log('ok  rememberRecent resolves the key on landing and keeps it');

  // --- recovery -------------------------------------------------------------

  const h5 = harness({});
  h5.api.writeRecent([
    { key: 'KEY_NEW', resp: 'r_new', slot: 0, conv: 'c', at: 2 },
    { key: 'KEY_OLD', resp: 'r_old', slot: 1, conv: 'c', at: 1 }
  ]);
  await h5.api.recoverRecent();
  assert.deepStrictEqual(h5.log.chains, ['seed:KEY_NEW', 'seed:KEY_OLD'],
    'each held key is walked from its seed, newest first, and nothing is asked of the rpc');
  assert.deepStrictEqual(h5.log.saved, ['gemini-rnew0.jpg', 'gemini-rold1.jpg']);

  // A key the chain refuses is reported with its status and the rest still run.
  const h6 = harness({
    followChain: (url) => (url === 'seed:GONE'
      ? Promise.reject(new Error('http 404'))
      : Promise.resolve({ type: 'image/jpeg' }))
  });
  h6.api.writeRecent([
    { key: 'GONE', resp: 'r_gone', slot: 0, conv: 'c', at: 2 },
    { key: 'HERE', resp: 'r_here', slot: 0, conv: 'c', at: 1 }
  ]);
  await h6.api.recoverRecent();
  assert.deepStrictEqual(h6.log.saved, ['gemini-rhere0.jpg']);
  assert.ok(h6.log.said.some((s) => s[0] === 'error' && /r_gone/.test(s[1]) && /http 404/.test(s[1])),
    'the refused key is named with the status the chain answered');

  // Nothing on record is said, not silently nothing.
  const h7 = harness({});
  await h7.api.recoverRecent();
  assert.ok(h7.log.said.some((s) => s[0] === 'warn' && /nothing on record/.test(s[1])));
  console.log('ok  recoverRecent walks each held key and reports the ones that no longer serve');

  // --- the store survives bad content ----------------------------------------
  const h8 = harness({});
  h8.store.gpieRecent = '{not json';
  assert.deepStrictEqual(h8.api.readRecent(), [], 'unreadable content reads as empty');
  assert.ok(h8.log.said.some((s) => s[0] === 'warn'), 'and is said');
  console.log('ok  readRecent survives a corrupt store');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
