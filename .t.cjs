const { chromium } = require("@playwright/test");
(async () => {
 for (const args of [[], ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote","--single-process"]]) {
  try { const b = await chromium.launch({ args }); const c = await b.newContext({ ignoreHTTPSErrors: true }); const p = await c.newPage(); await p.goto("https://localhost:8787/"); await p.screenshot({ path: "/tmp/t.png" }); console.log("ok", JSON.stringify(args)); await b.close(); }
  catch (e) { console.log("fail", JSON.stringify(args), String(e).slice(0, 300)); }
 }
})();
