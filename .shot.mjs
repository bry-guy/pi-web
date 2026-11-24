import { chromium } from "playwright";
const browser = await chromium.launch();
for (const [name, vp, open] of [["closed", { width: 1280, height: 860 }, false], ["open", { width: 1280, height: 860 }, true], ["mobile", { width: 390, height: 844 }, false]]) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1 });
  await page.goto("http://localhost:3199/");
  await page.waitForTimeout(1200);
  await page.evaluate(async open => {
    const { store } = await import("/js/store.js");
    store.state.projects.push({ id: "pp-eco", kind: "folder", name: "pi-web-ecosystem", group: "pi-web-ecosystem", branches: [], contexts: [{ id: "folder", kind: "folder", branch: null, path: "/w/eco" }], sessions: [{ id: "f1", title: "project-development", when: "1m", contextId: "folder", children: [] }] });
    const runs = ["Finish pi-sync PR #5 (`bry-guy/pi-sync`, branch…", "Fix review findings on three open PRs, each on branc", "Build \"primes, part 1\" in pi-web. PR only: do NOT me"].map((t, i) => ({ sessionId: "r" + i, title: "pi-web-developer: " + t, repo: null, device: "macbookpro", when: (i + 2) + "h" }));
    for (let i = 0; i < 25; i++) runs.push({ sessionId: "o" + i, title: "You are running as role pi-web/pi-web-developer for project pi-web-ecosystem", repo: null, device: "brainbook-m1", when: (i + 1) + "d" });
    store.set({ projectMenu: { projectId: "group:pi-web-ecosystem", roleRunsOpen: open, synced: [{ sessionId: "p", title: "primes-impl", repo: null, device: "macbookpro", when: "5m" }, { sessionId: "u", title: "ui-audit", repo: null, device: "web-pi-web-ecosystem", when: "3h" }, ...runs] } });
  }, open);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/Users/brain/.pi/agent/pi-projects/pi-web-ecosystem/artifacts/scratch/role-runs/" + name + ".png" });
  await page.close();
}
await browser.close();
