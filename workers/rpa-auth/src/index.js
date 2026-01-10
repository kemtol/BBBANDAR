import puppeteer from "@cloudflare/puppeteer";

// CORS headers helper
function corsHeaders(contentType = null) {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (contentType) {
        headers["Content-Type"] = contentType;
    }
    return headers;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Manual Trigger: /login
        if (path === "/login" && request.method === "POST") {
            try {
                const token = await refreshStockbitToken(env);
                return new Response(JSON.stringify({ ok: true, token_preview: token.substring(0, 20) + "..." }), {
                    headers: { "Content-Type": "application/json" }
                });
            } catch (err) {
                return new Response(JSON.stringify({ ok: false, error: err.message, stack: err.stack }), { status: 500 });
            }
        }

        // Test Browser: /test-browser
        if (path === "/test-browser") {
            try {
                const browser = await puppeteer.launch(env.BROWSER);
                const page = await browser.newPage();
                await page.goto("https://stockbit.com");
                const title = await page.title();
                await browser.close();
                return new Response(JSON.stringify({ ok: true, title }), {
                    headers: { "Content-Type": "application/json" }
                });
            } catch (err) {
                return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
            }
        }

        // Debug Login with Screenshot: /login-debug
        if (path === "/login-debug" && request.method === "POST") {
            try {
                const result = await debugStockbitLogin(env);
                return new Response(JSON.stringify(result), {
                    headers: corsHeaders("application/json")
                });
            } catch (err) {
                return new Response(JSON.stringify({ ok: false, error: err.message, stack: err.stack }), {
                    status: 500,
                    headers: corsHeaders("application/json")
                });
            }
        }

        // CORS Preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders() });
        }

        // GET /token-info - Check token availability and info
        if (path === "/token-info" && request.method === "GET") {
            try {
                const stored = await env.SSSAHAM_WATCHLIST.get("STOCKBIT_TOKEN");
                if (!stored) {
                    return new Response(JSON.stringify({ ok: true, token_exists: false }), {
                        headers: corsHeaders("application/json")
                    });
                }
                const data = JSON.parse(stored);
                return new Response(JSON.stringify({
                    ok: true,
                    token_exists: true,
                    token_preview: data.access_token ? data.access_token.substring(0, 20) + "..." : "N/A",
                    updated_at: data.updated_at,
                    token_length: data.access_token ? data.access_token.length : 0
                }), {
                    headers: corsHeaders("application/json")
                });
            } catch (err) {
                return new Response(JSON.stringify({ ok: false, error: err.message }), {
                    status: 500,
                    headers: corsHeaders("application/json")
                });
            }
        }

        // POST /update-token - Manually update token and trigger full flow
        if (path === "/update-token" && request.method === "POST") {
            try {
                const body = await request.json();
                const token = body.token;
                const triggerBackfill = body.triggerBackfill !== false; // default true

                if (!token || token.trim().length === 0) {
                    return new Response(JSON.stringify({ ok: false, error: "Token is required" }), {
                        status: 400,
                        headers: corsHeaders("application/json")
                    });
                }

                // 1. Save token to KV
                const kvValue = {
                    updated_at: new Date().toISOString(),
                    access_token: token.trim(),
                };
                await env.SSSAHAM_WATCHLIST.put("STOCKBIT_TOKEN", JSON.stringify(kvValue));
                console.log("Token saved to KV");

                // 2. Broadcast to LiveTrade Taping
                try {
                    const tapingUrl = "https://livetrade-taping.mkemalw.workers.dev/update?token=" + encodeURIComponent(token.trim());
                    await fetch(tapingUrl);
                    console.log("LiveTrade Taping updated");
                } catch (e) {
                    console.error("Failed to broadcast to taping:", e);
                }

                // 3. Trigger full flow via service binding (update watchlist + 90-day backfill)
                let flowResult = null;
                if (triggerBackfill && env.BROKSUM_SCRAPPER) {
                    try {
                        console.log("Triggering full flow via service binding...");
                        const flowResponse = await env.BROKSUM_SCRAPPER.fetch(
                            new Request("https://broksum-scrapper/trigger-full-flow?days=90", { method: "GET" })
                        );
                        flowResult = await flowResponse.json();
                        console.log("Full flow triggered:", flowResult);
                    } catch (e) {
                        console.error("Failed to trigger full flow:", e);
                        flowResult = { error: e.message };
                    }
                }

                return new Response(JSON.stringify({
                    ok: true,
                    message: "Token updated successfully",
                    token_preview: token.substring(0, 20) + "...",
                    flow_triggered: triggerBackfill,
                    flow_result: flowResult
                }), {
                    headers: corsHeaders("application/json")
                });
            } catch (err) {
                return new Response(JSON.stringify({ ok: false, error: err.message }), {
                    status: 500,
                    headers: corsHeaders("application/json")
                });
            }
        }

        // GET /verify-token - Test token against Stockbit API
        if (path === "/verify-token" && request.method === "GET") {
            try {
                const stored = await env.SSSAHAM_WATCHLIST.get("STOCKBIT_TOKEN");
                if (!stored) {
                    return new Response(JSON.stringify({ ok: false, error: "No token stored" }), {
                        status: 400,
                        headers: corsHeaders("application/json")
                    });
                }

                const data = JSON.parse(stored);
                const token = data.access_token;

                // Test with Stockbit API - get user profile or watchlist
                const testResponse = await fetch("https://api.stockbit.com/v2.4/watchlist/list", {
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Content-Type": "application/json"
                    }
                });

                if (testResponse.ok) {
                    const result = await testResponse.json();
                    return new Response(JSON.stringify({
                        ok: true,
                        message: "Token is valid!",
                        watchlist_count: result.data ? result.data.length : 0
                    }), {
                        headers: corsHeaders("application/json")
                    });
                } else {
                    const errorText = await testResponse.text();
                    return new Response(JSON.stringify({
                        ok: false,
                        error: `API returned ${testResponse.status}`,
                        details: errorText.substring(0, 200)
                    }), {
                        status: 400,
                        headers: corsHeaders("application/json")
                    });
                }
            } catch (err) {
                return new Response(JSON.stringify({ ok: false, error: err.message }), {
                    status: 500,
                    headers: corsHeaders("application/json")
                });
            }
        }

        return new Response("RPA Auth Worker Ready. Endpoints: POST /login, POST /login-debug, GET /test-browser, GET /token-info, POST /update-token, GET /verify-token", {
            status: 200,
            headers: corsHeaders("text/plain")
        });
    },

    async scheduled(event, env, ctx) {
        console.log("⏰ Cron Triggered at 19:00 WIB: Checking token validity...");

        try {
            // 1. Check if token exists
            const stored = await env.SSSAHAM_WATCHLIST.get("STOCKBIT_TOKEN");
            if (!stored) {
                console.log("❌ No token found - waiting for manual input");
                return;
            }

            const data = JSON.parse(stored);
            const token = data.access_token;

            // 2. Verify token is still valid
            const testResponse = await fetch("https://api.stockbit.com/v2.4/watchlist/list", {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                }
            });

            if (!testResponse.ok) {
                console.log("❌ Token invalid or expired - waiting for manual input");
                return;
            }

            console.log("✅ Token is valid! Triggering daily crawl...");

            // 3. Trigger broksum-scrapper via service binding for yesterday's data only
            if (env.BROKSUM_SCRAPPER) {
                try {
                    // First update watchlist
                    const watchlistResp = await env.BROKSUM_SCRAPPER.fetch(
                        new Request("https://broksum-scrapper/update-watchlist", { method: "GET" })
                    );
                    const watchlistResult = await watchlistResp.json();
                    console.log("Watchlist updated:", watchlistResult);

                    // Then scrape yesterday's data
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    const dateStr = yesterday.toISOString().split("T")[0];

                    const scrapeResp = await env.BROKSUM_SCRAPPER.fetch(
                        new Request(`https://broksum-scrapper/scrape?date=${dateStr}`, { method: "GET" })
                    );
                    const scrapeResult = await scrapeResp.json();
                    console.log("Daily scrape triggered:", scrapeResult);

                } catch (e) {
                    console.error("Failed to trigger crawl:", e);
                }
            }

        } catch (err) {
            console.error("Scheduled job error:", err);
        }
    }
};

