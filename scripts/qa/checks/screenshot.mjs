// Saves a screenshot of the whole workspace, or of one element when a selector is given.
// Usage: node checks/screenshot.mjs <out.png> [selector]
import { openWorkspace } from "../lib/open.mjs";

const [out, selector] = process.argv.slice(2);
if (!out) throw new Error("Usage: node checks/screenshot.mjs <out.png> [selector]");

const { browser, page } = await openWorkspace();
if (selector) await page.locator(selector).first().screenshot({ path: out });
else await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}`);
