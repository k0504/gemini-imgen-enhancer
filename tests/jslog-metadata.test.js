'use strict';
// The turn and the conversation an image belongs to, read from the jslog
// attribute Gemini puts on its logged elements.
//
// Gemini writes the BardVeMetadataKey of that attribute as base64 of a JSON
// array, followed by further `;` fields. It used to write the JSON itself; every
// reader that scanned the raw attribute for `"r_<hex>"` stopped matching when
// the format changed, and the download quietly fell through to the page's own,
// which delivers the small copy. Only the base64 form is accepted. Anything
// else that sits behind the key is a format break, and a format break stops
// the download and says so instead of handing the click to the page.
//
// Run: node tests/jslog-metadata.test.js

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

const names = ['targetOf', 'conversationTag', 'conversationNear', 'markConversationImages',
  'onDownloadClick', 'veMetadata'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';

// The value Gemini writes today, taken from a conversation page, and what it
// decodes to.
const B64 = 'W1sicl8xMjVjMThmY2MyOGQwODEwIiwiY183YzQ5NmFhMzg0YmVkZTM4IixudWxsLCJyY19kMWI2ZTIwZTE5M2U4M2QxIixudWxsLG51bGwsInVuZCIsbnVsbCwxLG51bGwsbnVsbCwxLDFdXQ==';
const JSLOG_NOW = '185864;track:generic_click,impression,attention;BardVeMetadataKey:' + B64 + ';mutable:true';
// The format Gemini wrote before: the same JSON, not encoded.
const JSLOG_OLD = '185865;track:generic_click;BardVeMetadataKey:[["r_125c18fcc28d0810","c_7c496aa384bede38",null]];mutable:true';
// Base64 that decodes to something other than a JSON array.
const JSLOG_JUNK = '185864;track:generic_click;BardVeMetadataKey:' + Buffer.from('not json').toString('base64') + ';mutable:true';
// A library card: a metadata key of nothing but nulls.
const JSLOG_CARD = '185864;track:generic_click;BardVeMetadataKey:' + Buffer.from('[[null,null,null]]').toString('base64');

function node(attrs, extra) {
  const n = Object.assign({
    isConnected: true,
    parentElement: null,
    style: {},
    dot: null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelectorAll: () => [],
    querySelector: (sel) => (sel === ':scope > .gpie-origin-dot' ? n.dot : null),
    appendChild: (child) => { n.dot = child; child.remove = () => { n.dot = null; }; }
  }, extra || {});
  return n;
}

function harness(stubs) {
  const log = { said: [], dbg: [], notes: [] };
  const reported = Object.create(null);
  const api = new Function(
    'appPath', 'previewKeyNear', 'singleImageOf', 'menuHost', 'lastImage', 'dbg', 'say',
    'LOG_IMG', 'document', 'tokenForTurn', 'getComputedStyle', 'jslogReported',
    'DOWNLOAD_BUTTONS', 'downloadable', 'noteDownload', 'atob',
    body)(
    stubs.appPath || (() => '/app/abcdef0123456789'),
    () => null,
    stubs.singleImageOf || (() => null),
    () => null,
    null,
    (...rest) => { log.dbg.push(rest.join(' ')); },
    (level, tag, ...rest) => { log.said.push([level, rest.join(' ')]); },
    '[gpie]',
    {
      querySelectorAll: () => stubs.hosts || [],
      createElement: () => ({ className: '', title: '' })
    },
    stubs.tokenForTurn || (() => null),
    () => ({ position: 'relative' }),
    reported,
    'download-generated-image-button',
    stubs.downloadable || (() => false),
    (text, done) => { log.notes.push([text, !!done]); },
    atob
  );
  return { api, log };
}

function isFormatBreak(err) {
  return err && err.name === 'JslogFormatError';
}

// --- the turn of a conversation image -----------------------------------------

{
  const host = node({ jslog: JSLOG_NOW, 'data-image-attachment-index': '0' });
  const { api } = harness({ singleImageOf: () => host });
  assert.deepStrictEqual(api.targetOf({}),
    { id: 'r_125c18fcc28d0810#0', resp: 'r_125c18fcc28d0810', slot: 0 },
    'the turn is read from the base64 metadata key Gemini writes today');
}

{
  const host = node({ jslog: JSLOG_OLD, 'data-image-attachment-index': '0' });
  const { api } = harness({ singleImageOf: () => host });
  assert.throws(() => api.targetOf({}), isFormatBreak,
    'the old literal JSON form is a format break, not a second accepted form');
}

{
  // No metadata key at all is an image the page never tagged, not a break.
  const host = node({ jslog: '185864;track:generic_click', 'data-image-attachment-index': '0' });
  const { api, log } = harness({ singleImageOf: () => host });
  assert.strictEqual(api.targetOf({}), null);
  assert.ok(log.dbg.some((l) => /names neither its turn/.test(l)));
}

// --- the helper itself --------------------------------------------------------

{
  const { api } = harness({});
  const text = api.veMetadata(JSLOG_NOW, 'conversation image');
  assert.ok(text.indexOf('"r_125c18fcc28d0810"') !== -1);
  assert.ok(text.indexOf('"c_7c496aa384bede38"') !== -1);
  assert.strictEqual(api.veMetadata('185864;track:generic_click', 'conversation image'), null);
  assert.strictEqual(api.veMetadata(null, 'conversation image'), null);

  let caught = null;
  try { api.veMetadata(JSLOG_OLD, 'library card'); } catch (err) { caught = err; }
  assert.ok(isFormatBreak(caught), 'literal JSON is rejected');
  assert.ok(/library card/.test(caught.message), 'the message names the element');
  assert.ok(caught.message.indexOf('[["r_125c18fcc28d0810","c_7c49') !== -1,
    'the message carries the start of the offending value');
  assert.ok(/13-library\.js/.test(caught.message), 'the message names the file to update');

  assert.throws(() => api.veMetadata(JSLOG_JUNK, 'conversation image'), isFormatBreak,
    'base64 of something other than a JSON array is rejected');
  assert.throws(() => api.veMetadata('1;BardVeMetadataKey:;mutable:true', 'conversation image'),
    isFormatBreak, 'an empty value is rejected');
}

// --- the conversation named near a download button ----------------------------

{
  const inner = node({ jslog: JSLOG_NOW });
  const button = node({}, { querySelectorAll: () => [inner] });
  const { api } = harness({});
  assert.strictEqual(api.conversationNear(button, 'conversation image'), '7c496aa384bede38',
    'a base64-tagged element inside the button is found and read');
}

{
  // A tagged descendant that names no conversation does not stop the search.
  const blank = node({ jslog: JSLOG_CARD });
  const named = node({ jslog: JSLOG_NOW });
  const button = node({}, { querySelectorAll: () => [blank, named] });
  const { api } = harness({});
  assert.strictEqual(api.conversationNear(button, 'library card'), '7c496aa384bede38');
}

{
  const card = node({ jslog: JSLOG_CARD });
  const button = node({}, { parentElement: card });
  const { api } = harness({ appPath: () => '/library' });
  assert.strictEqual(api.conversationNear(button, 'library card'), null,
    'a card whose key is all nulls names no conversation');
}

// --- the mark on a conversation page ------------------------------------------

{
  const good = node({ jslog: JSLOG_NOW, 'data-image-attachment-index': '0' });
  const broken = node({ jslog: JSLOG_OLD, 'data-image-attachment-index': '1' });
  const { api, log } = harness({
    hosts: [good, broken],
    tokenForTurn: (resp, slot) => (resp === 'r_125c18fcc28d0810' ? 'tok' + slot : null)
  });
  api.markConversationImages();
  assert.ok(good.dot, 'a decoded image with a token on record is marked');
  assert.strictEqual(broken.dot, null, 'an image whose jslog cannot be read is not marked');
  const errors = () => log.said.filter((s) => s[0] === 'error');
  assert.strictEqual(errors().length, 1, 'the break is reported');
  assert.ok(/conversation image/.test(errors()[0][1]));
  api.markConversationImages();
  api.markConversationImages();
  assert.strictEqual(errors().length, 1, 'once, not on every scan pass');
}

// --- the click ----------------------------------------------------------------

function click(button) {
  const ev = { cancelled: [], target: { closest: () => button } };
  ev.preventDefault = () => ev.cancelled.push('preventDefault');
  ev.stopPropagation = () => ev.cancelled.push('stopPropagation');
  ev.stopImmediatePropagation = () => ev.cancelled.push('stopImmediatePropagation');
  return ev;
}

{
  const host = node({ jslog: JSLOG_OLD, 'data-image-attachment-index': '0' });
  const button = node({});
  const { api, log } = harness({ singleImageOf: () => host });
  const ev = click(button);
  api.onDownloadClick(ev);
  assert.deepStrictEqual(ev.cancelled.sort(),
    ['preventDefault', 'stopImmediatePropagation', 'stopPropagation'],
    'a format break keeps the click from the page, which would deliver the small copy');
  assert.ok(log.said.some((s) => s[0] === 'error' && /format changed/.test(s[1])),
    'and says why');
  assert.ok(log.notes.length === 1 && log.notes[0][1] === true,
    'and puts it in the corner note, finished');
  assert.ok(!log.dbg.some((l) => /left to the page/.test(l)), 'it is not left to the page');
}

{
  // A readable image with no token on record is still the page's to download.
  const host = node({ jslog: JSLOG_NOW, 'data-image-attachment-index': '0' });
  const button = node({});
  const { api, log } = harness({ singleImageOf: () => host, downloadable: () => false });
  const ev = click(button);
  api.onDownloadClick(ev);
  assert.deepStrictEqual(ev.cancelled, []);
  assert.ok(log.dbg.some((l) => /unmarked image, left to the page/.test(l)));
  assert.strictEqual(log.said.length, 0);
}

console.log('jslog-metadata: all assertions held');
