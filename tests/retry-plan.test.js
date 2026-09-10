'use strict';
// The retry of an older turn: what it waits for, and what it sends.
//
// A retry changes no image. It goes out with the list the message already
// holds, which the server still honours, and re-uploading those images to send
// a converted shape instead was measured at 78.2s against 6.3s. That is now
// the rule for every edit resend, not a branch of its own: an existing entry is
// re-uploaded only when its reference is a contrib the server no longer
// honours, so a retry of a record of server references is ready the moment it
// is made, and one whose record holds dead contribs waits like any other plan.
//
// Run: node tests/retry-plan.test.js

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

const state = { refusals: [] };
const names = ['planIsReady', 'isEditResend', 'applyPlanTo', 'settleExisting', 'attReusable'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';
const api = new Function('PROMPT_TUPLE', 'ATTACHMENTS', 'ACTION_INDEX', 'ACTION_EDIT_RESEND',
  'attClass', 'dbg', 'attShape', 'refuseSend', 'say', 'LOG_IMG', body)(
    0, 3, 72, 2,
    (att) => (Array.isArray(att) && att[0] && typeof att[0][0] === 'string'
      && att[0][0].indexOf('/contrib_service/') === 0
      ? (att.__stale ? 'contrib-stale' : 'contrib-live')
      : (Array.isArray(att) && att.length >= 3 && typeof att[2] === 'string' ? 'token' : 'other')),
    function () { },
    (list) => (Array.isArray(list) ? list.map((a) => a[1]).join(', ') : String(list)),
    function (why) { state.refusals.push(why); return null; },
    function () { }, '[gpie]');

function token(name) {
  return [[null, 1, 1, 'image/jpeg'], name, '$AXzLiR' + name];
}

function stale(name) {
  const t = [['/contrib_service/ttl_1d/' + name, 1, null, 'image/jpeg'], name];
  t.__stale = true;
  return t;
}

// A plan as makePlan leaves one for a retry: entries positional and untouched,
// base the record's own list, settled once so each entry knows whether it goes
// out as it stands.
function retryPlan(base, opts) {
  const p = Object.assign({
    index: 0,
    retry: true,
    blocked: null,
    base: base,
    originalCount: base.length,
    entries: base.map((_, i) => ({ kind: 'existing', index: i }))
  }, opts || {});
  api.settleExisting(p);
  return p;
}

function send(names) {
  const inner = new Array(97).fill(null);
  inner[0] = ['prompt text', 0, null, names.map(token), null, null, 0, null, null, []];
  inner[72] = 2;
  return inner;
}

let failures = 0;
function it(what, fn) {
  state.refusals = [];
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

console.log('retry plan');

it('a retry is ready the moment it is made, with nothing uploaded', function () {
  assert.strictEqual(api.planIsReady(retryPlan([token('a.jpg'), token('b.jpg')])), true,
    'every entry holds a reference the server honours, and none needs an upload');
});

it('a retry whose record holds a dead contrib waits like any other plan', function () {
  const p = retryPlan([stale('a.jpg')]);
  assert.strictEqual(api.planIsReady(p), false, 'the upload has not finished');
  p.entries[0].freshAttachment = token('a.jpg');
  assert.strictEqual(api.planIsReady(p), true, 'and it has now');
});

it('a blocked retry is never ready', function () {
  assert.strictEqual(
    api.planIsReady(retryPlan([token('a.jpg')], { blocked: 'its record could not be stored' })),
    false, 'a record in doubt is not answered by there being nothing to wait for');
});

it('an ordinary edit waits on the same rule', function () {
  const p = retryPlan([stale('a.jpg')], { retry: false });
  assert.strictEqual(api.planIsReady(p), false,
    'an entry whose reference is dead has nothing to be written from until its upload lands');
  assert.strictEqual(api.planIsReady(retryPlan([token('a.jpg')], { retry: false })), true,
    'and one the server honours is ready as it stands, retry or not');
});

it('a retry sends the list the message already holds', function () {
  const base = [token('a.jpg'), token('b.jpg')];
  const inner = send(['a.jpg', 'b.jpg']);
  assert.strictEqual(api.applyPlanTo(inner, retryPlan(base)), true);
  assert.deepStrictEqual(inner[0][3], base, 'the record\'s own references, unconverted');
  assert.strictEqual(inner[0][3][0].length, 3, 'a server reference keeps its three elements');
  assert.strictEqual(inner[72], 2, 'and the send stays the edit resend it is');
  assert.deepStrictEqual(state.refusals, []);
});

it('a retry refuses when the record and the message disagree on how many', function () {
  const p = retryPlan([token('a.jpg')]);
  p.originalCount = 2;
  assert.strictEqual(api.applyPlanTo(send(['a.jpg', 'b.jpg']), p), false);
  assert.strictEqual(state.refusals.length, 1, 'the send is refused');
  assert.ok(/holds 1 attachments against the 2/.test(state.refusals[0]),
    'the refusal names both counts: ' + state.refusals[0]);
});

it('a retry leaves a send that is not the resend alone', function () {
  const inner = send(['a.jpg']);
  inner[72] = null;
  assert.strictEqual(api.applyPlanTo(inner, retryPlan([token('a.jpg')])), null,
    'null is "not this plan\'s send", which is not a refusal');
  assert.deepStrictEqual(state.refusals, []);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
