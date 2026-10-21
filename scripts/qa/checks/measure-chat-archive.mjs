// Reports where the sidebar rows sit before and after archiving the first projectless chat,
// with and without that chat selected. Adds two chats without a project to the stub's list.
import { openWorkspace } from "../lib/open.mjs";

const chat = (id, title) => ({
  id,
  projectId: null,
  title,
  agent: "claude",
  model: null,
  accessMode: "full-access",
  effort: null,
  sessionId: null,
  createdAt: Date.now() - 2000,
  messages: [],
  goal: null,
  folderId: null,
  archivedAt: null,
});
const extra = [chat("qa-chat-1", "First chat"), chat("qa-chat-2", "Second chat")];
// Runs after the stub, so it wraps the stub's invoke and appends the chats to list_threads.
const script = `(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const extra = ${JSON.stringify(extra)};
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    const r = await invoke(cmd, args);
    return cmd === "list_threads" ? [...r, ...extra] : r;
  };
})();`;

async function measure(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector("aside div.overflow-y-auto");
    const rows = [...document.querySelectorAll("aside div.group.cursor-pointer")].map((r) => ({
      key: r.textContent.trim().slice(0, 24),
      top: Math.round(r.getBoundingClientRect().top),
    }));
    return { scrollTop: scroller ? Math.round(scroller.scrollTop) : null, rows };
  });
}

async function run(label, { select }) {
  const { browser, page } = await openWorkspace();
  await page.addInitScript({ content: script });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('button[aria-label="Tasks"]').waitFor({ timeout: 15000 });
  if (select) await page.getByText("First chat", { exact: true }).click();
  await page.waitForTimeout(300);
  const before = await measure(page);
  // Samples the rows below the first chat on every frame, from just before the click.
  const sampling = page.evaluate(
    () =>
      new Promise((resolve) => {
        const find = (text) =>
          [...document.querySelectorAll("aside div.group.cursor-pointer")].find((r) =>
            r.textContent.trim().startsWith(text),
          );
        const second = find("Second chat");
        const other = find("Other");
        const t0 = performance.now();
        const out = [];
        const step = () => {
          const t = performance.now() - t0;
          out.push({
            t: Math.round(t),
            second: Math.round(second.getBoundingClientRect().top),
            other: Math.round(other.getBoundingClientRect().top),
          });
          if (t < 500) requestAnimationFrame(step);
          else resolve(out);
        };
        requestAnimationFrame(step);
      }),
  );
  await page
    .locator("aside div.group", { hasText: "First chat" })
    .first()
    .locator('button[aria-label="Archive"]')
    .click();
  const frames = await sampling;
  await page.waitForTimeout(300);
  const after = await measure(page);
  await browser.close();

  console.log(`\n${label}  (scrollTop ${before.scrollTop} -> ${after.scrollTop})`);
  console.log("frames  second chat  other project  (every 4th frame)");
  frames
    .filter((_, i) => i % 4 === 0)
    .forEach((f) => console.log(`${String(f.t).padStart(6)}  ${String(f.second).padStart(11)}  ${String(f.other).padStart(13)}`));
  console.log("row".padEnd(26) + "before".padStart(8) + "after".padStart(8) + "delta".padStart(8));
  for (const r of before.rows) {
    const next = after.rows.find((a) => a.key === r.key);
    const delta = next ? next.top - r.top : null;
    console.log(
      r.key.padEnd(26) +
        String(r.top).padStart(8) +
        (next ? String(next.top).padStart(8) : "gone".padStart(8)) +
        (delta === null ? "".padStart(8) : String(delta).padStart(8)),
    );
  }
}

await run("A: first chat not selected", { select: false });
await run("B: first chat selected", { select: true });
