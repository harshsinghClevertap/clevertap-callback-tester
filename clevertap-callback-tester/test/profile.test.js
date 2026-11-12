'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveProfileUrl } = require('../src/profile');

const MSG = '216336|1794298065|20261112|191529|0';

test('regional callback host gives that region', () => {
  assert.equal(
    deriveProfileUrl('https://in1.cb.wzrkt.com/wa/generic/status?a=ABC-123-XYZ', MSG),
    'https://in1.dashboard.clevertap.com/ABC-123-XYZ/j191529/profile-view.html',
  );
  assert.match(deriveProfileUrl('https://sg1.cb.wzrkt.com/x?a=A-B', MSG), /^https:\/\/sg1\./);
});

test('no region label means eu1', () => {
  assert.equal(
    deriveProfileUrl('https://cb.wzrkt.com/wa/generic/status?a=ABC-123-XYZ', MSG),
    'https://eu1.dashboard.clevertap.com/ABC-123-XYZ/j191529/profile-view.html',
  );
});

test('returns null when something is missing or odd', () => {
  assert.equal(deriveProfileUrl('https://cb.wzrkt.com/x', MSG), null); // no account id
  assert.equal(deriveProfileUrl('https://cb.wzrkt.com/x?a=A-B', '1|2|3'), null); // no 4th part
  assert.equal(deriveProfileUrl('https://webhook.site/abc?a=A-B', MSG), null); // not a cb host
  assert.equal(deriveProfileUrl('not a url', MSG), null);
});

test('sms: account from "account" param, profile from second-last msgId part', () => {
  const sms = '918605962596.1736923649.1794480055.20261112.0.wzrk_default.-191529.-1.';
  assert.equal(
    deriveProfileUrl('https://cb.wzrkt.com/sms/generic?account=ABC-123-XYZ', sms, 'sms'),
    'https://eu1.dashboard.clevertap.com/ABC-123-XYZ/j191529/profile-view.html',
  );
  assert.match(deriveProfileUrl('https://in1.cb.wzrkt.com/sms/generic?account=A-B', sms, 'sms'), /^https:\/\/in1\./);
  assert.equal(deriveProfileUrl('https://cb.wzrkt.com/sms/generic?a=A-B', sms, 'sms'), null);
});
