import assert from 'node:assert/strict';
import {
  GITHUB_LATEST_RELEASE_URL,
  compareVersions,
  normalizeRelease,
  parseVersion,
  selectReleaseAsset,
  updateView,
} from '../extension/src/common/update.js';

assert.deepEqual(parseVersion('v2.3.0'), [2, 3, 0]);
assert.deepEqual(parseVersion('10.12.4'), [10, 12, 4]);
assert.equal(parseVersion('v2.3'), null);
assert.equal(parseVersion('2.3.0-beta'), null);
assert.equal(compareVersions('2.3.0', '2.2.9'), 1);
assert.equal(compareVersions('2.3.0', '2.3.0'), 0);
assert.equal(compareVersions('2.2.9', '2.3.0'), -1);

const release = {
  tag_name: 'v2.3.0',
  name: 'ThreadSense AI 2.3.0',
  html_url: 'https://github.com/sany86russ/ThreadSense-AI/releases/tag/v2.3.0',
  published_at: '2026-08-05T12:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'source.zip', browser_download_url: 'https://github.com/sany86russ/ThreadSense-AI/releases/download/v2.3.0/source.zip' },
    { name: 'ThreadSense-AI-v2.3.0-unpacked.zip', browser_download_url: 'https://github.com/sany86russ/ThreadSense-AI/releases/download/v2.3.0/ThreadSense-AI-v2.3.0-unpacked.zip' },
  ],
};

assert.equal(selectReleaseAsset(release, '2.3.0')?.name, 'ThreadSense-AI-v2.3.0-unpacked.zip');
const normalized = normalizeRelease(release, '2.2.0');
assert.equal(normalized?.tag, 'v2.3.0');
assert.match(normalized?.downloadUrl, /unpacked\.zip$/);
assert.equal(normalizeRelease(release, '2.3.0'), null);
assert.equal(normalizeRelease({ ...release, draft: true }, '2.2.0'), null);
assert.equal(normalizeRelease({ ...release, prerelease: true }, '2.2.0'), null);
assert.equal(normalizeRelease({ ...release, tag_name: 'broken' }, '2.2.0'), null);

const unsafe = normalizeRelease({
  ...release,
  html_url: 'https://example.com/fake',
  assets: [{ name: 'ThreadSense-AI-v2.3.0-unpacked.zip', browser_download_url: 'https://example.com/fake.zip' }],
}, '2.2.0');
assert.equal(unsafe?.releaseUrl, GITHUB_LATEST_RELEASE_URL);
assert.equal(unsafe?.downloadUrl, GITHUB_LATEST_RELEASE_URL);

const visible = updateView({ update: { checkedAt: 42, latest: normalized, dismissedTag: '' } }, '2.2.0');
assert.equal(visible.visible, true);
assert.equal(visible.checkedAt, 42);
assert.equal(updateView({ update: { latest: normalized, dismissedTag: 'v2.3.0' } }, '2.2.0').visible, false);
assert.equal(updateView({ update: { latest: normalized } }, '2.3.0').available, null);

console.log('PASS  GitHub release update contract');
