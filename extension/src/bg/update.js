import { getState, updateState } from '../common/storage.js';
import {
  GITHUB_LATEST_RELEASE_API,
  GITHUB_LATEST_RELEASE_URL,
  normalizeRelease,
  updateView,
} from '../common/update.js';

export const UPDATE_ALARM = 'threadsense-release-check';
export const UPDATE_NOTIFICATION = 'threadsense-release-available';
export const UPDATE_PERIOD_MINUTES = 6 * 60;
const MIN_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
let activeCheck = null;

const currentVersion = () => chrome.runtime.getManifest().version;

export async function scheduleUpdateChecks() {
  await chrome.alarms.create(UPDATE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: UPDATE_PERIOD_MINUTES,
  });
}

export async function getUpdateView(state = null) {
  return updateView(state || await getState(true), currentVersion());
}

export async function checkForUpdates(options = {}) {
  if (activeCheck) {
    const current = await activeCheck;
    if (!options.force) return current;
  }
  activeCheck = performUpdateCheck(options);
  try {
    return await activeCheck;
  } finally {
    activeCheck = null;
  }
}

async function performUpdateCheck({ force = false, notifyUser = true } = {}) {
  const before = await getState(true);
  const previous = updateView(before, currentVersion());
  if (!force && previous.checkedAt && Date.now() - previous.checkedAt < MIN_CHECK_INTERVAL_MS) return previous;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_API, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
    const latest = normalizeRelease(await response.json(), currentVersion());
    const next = await updateState((state) => {
      state.update ||= {};
      state.update.checkedAt = Date.now();
      state.update.error = '';
      state.update.latest = latest;
      if (force) state.update.dismissedTag = '';
      return state;
    });
    const view = updateView(next, currentVersion());

    if (notifyUser && view.available && next.update?.notifiedTag !== view.available.tag) {
      await chrome.notifications.create(UPDATE_NOTIFICATION, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `Доступна ThreadSense AI ${view.available.tag}`,
        message: 'Нажмите, чтобы скачать готовое обновление с GitHub.',
        priority: 1,
      });
      await updateState((state) => {
        state.update ||= {};
        state.update.notifiedTag = view.available.tag;
        return state;
      });
    }
    return view;
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Превышено время ожидания GitHub' : (error?.message || String(error));
    const next = await updateState((state) => {
      state.update ||= {};
      state.update.checkedAt = Date.now();
      state.update.error = message.slice(0, 180);
      return state;
    });
    return updateView(next, currentVersion());
  } finally {
    clearTimeout(timeout);
  }
}

export async function dismissUpdate(tag) {
  const next = await updateState((state) => {
    state.update ||= {};
    state.update.dismissedTag = String(tag || state.update.latest?.tag || '');
    return state;
  });
  return updateView(next, currentVersion());
}

export async function openLatestRelease() {
  const view = await getUpdateView();
  await chrome.tabs.create({ url: view.available?.releaseUrl || GITHUB_LATEST_RELEASE_URL });
}
