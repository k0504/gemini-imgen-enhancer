'use strict';
// The gate on Gemini's own Update button.
//
// Update unlocks on any text change, which is what an edit of the prompt is,
// and the re-uploads that an edit of a resent message starts take seconds - a
// refetch and an upload per attachment, because a record upgraded to server
// references holds neither a live contrib nor the bytes. A press inside that
// window reaches rewrite() with a plan that has nothing to write the list
// from, so the send is refused, the transport throws, and the page reports it
// as a lost connection. The refusal is right; what the user is shown is not.
//
// The press is intercepted rather than the button disabled: `disabled` is
// Angular's, and writing it is undone by the next change detection with no way
// to tell whose value came back.
//
// Run: node tests/update-gate.test.js

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

const state = { plan: null, said: [] };
const names = ['heldPress', 'updateHold'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';
const api = new Function('activePlan', 'planIsReady', 'progress', 'dbg', body)(
  () => state.plan,
  // The real one, in the shape 06-plan.js states it: blocked is never ready,
  // and every entry has to hold the attachment it will be sent as.
  (p) => (p.blocked ? false : p.entries.every((e) => (e.kind === 'existing'
    ? e.freshAttachment : e.attachment))),
  (text) => state.said.push(text),
  function () { });

function entry(over) {
  return Object.assign({ kind: 'existing', index: 0, freshAttachment: 'contrib' }, over || {});
}

function plan(entries, over) {
  return Object.assign({ index: 0, blocked: null, entries: entries }, over || {});
}

// A click that landed inside the Update button, and one that landed anywhere
// else in the editor.
function press(onUpdate) {
  const ev = {
    target: { closest: (sel) => (onUpdate && sel === 'gem-button.update-button' ? {} : null) },
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented++; },
    stopImmediatePropagation() { this.stopped++; }
  };
  return ev;
}

let failures = 0;
function it(what, fn) {
  state.plan = null;
  state.said = [];
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

console.log('update gate');

it('a press while an upload is still running never reaches the page', function () {
  state.plan = plan([entry(), entry({ index: 1, freshAttachment: null })]);
  const ev = press(true);
  api.heldPress(ev);
  assert.strictEqual(ev.prevented, 1, 'the default action is cancelled');
  assert.strictEqual(ev.stopped, 1, 'and no other listener sees it');
  assert.strictEqual(state.said.length, 1, 'the user is told why the press did nothing');
  assert.ok(/1 of 2/.test(state.said[0]), 'the message counts what is outstanding: ' + state.said[0]);
});

it('a press once every upload has finished is left alone', function () {
  state.plan = plan([entry(), entry({ index: 1 })]);
  const ev = press(true);
  api.heldPress(ev);
  assert.strictEqual(ev.prevented, 0, 'the send is the one the plan was made for');
  assert.deepStrictEqual(state.said, [], 'and nothing is reported');
});

it('a press somewhere else in the editor is left alone', function () {
  state.plan = plan([entry({ freshAttachment: null })]);
  const ev = press(false);
  api.heldPress(ev);
  assert.strictEqual(ev.prevented, 0, 'only the Update button is gated');
});

it('a press with no plan at all is left alone', function () {
  const ev = press(true);
  api.heldPress(ev);
  assert.strictEqual(ev.prevented, 0, 'nothing is staged, so nothing is being waited for');
});

it('an upload that failed is named as one, not as still running', function () {
  state.plan = plan([entry({ freshAttachment: null, freshError: 'Error: http 400' })]);
  const ev = press(true);
  api.heldPress(ev);
  assert.strictEqual(ev.prevented, 1, 'this plan will never be ready');
  assert.ok(/failed/i.test(state.said[0]),
    'a failed upload wants the image replaced by hand, not more waiting: ' + state.said[0]);
});

it('a plan whose record is in doubt says so rather than counting uploads', function () {
  state.plan = plan([entry()], { blocked: 'its record could not be stored' });
  const ev = press(true);
  api.heldPress(ev);
  assert.strictEqual(ev.prevented, 1, 'blocked is never ready, uploads or not');
  assert.ok(/could not be stored/.test(state.said[0]),
    'the reason is the record, and the message says which: ' + state.said[0]);
});

it('the hold is on while an upload runs and off once it does not', function () {
  assert.strictEqual(api.updateHold(plan([entry({ freshAttachment: null })])), true);
  assert.strictEqual(api.updateHold(plan([entry()])), false);
  assert.strictEqual(api.updateHold(null), false, 'no plan is not a held button');
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
