'use strict';
// What unlocks Gemini's own Update button.
//
// Gemini keeps Update disabled until the prompt text changes, so an edit that
// changes only the images - or changes nothing at all and is meant as a plain
// resend - cannot be sent. The zero-width sentinel appended to the textarea is
// the value change that unlocks it, and rewrite() strips it before the body
// departs, so the server sees the prompt the user wrote.
//
// The condition is readiness alone. Dirtiness is not part of it: the send path
// has a route for an unchanged list (it is written from the record, because the
// body Gemini builds for a resent message is the one from before that resend)
// and a route for no record and no change (the body goes as it stands and the
// truncation hold is still armed). Both were unreachable while the sentinel
// waited for a change to the attachments.
//
// Readiness stays in it: an existing entry reaches the server as an upload this
// document made or not at all, so a plan that is not ready has nothing to write
// the list from and its press would be refused.
//
// Run: node tests/edit-unlock.test.js

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

const SENTINEL = String.fromCharCode(0x200B);
// The three the sentinel is decided by, lifted rather than restated: a copy of
// planIsDirty or planIsReady here would keep passing after the real one moved.
const names = ['syncSentinel', 'planIsDirty', 'planIsReady'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';

const state = { textarea: null, writes: 0 };
const api = new Function('textareaOf', 'writeTextarea', 'dbg', 'SENTINEL', body)(
  () => state.textarea,
  (textarea, value) => { textarea.value = value; state.writes++; },
  function () { },
  SENTINEL);

// The one place both halves of the button's availability are kept current.
// renderBar applies the sentinel once, when the toolbar is built, and
// ensureBar returns early on every pass after that - so an edit that changed
// nothing had its only chance while its re-uploads were still running, and
// there was no second one. This is that second one, and it is the same call
// the scan pass and a landing upload already make.
const gate = { synced: [] };
const gateApi = new Function('syncSentinel', 'updateHold', 'heldPress',
  extract('syncUpdateGate') + '\n; return { syncUpdateGate };')(
  (p) => gate.synced.push(p),
  () => false,
  function () { });

function host() {
  return {
    isConnected: true,
    querySelector: () => null,
    addEventListener: function () { }
  };
}

function entry(over) {
  return Object.assign({ kind: 'existing', index: 0, freshAttachment: 'contrib' }, over || {});
}

function plan(entries, over) {
  return Object.assign({
    index: 0,
    blocked: null,
    entries: entries,
    originalCount: entries.length,
    sentinelApplied: false
  }, over || {});
}

let failures = 0;
function it(what, fn) {
  state.textarea = { value: 'draw a cat' };
  state.writes = 0;
  gate.synced = [];
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

console.log('edit unlock');

it('an edit that changed nothing is still unlocked', function () {
  const p = plan([entry(), entry({ index: 1 })]);
  assert.strictEqual(api.planIsDirty(p), false, 'the fixture is the untouched case');
  api.syncSentinel(p);
  assert.ok(state.textarea.value.endsWith(SENTINEL),
    'Update has no other way off disabled: ' + JSON.stringify(state.textarea.value));
  assert.strictEqual(p.sentinelApplied, true);
});

it('an edit that changed the images is unlocked', function () {
  const p = plan([entry(), entry({ index: 1 })], { originalCount: 1 });
  assert.strictEqual(api.planIsDirty(p), true);
  api.syncSentinel(p);
  assert.ok(state.textarea.value.endsWith(SENTINEL));
});

it('a plan whose uploads have not finished is left locked', function () {
  const p = plan([entry(), entry({ index: 1, freshAttachment: null })]);
  api.syncSentinel(p);
  assert.strictEqual(state.writes, 0,
    'there is nothing to write the list from, so the press would be refused');
  assert.strictEqual(p.sentinelApplied, false);
});

it('a plan whose record is in doubt is left locked', function () {
  const p = plan([entry()], { blocked: 'its record could not be stored' });
  api.syncSentinel(p);
  assert.strictEqual(state.writes, 0, 'blocked is never ready, uploads or not');
});

it('the sentinel is written once, not on every pass', function () {
  const p = plan([entry()]);
  api.syncSentinel(p);
  api.syncSentinel(p);
  api.syncSentinel(p);
  assert.strictEqual(state.writes, 1, 'the scan pass calls this on every mutation');
  assert.strictEqual(state.textarea.value, 'draw a cat' + SENTINEL, 'and never twice over');
});

it('an upload failing after the unlock takes the sentinel back off', function () {
  const p = plan([entry(), entry({ index: 1 })]);
  api.syncSentinel(p);
  p.entries[1].freshAttachment = null;
  api.syncSentinel(p);
  assert.strictEqual(state.textarea.value, 'draw a cat', 'the prompt is the user\'s again');
  assert.strictEqual(p.sentinelApplied, false);
});

it('a sentinel left by an earlier run does not count as this plan\'s', function () {
  // Reading the current text instead of the flag would see this one, skip the
  // write, and leave Update disabled with nothing left that could unlock it.
  state.textarea.value = 'draw a cat' + SENTINEL;
  const p = plan([entry()]);
  api.syncSentinel(p);
  assert.strictEqual(state.writes, 1, 'a value change is dispatched regardless');
});

it('the uploads landing after the toolbar was built still unlock Update', function () {
  // The order the real thing runs in: the toolbar is built while the existing
  // attachments are still being re-uploaded, so the sentinel is not applied
  // then. Nothing rebuilds the toolbar afterwards - ensureBar returns early on
  // a connected one - so unless the gate carries the sentinel too, the button
  // is grey for the rest of the edit.
  const p = plan([entry({ freshAttachment: null })], { host: host() });
  api.syncSentinel(p);
  assert.strictEqual(state.writes, 0, 'not ready yet, as at toolbar build time');

  p.entries[0].freshAttachment = 'contrib';
  gateApi.syncUpdateGate(p);
  assert.deepStrictEqual(gate.synced, [p],
    'the gate is what runs on a landing upload and on every scan pass');
});

it('the gate leaves a torn-down editor alone', function () {
  const p = plan([entry()], { host: { isConnected: false, querySelector: () => null } });
  gateApi.syncUpdateGate(p);
  assert.deepStrictEqual(gate.synced, [], 'there is no textarea left to write into');
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
