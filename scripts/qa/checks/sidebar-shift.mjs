// Adds enough chats for the Tasks list to scroll, then drags the window's height up and down and
// reports the first chat row's left edge and whether the list scrolls at each height.
// Usage: node checks/sidebar-shift.mjs

import { openWorkspace } from "../lib/open.mjs";

// Runs after the stub. Adds 40 idle chats so the list overflows at smaller heights.
const script = `(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const now = Date.now();
  const extra = Array.from({ length: 40 }, (_, i) => ({
    id: "extra" + i, projectId: null, title: "Chat " + i, agent: "claude", model: null, accessMode: "full-access", effort: null,
    sessionId: null, createdAt: now - i * 1000, messages: [], goal: null, folderId: null, archivedAt: null,
  }));
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    const r = await invoke(cmd, args);
    return cmd === "list_threads" ? [...r, ...extra] : r;
  };
})();`;

const { browser, page } = await openWorkspace({ width: 1200, height: 800 });
await page.addInitScript({ content: script });
await page.reload({ waitUntil: "networkidle" });
await page.locator('button[aria-label="Tasks"]').waitFor({ timeout: 15000 });
await page.waitForTimeout(800);

const sample = () =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll("aside div.group.cursor-pointer")].find((r) =>
      r.textContent.trim().startsWith("Chat "),
    );
    const list = row?.closest(".overflow-y-auto");
    return {
      rowLeft: row ? Math.round(row.getBoundingClientRect().left * 10) / 10 : null,
      listScrolls: list ? list.scrollHeight > list.clientHeight : null,
      listClientWidth: list ? list.clientWidth : null,
    };
  });

const report = [];
const heights = [800, 700, 600, 500, 400, 500, 600, 700, 800];
for (const height of heights) {
  await page.setViewportSize({ width: 1200, height });
  await page.waitForTimeout(300);
  report.push({ height, ...(await sample()) });
}
await browser.close();
console.log(report.map((x) => [x.height, x.rowLeft, x.listScrolls, x.listClientWidth].join(" ")).join("\n"));
