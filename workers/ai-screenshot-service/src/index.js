/**
 * ai-screenshot-service — Cloudflare Browser Rendering
 *
 * Takes real screenshots of broker-summary and detail pages using headless Chrome.
 * Stores results in R2 (SSSAHAM_EMITEN) under ai-screenshots/{SYMBOL}/{DATE}_{label}.png
 *
 * Endpoints:
 *   POST /capture           — capture a single screenshot {symbol, date, label, url, selector}
 *   POST /capture/batch     — capture multiple screenshots in one browser session
 *   POST /capture/broker-intraday — legacy compat route
 *   GET  /health
 */

import puppeteer from "@cloudflare/puppeteer";

const SCREENSHOT_VERSION = "v2";

// ── Screenshot target definitions ──
// Given a symbol + base URL, these define the 5 required screenshots
function getScreenshotTargets(symbol, baseUrl = "https://www.sssaham.com") {
  const brokSumUrl = `${baseUrl}/idx/emiten/broker-summary.html?kode=${symbol}`;
  const detailUrl = `${baseUrl}/idx/emiten/detail.html?kode=${symbol}`;

  return [
    {
      label: "smartmoney-chart",
      url: brokSumUrl,
      selector: "#smartmoney-chart-panel",
      waitFor: "#detailChart",
      description: "Smartmoney flow chart (Foreign/Retail/Local cumulative + price)"
    },
    {
      label: "broker-flow-chart",
      url: brokSumUrl,
      selector: "#broker-flow-chart-panel",
      waitFor: "#brokerFlowChart",
      clickBefore: '[data-chart-tab="brokerflow"]',
      description: "Top-N broker cumulative net flow chart"
    },
    {
      label: "zscore-horizon",
      url: brokSumUrl,
      selector: "#zscore-features-card",
      waitFor: "#feat-effort",
      description: "Z-Score 6 cells + Horizon multi-day metrics table"
    },
    {
      label: "broker-table",
      url: brokSumUrl,
      selector: "#broker-table-container",
      waitFor: "#broker-table-container table",
      description: "Buy-side & sell-side broker ranking table"
    },
    {
      label: "intraday-footprint",
      url: detailUrl,
      selector: "#chart-container",
      waitFor: "#footprintChart",
      description: "Intraday footprint bubble chart + volume profile + CVD"
    }
  ];
}

function withCORS(resp) {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(resp.body, { status: resp.status, headers });
}

