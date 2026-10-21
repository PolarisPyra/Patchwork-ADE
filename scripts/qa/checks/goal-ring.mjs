// Gives one stub task an active goal, then reports the sidebar ring's computed style and saves
// a screenshot of the sidebar. Usage: node checks/goal-ring.mjs <out.png>
import { openWorkspace } from "../lib/open.mjs";

const [out = "/tmp/goal-ring.png"] = process.argv.slice(2);
// Runs after the stub, so it wraps the stub's invoke and sets a goal on qa-idle.
const script = `(() => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const goal = { objective: "Keep the stripe aligned", status: "active", startedAt: Date.now(), checks: null, tokensUsed: null, tokenBudget: null, timeUsedSeconds: null };
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    const r = await invoke(cmd, args);
    if (cmd !== "list_threads") return r;
    return r.map((t) => (t.id === "qa-idle" ? { ...t, goal } : t));
  };
})();`;

const { browser, page } = await openWorkspace({ width: 1200, height: 800 });
await page.addInitScript({ content: script });
await page.reload({ waitUntil: "networkidle" });
await page.locator('button[aria-label="Tasks"]').waitFor({ timeout: 15000 });

const styles = await page.evaluate(() => {
  const row = (text) =>
    [...document.querySelectorAll("aside div.group.cursor-pointer")].find((r) =>
      r.textContent.trim().startsWith(text),
    );
  const info = (el) => {
    const s = getComputedStyle(el, "::after");
    return {
      classes: el.className.includes("goal-ring"),
      content: s.content,
      animationName: s.animationName,
      maskComposite: s.maskComposite || s.webkitMaskComposite,
      backgroundImage: s.backgroundImage.slice(0, 40),
    };
  };
  return {
    goalRow: info(row("Fix the stripe alignment")),
    plainRow: info(row("Refactor the diff view")),
  };
});
console.log(JSON.stringify(styles, null, 2));

await page.locator("aside").first().screenshot({ path: out });
await browser.close();
console.log(`saved ${out}`);
