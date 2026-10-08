'use strict';
// A StreamGenerate the server refuses answers http 200 with BardErrorInfo in
// its second envelope. Since edit resends rewritten by this script began to be
// answered with code 1155, every such answer is said at error level and both
// bodies - the one the page built, the one that went out - are kept in
// localStorage for comparison. See §bodies and §net in the built script.
//
// Run: node tests/bard-error.test.js

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

// The constants are read off the built script too, so the bounds tested are
// the shipped ones.
function constant(name) {
  const m = new RegExp('\\n  var ' + name + ' = ([^;]+);').exec(source);
  if (!m) throw new Error('constant not found in the built script: ' + name);
  return m[1];
}

const store = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }
};
const said = [];

const names = ['reportBardError', 'bardErrorCode', 'bodyDiff', 'keepErrorBody'];
const consts = ['ERR_KEEP', 'ERR_KEEP_ENTRIES', 'ERR_KEEP_CHARS', 'ERR_BODY_CHARS',
  'DIFF_DEPTH', 'DIFF_LINES'];
const body = consts.map((c) => 'var ' + c + ' = ' + constant(c) + ';').join('\n') + '\n'
  + names.map(extract).join('\n')
  + '\n; return { ' + names.concat(consts).join(', ') + ' };';
const api = new Function('localStorage', 'say', 'LOG_IMG', 'stamp', 'VERSION', body)(
  localStorage,
  function (level) { said.push({ level: level, text: Array.prototype.slice.call(arguments, 1).join(' ') }); },
  '[gpie]',
  () => '12:34:56.789',
  'test');

// The 351-character answer the trace recorded, with its turn id shortened.
const REFUSED = '[["wrb.fr",null,"[null,[null,\\"r_0123abcd\\"],{\\"21\\":[],\\"44\\":true}]"]]\n'
  + '[["wrb.fr",null,null,null,null,[13,null,[["type.googleapis.com/assistant.boq.bard.'
  + 'application.BardErrorInfo",[1155]]]]]]';
const ANSWERED = '[["wrb.fr",null,"[null,[\\"c_1\\",\\"r_2\\"],null,[[\\"rc_3\\",[\\"a picture\\"]]]]"]]';

function streamBody(tokens, pro) {
  const inner = new Array(97).fill(null);
  inner[0] = ['prompt', 0, null, tokens.map((t, i) => [[null, 1, 1, 'image/png'], 'f' + i + '.png', t]),
    null, null, 0, null, null, [null, null, null, null, null, null, [null, [pro ? 1 : 0]]]];
  inner[2] = ['c_00112233445566778899aabbccddeeff', '', ''];
  inner[72] = 2;
  const params = new URLSearchParams();
  params.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  params.set('at', 'csrf');
  return params.toString();
}

function reset() {
  Object.keys(store).forEach((k) => { delete store[k]; });
  said.length = 0;
}

function kept() {
  return JSON.parse(localStorage.getItem(api.ERR_KEEP) || '[]');
}

let failures = 0;
function it(what, fn) {
  reset();
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

console.log('BardErrorInfo on StreamGenerate');

it('a 1155 answer is said at error level, naming the code, the message and the conversation', function () {
  const page = streamBody(['$PAGE-0', '$PAGE-1'], false);
  const sent = streamBody(['$RECORD-0', '$PAGE-1'], true);
  assert.strictEqual(api.reportBardError(REFUSED,
    { body: sent, page: page, target: 0, conv: 'c_00112233445566778899aabbccddeeff' }), true);
  const errors = said.filter((s) => s.level === 'error');
  assert.strictEqual(errors.length, 1);
  assert.ok(/BardErrorInfo 1155/.test(errors[0].text), errors[0].text);
  assert.ok(/message #0/.test(errors[0].text), errors[0].text);
  assert.ok(/c_00112233445566778899aabbccddeeff/.test(errors[0].text), errors[0].text);
  assert.ok(/rewrote the request/.test(errors[0].text), errors[0].text);
});

it('both bodies are kept, with the fields that differ between them', function () {
  const page = streamBody(['$PAGE-0', '$PAGE-1'], false);
  const sent = streamBody(['$RECORD-0', '$PAGE-1'], true);
  api.reportBardError(REFUSED, { body: sent, page: page, target: 0, conv: 'c_1' });
  const entries = kept();
  assert.strictEqual(entries.length, 1);
  const entry = entries[0];
  assert.strictEqual(entry.code, '1155');
  assert.strictEqual(entry.index, 0);
  assert.strictEqual(entry.at, '12:34:56.789');
  assert.strictEqual(entry.page, page, 'the body the page built');
  assert.strictEqual(entry.sent, sent, 'the body that went out');
  const fields = entry.diff.map((line) => line.split(':')[0]);
  assert.deepStrictEqual(fields, ['inner[0][3][0][2]', 'inner[0][9][6][1]'],
    'the token and the model switch, and nothing else: ' + entry.diff.join(' | '));
});

it('a send the script left alone is said as such, and kept all the same', function () {
  const page = streamBody(['$PAGE-0'], false);
  api.reportBardError(REFUSED, { body: page, page: page, target: null, conv: null });
  assert.ok(/as the page built it/.test(said[0].text), said[0].text);
  assert.strictEqual(kept()[0].diff.length, 0);
});

it('an ordinary answer says nothing and keeps nothing', function () {
  const page = streamBody(['$PAGE-0'], false);
  assert.strictEqual(api.reportBardError(ANSWERED,
    { body: streamBody(['$RECORD-0'], true), page: page, target: 0, conv: 'c_1' }), false);
  assert.deepStrictEqual(said, []);
  assert.strictEqual(localStorage.getItem(api.ERR_KEEP), null);
});

it('only the newest entries are kept, and the store stays inside its cap', function () {
  const big = 'x'.repeat(api.ERR_BODY_CHARS + 500);
  for (let i = 0; i < api.ERR_KEEP_ENTRIES + 3; i++) {
    api.keepErrorBody({ at: 'n' + i, code: '1155', page: big, sent: big, diff: [] });
  }
  const entries = kept();
  assert.ok(entries.length <= api.ERR_KEEP_ENTRIES, entries.length + ' entries kept');
  assert.strictEqual(entries[entries.length - 1].at, 'n' + (api.ERR_KEEP_ENTRIES + 2),
    'the newest survives');
  assert.ok(localStorage.getItem(api.ERR_KEEP).length <= api.ERR_KEEP_CHARS,
    'stored ' + localStorage.getItem(api.ERR_KEEP).length + ' chars');
  assert.strictEqual(entries[0].page.length, api.ERR_BODY_CHARS, 'an oversized body is cut');
  assert.strictEqual(entries[0].pageLength, api.ERR_BODY_CHARS + 500, 'and says how long it was');
});

it('bardErrorCode reads the code wherever the error info is unescaped', function () {
  assert.strictEqual(api.bardErrorCode(REFUSED), '1155');
  assert.strictEqual(api.bardErrorCode('[["wrb.fr","c8o8Fe",null,null,null,[3,null,'
    + '[["x.BardErrorInfo",[1003]]]],"generic"]'), '1003');
  assert.strictEqual(api.bardErrorCode(ANSWERED), null);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exit(failures ? 1 : 0);
