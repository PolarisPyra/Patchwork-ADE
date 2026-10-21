// Reports the first project row's height, the gaps around its name, and the gap to its first child row.
import { openWorkspace } from "../lib/open.mjs";

const { browser, page } = await openWorkspace();
const row = await page.locator("div.min-h-9.cursor-pointer").first().evaluate((el) => {
  const box = (e) => e.getBoundingClientRect();
  const top = box(el).top;
  const bottom = box(el).bottom;
  const left = box(el).left;
  const name = [...el.querySelectorAll("span")].find((s) => s.classList.contains("font-medium"));
  const icons = [...el.querySelectorAll(":scope > span:first-child")].map((e) => box(e));
  const nameBox = box(name);
  return {
    height: bottom - top,
    topToName: nameBox.top - top,
    bottomToName: bottom - nameBox.bottom,
    leftToCaret: icons[0].left - left,
    headerToChild: box(el.nextElementSibling.querySelector(".gap-px > *")).top - bottom,
  };
});
await browser.close();

console.log(`row height ${row.height.toFixed(2)}px`);
console.log(`name: top gap ${row.topToName.toFixed(2)}px, bottom gap ${row.bottomToName.toFixed(2)}px`);
console.log(`caret left gap ${row.leftToCaret.toFixed(2)}px`);
console.log(`header to first child gap ${row.headerToChild.toFixed(2)}px`);