async function refreshStockbitToken(env) {
    const username = env.ST_USERNAME;
    const password = env.ST_PASSWORD;

    if (!username || !password) {
        throw new Error("Missing Stockbit Credentials (ST_USERNAME/ST_PASSWORD).");
    }

    console.log(`Launching browser to login as ${username}...`);

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
        // Navigate to Stockbit Login Page
        await page.goto("https://stockbit.com/login", { waitUntil: "networkidle2" });

        // Fill in credentials using exact IDs from Stockbit login form
        await page.waitForSelector('#username', { visible: true, timeout: 10000 });
        await page.type('#username', username, { delay: 50 });
        await page.type('#password', password, { delay: 50 });

        // Small delay to let form validation complete
        await new Promise(r => setTimeout(r, 1000));

        // Click login button and wait for navigation
        await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
            page.click('#email-login-button')
        ]);

        // Verify we're no longer on login page
        const currentUrl = page.url();
        if (currentUrl.includes('/login')) {
            // Take screenshot for debugging if still on login
            throw new Error(`Login failed - still on login page: ${currentUrl}. May need CAPTCHA or credentials are incorrect.`);
        }

        // Extract token from localStorage or cookies
        const token = await page.evaluate(() => {
            // Try trustedDevice localStorage (Stockbit pattern)
            const trustedDevice = localStorage.getItem("trustedDevice");
            if (trustedDevice) {
                try {
                    const parsed = JSON.parse(trustedDevice);
                    if (parsed.token) return parsed.token;
                    if (parsed.login_token) return parsed.login_token;
                } catch (e) { }
            }

            // Try common localStorage keys
            const localToken = localStorage.getItem("access_token")
                || localStorage.getItem("token")
                || localStorage.getItem("sb_token")
                || localStorage.getItem("authToken");
            if (localToken) return localToken;

            // Try to find any key containing 'token' in localStorage
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.toLowerCase().includes('token')) {
                    const val = localStorage.getItem(key);
                    if (val && val.length > 20) return val;
                }
            }

            return null;
        });

        // If no token in localStorage, try extracting from cookies (including HttpOnly)
        let finalToken = token;
        if (!finalToken) {
            const cookies = await page.cookies();
            // Look for auth-related cookies
            const authCookie = cookies.find(c =>
                c.name === 'access_token' ||
                c.name === 'sb_token' ||
                c.name === 'token' ||
                c.name === 'session' ||
                c.name === 'connect.sid' ||
                c.name.toLowerCase().includes('auth')
            );
            if (authCookie) {
                finalToken = authCookie.value;
            }
        }

        if (!finalToken) {
            // Log all available storage for debugging
            const debugInfo = await page.evaluate(() => {
                const keys = [];
                for (let i = 0; i < localStorage.length; i++) {
                    keys.push(localStorage.key(i));
                }
                return { localStorageKeys: keys, currentUrl: window.location.href };
            });
            const allCookies = await page.cookies();
            throw new Error(`Login succeeded but no token found. LocalStorage keys: ${debugInfo.localStorageKeys.join(', ')}. Cookies: ${allCookies.map(c => c.name).join(', ')}. URL: ${debugInfo.currentUrl}`);
        }

        console.log("Login Success! Saving token to KV...");

        // Save to KV
        const kvValue = {
            updated_at: new Date().toISOString(),
            access_token: finalToken,
        };
        await env.SSSAHAM_WATCHLIST.put("STOCKBIT_TOKEN", JSON.stringify(kvValue));

        // Broadcast to LiveTrade Taping
        try {
            const tapingUrl = "https://livetrade-taping.mkemalw.workers.dev/update?token=" + encodeURIComponent(finalToken);
            await fetch(tapingUrl);
            console.log("LiveTrade Taping updated.");
        } catch (err) {
            console.error("Failed to update LiveTrade Taping:", err);
        }

        return finalToken;

    } finally {
        await browser.close();
    }
}

