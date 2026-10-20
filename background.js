// YouTube Timestamp Tools — background service worker (minimal)
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings) {
      await chrome.storage.sync.set({
        settings: {
          enabled: true,
          loopsOn: true,
          skipsOn: true,
          panelHidden: false,
          panelPos: null,
          firstRun: true
        }
      });
    }
  } catch (e) {
    // storage may be unavailable during edge cases like browser shutdown; safe to ignore
  }
});