function json(data, status = 200) {
  return withCORS(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

/**
 * Capture a single screenshot from a page using puppeteer
 */
async function captureScreenshot(browser, { url, selector, waitFor, clickBefore }, timeoutMs = 30000) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

    // Disable animations for instant rendering
    await page.evaluateOnNewDocument(() => {
      const originalRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = function(cb) {
        try { cb(performance.now()); } catch (e) {}
        return 0;
      };
      window.cancelAnimationFrame = function() {};
      document.addEventListener("DOMContentLoaded", () => {
        if (window.jQuery) window.jQuery.fx.off = true;
        if (window.Chart) Chart.defaults.animation = false;
      });
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }";
      document.documentElement.appendChild(style);
    });

    // Navigate and wait for content
    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });

    // Wait for the page to fully render data (detail-view must be visible for broker-summary)
    // The broker-summary auto-navigates to detail when ?kode= is present
    const waitSelector = waitFor || selector;
    await page.waitForSelector(waitSelector, { visible: true, timeout: 15000 }).catch(() => {
      console.warn(`[Screenshot] waitFor '${waitSelector}' timed out, proceeding anyway`);
    });

    // Click to switch tab if needed (e.g., broker flow chart tab)
    if (clickBefore) {
      try {
        await page.waitForSelector(clickBefore, { visible: true, timeout: 5000 });
        await page.click(clickBefore);
        // Wait for the panel to become visible after click
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        await new Promise(r => setTimeout(r, 1500)); // let chart animate
      } catch (clickErr) {
        console.warn(`[Screenshot] clickBefore '${clickBefore}' failed:`, clickErr.message);
      }
    }

    // Extra settle time for charts to render
    await new Promise(r => setTimeout(r, 2000));

    // Capture the specific element
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Selector '${selector}' not found on page`);
    }

    const screenshotBuffer = await element.screenshot({ type: "png" });
    return screenshotBuffer;
  } finally {
    await page.close();
  }
}

/**
 * Capture multiple screenshots from the SAME page URL in one browser session.
 * Groups by URL to minimize page loads.
 */
async function captureBatch(browser, targets, date, symbol, env) {
  const results = [];
  // Group targets by URL to reuse page navigations
  const byUrl = new Map();
  for (const t of targets) {
    if (!byUrl.has(t.url)) byUrl.set(t.url, []);
    byUrl.get(t.url).push(t);
  }

  for (const [url, urlTargets] of byUrl) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      console.log(`[Screenshot] Navigating to ${url}`);

      // Disable all animations/transitions so fadeIn() etc. complete instantly
      await page.evaluateOnNewDocument(() => {
        // 1. Make requestAnimationFrame execute callbacks synchronously
        //    This ensures Chart.js renders immediately instead of waiting for rAF
        const originalRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = function(cb) {
          // Execute synchronously with a simulated timestamp
          try { cb(performance.now()); } catch (e) {}
          return 0;
        };
        window.cancelAnimationFrame = function() {};

        // 2. Disable jQuery animations
        document.addEventListener("DOMContentLoaded", () => {
          if (window.jQuery) window.jQuery.fx.off = true;
          // 3. Disable Chart.js animations globally
          if (window.Chart) {
            Chart.defaults.animation = false;
            Chart.defaults.animations = { colors: false, x: false };
            Chart.defaults.transitions = { active: { animation: { duration: 0 } } };
          }
        });

        // 4. Disable CSS transitions/animations
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; transition-delay: 0s !important; }";
        document.documentElement.appendChild(style);
      });

      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      // ── Smart wait: wait for actual DATA to load, not just DOM elements ──
      // networkidle2 fires after initial resources, but BEFORE JS API calls fetch data.
      // We need to wait for real data indicators.
      if (url.includes("broker-summary")) {
        console.log("[Screenshot] Waiting for broker-summary data to load...");
        // Wait until broker table has actual data rows (means API call returned)
        await page.waitForFunction(() => {
          const rows = document.querySelectorAll("#broker-table-container table tbody tr");
          return rows.length >= 3;
        }, { timeout: 45000 }).catch(() => {
          console.warn("[Screenshot] broker-table rows not found in time");
        });
        // Wait for app to be fully visible (opacity = 1)
        await page.waitForFunction(() => {
          const app = document.getElementById("app");
          return app && getComputedStyle(app).opacity === "1";
        }, { timeout: 10000 }).catch(() => {
          // Force opacity if animation is stuck
          console.warn("[Screenshot] Forcing app opacity to 1");
        });
        // Force full opacity on all containers (belt & suspenders)
        await page.evaluate(() => {
          const app = document.getElementById("app");
          if (app) { app.style.opacity = "1"; app.style.display = "block"; }
          document.querySelectorAll(".chart-container-responsive").forEach(el => {
            el.style.display = "block";
            el.style.opacity = "1";
          });
        });
        console.log("[Screenshot] broker-summary data loaded, settling...");
        await new Promise(r => setTimeout(r, 2000)); // Final settle for Chart.js rAF
      } else if (url.includes("detail.html")) {
        console.log("[Screenshot] Waiting for detail.html data...");
        // Wait for the page to finish loading data (check for chart initialization)
        await page.waitForFunction(() => {
          // The footprint chart container must have canvas content
          const canvas = document.getElementById("footprintChart");
          if (!canvas || canvas.width <= 300) return false; // Still default size
          return true;
        }, { timeout: 45000 }).catch(() => {
          console.warn("[Screenshot] footprintChart not ready in time");
        });
        // Force full opacity
        await page.evaluate(() => {
          const app = document.getElementById("app");
          if (app) { app.style.opacity = "1"; app.style.display = "block"; }
        });
        console.log("[Screenshot] detail.html data loaded, settling...");
        await new Promise(r => setTimeout(r, 2000));
      } else {
        // Generic fallback: wait for #detail-view + settle
        await page.waitForSelector("#detail-view", { visible: true, timeout: 20000 }).catch(() => {
          console.warn("[Screenshot] #detail-view not found, page may still work");
        });
        await new Promise(r => setTimeout(r, 5000));
      }

      for (const target of urlTargets) {
        try {
          // Click to switch if needed
          if (target.clickBefore) {
            try {
              await page.waitForSelector(target.clickBefore, { visible: true, timeout: 5000 });
              await page.click(target.clickBefore);
              // broker-flow-chart is LAZY-LOADED: clicking the tab triggers an API call
              // + Chart.js render. We must wait for the chart canvas to actually draw.
              if (target.label === "broker-flow-chart") {
                console.log("[Screenshot] Waiting for broker-flow-chart lazy load...");
                // Wait for the Chart.js chart to be created (canvas gets resized from default 300x150)
                await page.waitForFunction(() => {
                  const canvas = document.getElementById("brokerFlowChart");
                  return canvas && canvas.width > 300;
                }, { timeout: 20000 }).catch(() => {
                  console.warn("[Screenshot] brokerFlowChart not ready in time");
                });
                await new Promise(r => setTimeout(r, 1500)); // let chart animation settle
              } else {
                await page.waitForSelector(target.selector, { visible: true, timeout: 5000 });
                await new Promise(r => setTimeout(r, 1500)); // let chart animate
              }
            } catch (clickErr) {
              console.warn(`[Screenshot] clickBefore '${target.clickBefore}' failed:`, clickErr.message);
            }
          }

          // Wait for the specific section
          const waitSel = target.waitFor || target.selector;
          await page.waitForSelector(waitSel, { visible: true, timeout: 10000 }).catch(() => {
            console.warn(`[Screenshot] waitFor '${waitSel}' timed out for ${target.label}`);
          });

          const element = await page.$(target.selector);
          if (!element) {
            console.warn(`[Screenshot] Selector '${target.selector}' not found for ${target.label}`);
            results.push({ label: target.label, ok: false, error: `Selector not found: ${target.selector}` });
            continue;
          }

          // Force Chart.js to draw synchronously — chart.render() only schedules rAF
          // which may never fire in headless Chrome. chart.draw() is synchronous.
          await page.evaluate(() => {
            if (window.Chart && Chart.instances) {
              Object.values(Chart.instances).forEach(chart => {
                try { chart.draw(); } catch (e) {}
              });
            }
          });
          await new Promise(r => setTimeout(r, 300));

          // Use page.screenshot with clip instead of element.screenshot
          // element.screenshot() may not capture Canvas pixel content properly
          const box = await element.boundingBox();
          if (!box) {
            console.warn(`[Screenshot] ${target.label}: element has no bounding box`);
            results.push({ label: target.label, ok: false, error: "Element has no bounding box" });
            continue;
          }

          const buf = await page.screenshot({
            type: "png",
            clip: {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height
            }
          });
          const key = `ai-screenshots/${symbol}/${date}_${target.label}.png`;

          await env.SSSAHAM_EMITEN.put(key, buf, {
            httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=86400" },
            customMetadata: {
              symbol, label: target.label, version: SCREENSHOT_VERSION,
              source: "browser-rendering", generated_at: new Date().toISOString()
            }
          });

          console.log(`[Screenshot] ✓ ${target.label}: ${(buf.byteLength / 1024).toFixed(0)} KB → ${key}`);
          results.push({ label: target.label, ok: true, key, size_kb: Math.round(buf.byteLength / 1024) });

          // Switch back to smartmoney tab if we just captured broker flow
          if (target.clickBefore && target.label === "broker-flow-chart") {
            try {
              await page.click('[data-chart-tab="smartmoney"]');
              await new Promise(r => setTimeout(r, 500));
            } catch (_) {}
          }
        } catch (targetErr) {
          console.error(`[Screenshot] ✗ ${target.label}:`, targetErr.message);
          results.push({ label: target.label, ok: false, error: targetErr.message });
        }
      }
    } finally {
      await page.close();
    }
  }

  return results;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }));
    }

    // ── Health check ──
    if (url.pathname === "/health") {
      return json({ ok: true, service: "ai-screenshot-service", version: SCREENSHOT_VERSION });
    }

    // ── POST /capture/batch — capture all 5 screenshots for a symbol ──
    if (request.method === "POST" && url.pathname === "/capture/batch") {
      try {
        const { symbol, date, baseUrl } = await request.json();
        if (!symbol || !date) {
          return json({ ok: false, error: "Missing required fields: symbol, date" }, 400);
        }

        const normalizedSymbol = symbol.toUpperCase();
        const targets = getScreenshotTargets(normalizedSymbol, baseUrl || "https://www.sssaham.com");

        console.log(`[Screenshot] Batch capture for ${normalizedSymbol} on ${date}: ${targets.length} targets`);
        const browser = await puppeteer.launch(env.BROWSER);

        try {
          const results = await captureBatch(browser, targets, date, normalizedSymbol, env);
          const successful = results.filter(r => r.ok);
          const failed = results.filter(r => !r.ok);

          console.log(`[Screenshot] Batch complete: ${successful.length}/${results.length} succeeded`);

          return json({
            ok: true,
            symbol: normalizedSymbol,
            date,
            total: results.length,
            successful: successful.length,
            failed: failed.length,
            results
          });
        } finally {
          await browser.close();
        }
      } catch (error) {
        console.error("[Screenshot] Batch error:", error);
        return json({ ok: false, error: error.message }, 500);
      }
    }

    // ── POST /capture — single screenshot ──
    if (request.method === "POST" && url.pathname === "/capture") {
      try {
        const { symbol, date, label, targetUrl, selector, waitFor, clickBefore } = await request.json();
        if (!symbol || !date || !label) {
          return json({ ok: false, error: "Missing required fields: symbol, date, label" }, 400);
        }

        const normalizedSymbol = symbol.toUpperCase();
        const resolvedUrl = targetUrl || `https://www.sssaham.com/idx/emiten/broker-summary.html?kode=${normalizedSymbol}`;
        const resolvedSelector = selector || "#summary-pane";

        console.log(`[Screenshot] Single capture: ${normalizedSymbol}/${label} from ${resolvedUrl}`);
        const browser = await puppeteer.launch(env.BROWSER);

        try {
          const buf = await captureScreenshot(browser, {
            url: resolvedUrl,
            selector: resolvedSelector,
            waitFor: waitFor || resolvedSelector,
            clickBefore
          });

          const key = `ai-screenshots/${normalizedSymbol}/${date}_${label}.png`;
          await env.SSSAHAM_EMITEN.put(key, buf, {
            httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=86400" },
            customMetadata: {
              symbol: normalizedSymbol, label, version: SCREENSHOT_VERSION,
              source: "browser-rendering", generated_at: new Date().toISOString()
            }
          });

          console.log(`[Screenshot] ✓ ${label}: ${(buf.byteLength / 1024).toFixed(0)} KB → ${key}`);
          return json({ ok: true, key, size_kb: Math.round(buf.byteLength / 1024) });
        } finally {
          await browser.close();
        }
      } catch (error) {
        console.error("[Screenshot] Single capture error:", error);
        return json({ ok: false, error: error.message }, 500);
      }
    }

    // ── POST /capture/broker-intraday — legacy compat ──
    if (request.method === "POST" && url.pathname === "/capture/broker-intraday") {
      try {
        const { symbol, date, label } = await request.json();
        if (!symbol || !date || !label) {
          return json({ ok: false, error: "Missing required fields: symbol, date, label" }, 400);
        }

        const normalizedSymbol = symbol.toUpperCase();
        const targets = getScreenshotTargets(normalizedSymbol);

        console.log(`[Screenshot] Legacy broker-intraday for ${normalizedSymbol}, upgrading to batch capture`);
        const browser = await puppeteer.launch(env.BROWSER);

        try {
          const results = await captureBatch(browser, targets, date, normalizedSymbol, env);
          const firstSuccess = results.find(r => r.ok);

          return json({
            ok: true,
            key: firstSuccess?.key || `ai-screenshots/${normalizedSymbol}/${date}_${label}.png`,
            batch_results: results
          });
        } finally {
          await browser.close();
        }
      } catch (error) {
        console.error("[Screenshot] Legacy capture error:", error);
        return json({ ok: false, error: error.message }, 500);
      }
    }

    return json({ ok: false, error: "Not Found" }, 404);
  }
};

