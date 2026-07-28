#!/usr/bin/env node
'use strict';
// Selfcheck for the allocation-JSON identity resolver: a market name is shown when readable, and a
// conditionId with no readable name renders as its truncated id with nameAvailable=false — never invented.
const assert = require('assert');
const { identify } = require('./allocate-json');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

const nameMap = new Map([
  ['0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999', { question: 'Will X happen?', category: 'Politics' }],
  ['0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff', { question: '   ', category: null }], // blank name
]);

console.log('identify — readable name vs unavailable');
{
  const a = identify(nameMap, '0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999');
  ok('readable name surfaced with category', a.nameAvailable === true && a.name === 'Will X happen?' && a.category === 'Politics');
  const b = identify(nameMap, '0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff');
  ok('blank name → nameAvailable false, name null (never invented)', b.nameAvailable === false && b.name === null);
  ok('blank name → truncated id shown instead', /^0x1111.*ffff$/.test(b.shortId) && b.shortId.includes('…'));
  const c = identify(nameMap, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  ok('unknown conditionId → nameAvailable false, truncated id', c.nameAvailable === false && c.name === null && c.shortId.startsWith('0xdeadbeef'));
}
console.log(`\nallocate-json.test: ${n} assertions passed`);
