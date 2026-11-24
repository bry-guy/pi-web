import { chromium } from "playwright";
const [url, out, mobile, cat, dark] = process.argv.slice(2);
const providers = [
  { id: "anthropic", name: "Anthropic", configured: true, source: "stored", sourceLabel: "Claude Pro/Max", authType: "oauth", authMethods: [{ id: "oauth", label: "Anthropic (Claude Pro/Max)", subscription: true }, { id: "api_key", label: "Anthropic API key", subscription: false }], availableModels: 18, canLogout: true, error: null },
  { id: "openai-codex", name: "OpenAI Codex", configured: true, source: "stored", sourceLabel: "ChatGPT Plus/Pro", authType: "oauth", authMethods: [{ id: "oauth", label: "ChatGPT Plus/Pro (Codex Subscription)", subscription: true }], availableModels: 10, canLogout: true, error: null },
  { id: "openai", name: "OpenAI", configured: false, source: null, sourceLabel: null, authType: null, authMethods: [{ id: "oauth", label: "OpenAI (ChatGPT subscription)", subscription: true }, { id: "api_key", label: "OpenAI API key", subscription: false }], availableModels: 0, canLogout: false, error: null },
  { id: "antigravity", name: "Antigravity", configured: false, source: null, sourceLabel: null, authType: null, authMethods: [{ id: "oauth", label: "Antigravity", subscription: true }], availableModels: 0, canLogout: false, error: null },
];
const browser = await chromium.launch();
const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 860 } });
await page.route("**/api/state", async route => { const r = await route.fetch(); const j = await r.json(); j.providers = providers; await route.fulfill({ response: r, json: j }); });
if (dark) await page.emulateMedia({ colorScheme: "dark" });
await page.goto(url + "/#settings/" + (cat || "providers"));
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
