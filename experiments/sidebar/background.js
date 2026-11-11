/* Keep registration and toggle calls synchronous to preserve Firefox's user gesture. */
let latestAttempt = 0;

function setSidebarStatus(failed) {
  const updates = [
    () => browser.action.setBadgeText({ text: failed ? "!" : "" }),
    () => browser.action.setTitle({
      title: failed
        ? "Could not toggle Search or Switch. Click to try again."
        : "Search or Switch",
    }),
  ];
  // Status failures must not turn a handled sidebar failure into an unhandled rejection.
  for (const update of updates) void Promise.resolve().then(update).catch(() => {});
}

function observeToggle(result) {
  const attempt = ++latestAttempt;
  void Promise.resolve(result).then(
    () => { if (attempt === latestAttempt) setSidebarStatus(false); },
    () => { if (attempt === latestAttempt) setSidebarStatus(true); },
  );
}

function failedSynchronously() {
  latestAttempt += 1;
  setSidebarStatus(true);
}

browser.action.onClicked.addListener(() => {
  try {
    // This API requires a live user gesture; do not await/import before calling it.
    observeToggle(browser.sidebarAction.toggle());
  } catch {
    failedSynchronously();
  }
});

browser.commands.onCommand.addListener((command) => {
  if (command !== "open-search") return;
  try {
    observeToggle(browser.sidebarAction.toggle());
  } catch {
    failedSynchronously();
  }
});