// Debug function to capture screenshots during login
async function debugStockbitLogin(env) {
    const username = env.ST_USERNAME;
    const password = env.ST_PASSWORD;

    const result = {
        ok: false,
        steps: [],
        screenshots: {}
    };

    if (!username || !password) {
        result.error = "Missing Stockbit Credentials (ST_USERNAME/ST_PASSWORD).";
        return result;
    }

    result.steps.push(`Using username: ${username}`);

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
        // Anti-detection: Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        result.steps.push("Set realistic user agent");

        // Anti-detection: Set realistic viewport
        await page.setViewport({ width: 1920, height: 1080 });
        result.steps.push("Set viewport 1920x1080");

        // Anti-detection: Override navigator properties to hide headless
        await page.evaluateOnNewDocument(() => {
            // Override webdriver property
            Object.defineProperty(navigator, 'webdriver', { get: () => false });

            // Override plugins (headless has empty plugins)
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });

            // Override languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en', 'id']
            });

            // Override platform
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32'
            });

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });
        result.steps.push("Applied stealth overrides");

        // Step 1: Navigate to login page
        await page.goto("https://stockbit.com/login", { waitUntil: "networkidle2" });
        result.steps.push("Navigated to login page");

        // Random delay to simulate human
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

        // Capture screenshot before login
        const beforeScreenshot = await page.screenshot({ encoding: 'base64' });
        result.screenshots.before_login = beforeScreenshot;
        result.steps.push("Captured before-login screenshot");

        // Step 2: Wait for form and fill credentials
        await page.waitForSelector('#username', { visible: true, timeout: 10000 });
        result.steps.push("Found #username field");

        await page.type('#username', username, { delay: 50 });
        result.steps.push("Typed username");

        await page.type('#password', password, { delay: 50 });
        result.steps.push("Typed password");

        // Capture screenshot after typing
        const afterTypingScreenshot = await page.screenshot({ encoding: 'base64' });
        result.screenshots.after_typing = afterTypingScreenshot;
        result.steps.push("Captured after-typing screenshot");

        // Small delay
        await new Promise(r => setTimeout(r, 1000));

        // Step 3: Click login
        result.steps.push("Clicking login button...");

        // Click and wait with timeout
        try {
            // Simulate mouse movement to button
            const button = await page.$('#email-login-button');
            const box = await button.boundingBox();
            if (box) {
                // Move mouse to button with some randomness
                await page.mouse.move(box.x + box.width / 2 + Math.random() * 10, box.y + box.height / 2 + Math.random() * 5);
                await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
                result.steps.push("Moved mouse to login button");
            }

            await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
                page.click('#email-login-button')
            ]);
            result.steps.push("Navigation completed after click");
        } catch (navErr) {
            result.steps.push(`Navigation error: ${navErr.message}`);
        }

        // Capture final screenshot
        const afterLoginScreenshot = await page.screenshot({ encoding: 'base64' });
        result.screenshots.after_login = afterLoginScreenshot;
        result.steps.push("Captured after-login screenshot");

        // Get current URL
        result.currentUrl = page.url();
        result.steps.push(`Current URL: ${result.currentUrl}`);

        // Check if login succeeded
        if (!result.currentUrl.includes('/login')) {
            result.ok = true;
            result.steps.push("LOGIN SUCCESS - Not on login page anymore");
        } else {
            result.steps.push("Still on login page - login may have failed");

            // Check for error messages on page
            const errorMsg = await page.evaluate(() => {
                const errorEl = document.querySelector('.ant-message-error, .error-message, [class*="error"]');
                return errorEl ? errorEl.textContent : null;
            });
            if (errorMsg) {
                result.errorMessage = errorMsg;
                result.steps.push(`Error message found: ${errorMsg}`);
            }
        }

        return result;

    } catch (err) {
        result.error = err.message;
        result.stack = err.stack;

        // Try to capture error screenshot
        try {
            const errorScreenshot = await page.screenshot({ encoding: 'base64' });
            result.screenshots.error = errorScreenshot;
        } catch (e) { }

        return result;
    } finally {
        await browser.close();
    }
}
