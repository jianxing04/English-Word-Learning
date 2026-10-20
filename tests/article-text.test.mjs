import test from 'node:test';
import assert from 'node:assert/strict';
import {sentenceParts} from '../static/article-text.mjs';

test('Article highlights use exact source offsets for inflected words and repeated occurrences',()=>{
  const text='He ran and is running, while a crane stood nearby.';
  const parts=sentenceParts(text,[[3,6],[14,21]]);
  assert.deepEqual(parts.filter(part=>part.highlight).map(part=>part.text),['ran','running']);
  assert.equal(parts.map(part=>part.text).join(''),text);
  assert.equal(parts.find(part=>part.text.includes('crane')).highlight,false);
});
test('Article offsets keep Unicode characters before the match intact',()=>{
  const text='🔎 The children ran.';
  const parts=sentenceParts(text,[[6,14]]);
  assert.equal(parts.find(part=>part.highlight).text,'children');
  assert.equal(parts.map(part=>part.text).join(''),text);
});
test('Overlapping source positions merge and invalid positions never destroy the original text',()=>{
  const text="They can't leave.";
  const parts=sentenceParts(text,[[5,7],[7,10],[5,10],[-1,2],[0,999]]);
  assert.equal(parts.find(part=>part.highlight).text,"can't");
  assert.equal(parts.map(part=>part.text).join(''),text);
});
