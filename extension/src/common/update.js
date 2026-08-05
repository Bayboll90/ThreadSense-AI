/** Public GitHub release contract shared by the UI, background and tests. */
export const GITHUB_REPOSITORY_URL = 'https://github.com/sany86russ/ThreadSense-AI';
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`;
export const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/sany86russ/ThreadSense-AI/releases/latest';

export function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseVersion(left);
  const b = Array.isArray(right) ? right : parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function selectReleaseAsset(release, version) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const exact = `ThreadSense-AI-v${version}-unpacked.zip`.toLowerCase();
  const usable = assets.filter((asset) => /^https:\/\/github\.com\//i.test(String(asset?.browser_download_url || '')));
  return usable.find((asset) => String(asset?.name || '').toLowerCase() === exact)
    || usable.find((asset) => /threadsense-ai.*unpacked\.zip$/i.test(String(asset?.name || '')))
    || null;
}

/** Keep remote release data small, predictable and safe to display. */
export function normalizeRelease(release, currentVersion) {
  if (!release || release.draft || release.prerelease) return null;
  const versionParts = parseVersion(release.tag_name);
  if (!versionParts || compareVersions(versionParts, currentVersion) !== 1) return null;

  const version = versionParts.join('.');
  const asset = selectReleaseAsset(release, version);
  const releaseUrl = /^https:\/\/github\.com\/sany86russ\/ThreadSense-AI\/releases\//i.test(String(release.html_url || ''))
    ? release.html_url
    : GITHUB_LATEST_RELEASE_URL;

  return {
    tag: `v${version}`,
    version,
    name: String(release.name || `ThreadSense AI v${version}`).slice(0, 120),
    publishedAt: String(release.published_at || ''),
    releaseUrl,
    downloadUrl: asset?.browser_download_url || releaseUrl,
    assetName: asset?.name || '',
  };
}

export function updateView(state, currentVersion) {
  const latest = state?.update?.latest || null;
  const valid = latest && compareVersions(latest.version, currentVersion) === 1 ? latest : null;
  return {
    currentVersion,
    available: valid,
    visible: !!valid && state?.update?.dismissedTag !== valid.tag,
    checkedAt: Number(state?.update?.checkedAt) || 0,
    error: String(state?.update?.error || ''),
  };
}
