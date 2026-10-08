'use strict';
// Whose references an edit resend carries: the page's own, whenever the list
// the page built already carries the record's attachments.
//
// The record's tokens and the page's name the same files but are not the same
// strings. hNvQHb issues a fresh token on every answer, so a record that
// §refresh upgraded holds values the page never sent. Writing those over a list
// the page had already built for the same attachments changed nothing the plan
// asked for and replaced every token value in the request; edit resends that
// went out that way were answered with BardErrorInfo 1155 where the same edit
// sent natively was not. The page's references therefore go out untouched when
// its list carries the record's file names in the record's order, and the
// script writes a list only when the plan asks for something that list does
// not hold.
//
// Run: node tests/page-references.test.js

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
const names = ['isEditResend', 'applyPlanTo', 'settleExisting', 'attReusable',
  'whyPageListDiffers', 'namesShadowPage'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';
const api = new Function('PROMPT_TUPLE', 'ATTACHMENTS', 'ACTION_INDEX', 'ACTION_EDIT_RESEND',
  'attClass', 'dbg', 'attShape', 'refuseSend', body)(
    0, 3, 72, 2,
    (att) => (Array.isArray(att) && att[0] && typeof att[0][0] === 'string'
      && att[0][0].indexOf('/contrib_service/') === 0
      ? (att.__stale ? 'contrib-stale' : 'contrib-live')
      : (Array.isArray(att) && att.length >= 3 && typeof att[2] === 'string' ? 'token' : 'other')),
    function () { },
    (list) => (Array.isArray(list) ? list.map((a) => a[1]).join(', ') : String(list)),
    function (why) { state.refusals.push(why); return null; });

// The same file under two issuances: what the page built the request with, and
// what the record holds after §refresh asked hNvQHb on its own.
function pageToken(name) {
  return [[null, 1, 1, 'image/jpeg'], name, '$PAGE-' + name];
}

function recordToken(name) {
  return [[null, 1, 1, 'image/jpeg'], name, '$RECORD-' + name];
}

function contrib(name) {
  return [['/contrib_service/ttl_1d/' + name, 1, null, 'image/jpeg'], name];
}

function stale(name) {
  const t = contrib(name);
  t.__stale = true;
  return t;
}

function editResend(attachments) {
  const inner = new Array(97).fill(null);
  inner[0] = ['prompt text', 0, null, attachments, null, null, 0, null, null, []];
  inner[2] = ['c_00112233445566778899aabbccddeeff', '', '', null, null, null, null, null, null, null];
  inner[72] = 2;
  return inner;
}

// A plan as makePlan leaves one: a retry over the record's own list, which is
// the press every failing send in the trace came from.
function planFor(base, opts) {
  const p = {
    index: 0, retry: true, blocked: null, base: base,
    baseUnreliable: !!(opts && opts.unreliable),
    originalCount: base ? base.length : (opts && opts.count) || 0,
    entries: []
  };
  for (let i = 0; i < p.originalCount; i++) p.entries.push({ kind: 'existing', index: i });
  api.settleExisting(p);
  return p;
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

console.log('the page\'s own references');

it('a page list carrying the record\'s names in order goes out with the page\'s tokens', function () {
  const p = planFor([recordToken('a.jpg'), recordToken('b.jpg')]);
  const page = [pageToken('a.jpg'), pageToken('b.jpg')];
  const inner = editResend(page);
  assert.strictEqual(api.applyPlanTo(inner, p), 'page');
  assert.deepStrictEqual(state.refusals, []);
  assert.strictEqual(inner[0][3], page, 'the page\'s own array is the one that goes out');
  assert.deepStrictEqual(inner[0][3].map((a) => a[2]), ['$PAGE-a.jpg', '$PAGE-b.jpg'],
    'no token value the page did not build reaches the request');
});

it('a message never resent leaves the page\'s list untouched too', function () {
  const p = planFor(null, { count: 2 });
  const page = [pageToken('a.jpg'), pageToken('b.jpg')];
  const inner = editResend(page);
  assert.strictEqual(api.applyPlanTo(inner, p), 'page');
  assert.strictEqual(inner[0][3], page);
});

console.log('when the plan asks for something else, the script writes');

it('an added image writes the list, existing entries in the page\'s references', function () {
  const p = planFor([recordToken('a.jpg')]);
  p.entries.push({ kind: 'new', name: 'c.jpg', attachment: contrib('c.jpg') });
  const page = [pageToken('a.jpg')];
  const inner = editResend(page);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.notStrictEqual(inner[0][3], page, 'a list the page did not build is written');
  assert.deepStrictEqual(inner[0][3], [pageToken('a.jpg'), contrib('c.jpg')],
    'the kept image still carries the page\'s token, the new one its own upload');
});

it('a reorder writes the list in the plan\'s order', function () {
  const p = planFor([recordToken('a.jpg'), recordToken('b.jpg')]);
  p.entries.reverse();
  const inner = editResend([pageToken('a.jpg'), pageToken('b.jpg')]);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.deepStrictEqual(inner[0][3], [pageToken('b.jpg'), pageToken('a.jpg')]);
});

it('a re-uploaded entry is written as its fresh upload', function () {
  const p = planFor([recordToken('a.jpg'), stale('b.jpg')]);
  p.entries[1].freshAttachment = contrib('b.jpg');
  const inner = editResend([pageToken('a.jpg'), pageToken('b.jpg')]);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.deepStrictEqual(inner[0][3], [pageToken('a.jpg'), contrib('b.jpg')]);
});

console.log('when the page\'s list is not the record\'s, the record\'s references are written');

it('a page list naming other files is the one from before the last resend', function () {
  const p = planFor([recordToken('a.jpg'), recordToken('swapped-in.jpg')]);
  const inner = editResend([pageToken('a.jpg'), pageToken('replaced.jpg')]);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.deepStrictEqual(inner[0][3], [recordToken('a.jpg'), recordToken('swapped-in.jpg')]);
});

it('a page list of another length is not read', function () {
  const p = planFor([recordToken('a.jpg'), recordToken('b.jpg')]);
  const inner = editResend([pageToken('a.jpg')]);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.deepStrictEqual(inner[0][3], [recordToken('a.jpg'), recordToken('b.jpg')]);
});

it('matching names prove nothing once this document resent other images under them', function () {
  const p = planFor([recordToken('image.png')], { unreliable: true });
  const inner = editResend([pageToken('image.png')]);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.deepStrictEqual(inner[0][3], [recordToken('image.png')]);
});

it('a page reference the server would not take is not read', function () {
  const p = planFor([recordToken('a.jpg')]);
  const inner = editResend([stale('a.jpg')]);
  assert.strictEqual(api.applyPlanTo(inner, p), 'written');
  assert.deepStrictEqual(inner[0][3], [recordToken('a.jpg')]);
});

console.log('namesShadowPage');

it('a new image under a name the page already lists shadows it', function () {
  const p = planFor([recordToken('image.png')]);
  p.entries = [{ kind: 'new', name: 'image.png', attachment: contrib('image.png') }];
  assert.strictEqual(api.namesShadowPage(p, [pageToken('image.png')], [contrib('image.png')]), true);
});

it('a re-upload in place is the same image and shadows nothing', function () {
  const p = planFor([stale('a.jpg')]);
  p.entries[0].freshAttachment = contrib('a.jpg');
  assert.strictEqual(api.namesShadowPage(p, [pageToken('a.jpg')], [contrib('a.jpg')]), false);
});

it('a list naming other files than the page shadows nothing', function () {
  const p = planFor([recordToken('a.jpg')]);
  p.entries.push({ kind: 'new', name: 'c.jpg', attachment: contrib('c.jpg') });
  assert.strictEqual(api.namesShadowPage(p, [pageToken('a.jpg')],
    [pageToken('a.jpg'), contrib('c.jpg')]), false);
});

it('once shadowed, a message stays so until a reload', function () {
  const p = planFor([recordToken('a.jpg')], { unreliable: true });
  assert.strictEqual(api.namesShadowPage(p, [pageToken('b.jpg')], [recordToken('a.jpg')]), true);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exit(failures ? 1 : 0);
