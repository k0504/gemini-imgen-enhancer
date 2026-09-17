'use strict';
// Pasting an image into an open editor.
//
// The listener sits on the document in the capture phase for the same reason
// the drag one does: Gemini watches the document for pasted files and takes
// them into the composer as a new message, so a paste aimed at the message
// being edited has to be claimed before it reaches that listener.
//
// What the handler must not do matters as much as what it does. A paste is
// how text is edited, and every paste that carries no image - or lands
// anywhere but inside the message whose editor is open - has to reach the page
// untouched. The assertions below are mostly about those.
//
// Run: node tests/paste-attach.test.js

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

const state = { plan: null, added: [] };
const names = ['onDocumentPaste', 'imageFilesOf'];

// The extracted source reads `plan` and `addFile` as free names, and both
// change between cases, so each case builds its own instance over its own
// bindings rather than mutating one.
function handler() {
  state.added = [];
  return new Function('plan', 'addFile', 'dbg',
    names.map(extract).join('\n') + '\n; return onDocumentPaste;')(
    state.plan,
    (p, file) => state.added.push(file),
    function () { });
}

function file(type, name) {
  return { type: type, name: name || 'image.png', size: 1024 };
}

// A node that reports whether the host of the open plan contains it.
function target(inside) {
  return { __inside: inside };
}

function host() {
  return { contains: (node) => !!(node && node.__inside) };
}

function paste(node, files) {
  return {
    type: 'paste',
    target: node,
    clipboardData: { files: files },
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented++; },
    stopPropagation() { this.stopped++; }
  };
}

let failures = 0;
function it(what, fn) {
  state.plan = null;
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

console.log('paste into the editor');

it('an image pasted inside the open editor becomes an attachment', function () {
  state.plan = { host: host(), entries: [] };
  const ev = paste(target(true), [file('image/png'), file('image/jpeg', 'shot.jpg')]);
  handler()(ev);
  assert.strictEqual(state.added.length, 2, 'both images are staged');
  assert.strictEqual(ev.prevented, 1, 'the page does not also act on the paste');
  assert.strictEqual(ev.stopped, 1, 'and no other listener sees it');
});

it('a paste carrying no image is left alone', function () {
  state.plan = { host: host(), entries: [] };
  const ev = paste(target(true), []);
  handler()(ev);
  assert.strictEqual(state.added.length, 0, 'nothing is staged');
  assert.strictEqual(ev.prevented, 0, 'pasting text into the prompt still works');
  assert.strictEqual(ev.stopped, 0, 'and the page sees it');
});

it('a file that is not an image is left alone', function () {
  state.plan = { host: host(), entries: [] };
  const ev = paste(target(true), [file('application/pdf', 'a.pdf')]);
  handler()(ev);
  assert.strictEqual(state.added.length, 0, 'nothing is staged');
  assert.strictEqual(ev.prevented, 0, 'the paste reaches the page');
});

it('an image pasted with no editor open is left alone', function () {
  state.plan = null;
  const ev = paste(target(true), [file('image/png')]);
  handler()(ev);
  assert.strictEqual(state.added.length, 0, 'nothing is staged');
  assert.strictEqual(ev.prevented, 0, 'a paste into the composer is the page\'s own');
});

it('an image pasted outside the open editor is left alone', function () {
  state.plan = { host: host(), entries: [] };
  const ev = paste(target(false), [file('image/png')]);
  handler()(ev);
  assert.strictEqual(state.added.length, 0, 'nothing is staged');
  assert.strictEqual(ev.prevented, 0,
    'the composer keeps its own paste while an editor is open elsewhere');
});

it('a paste with no clipboard at all is left alone', function () {
  state.plan = { host: host(), entries: [] };
  const ev = paste(target(true), null);
  ev.clipboardData = null;
  handler()(ev);
  assert.strictEqual(state.added.length, 0, 'nothing is staged');
  assert.strictEqual(ev.prevented, 0, 'and nothing throws');
});

if (failures) {
  console.log('\n' + failures + ' failed');
  process.exit(1);
}
console.log('\nall passed');
