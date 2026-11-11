/* Register event listeners synchronously so Firefox can wake this event page. */
const launcherReady = import("./launcher.js").then(({ createLauncher }) => createLauncher(browser));

async function openLauncher(tab) {
  try {
    const launcher = await launcherReady;
    await launcher.open(tab);
    await browser.action.setBadgeText({ text: "" });
    await browser.action.setTitle({ title: "Search or Switch" });
  } catch {
    await browser.action.setBadgeText({ text: "!" });
    await browser.action.setTitle({ title: "Could not open Search or Switch. Click to try again." });
  }
}

browser.action.onClicked.addListener((tab) => { void openLauncher(tab); });
browser.commands.onCommand.addListener((command, tab) => {
  if (command === "open-search") void openLauncher(tab);
});
