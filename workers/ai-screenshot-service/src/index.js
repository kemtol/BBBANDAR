/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const SCREENSHOT_VERSION = "v1";

// A mock function to simulate taking a screenshot with a headless browser
async function takeScreenshot(url, selector) {
    // In a real implementation, this would use Puppeteer, Playwright, or a similar library.
    // For this example, we'll return a dummy image.
    console.log(`[Screenshot] Simulating screenshot of ${selector} from ${url}`);

    // Create a dummy 10x10 red PNG image
    const png = Uint8Array.from(atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAAXNSR0IArs4c6QAAADNJREFUGJWtkEEKACEIA/8p/v9v7g5kIAWJcTrlQpLSJR3TMAwDMMxERf0AzGRAA/RO8vtb9nRrR/LVL/cAAAAASUVORK5CYII='
    ), c => c.charCodeAt(0));

    return new Response(png, {
        headers: { 'Content-Type': 'image/png' }
    }).arrayBuffer();
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'POST' && url.pathname === '/capture/broker-intraday') {
            try {
                const { symbol, date, label } = await request.json();

                if (!symbol || !date || !label) {
                    return new Response(JSON.stringify({ ok: false, error: 'Missing required fields: symbol, date, label' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }

                const targetUrl = `https://www.sssaham.com/idx/emiten/detail.html?kode=${symbol.toUpperCase()}`;
                const selector = '#summary-pane'; // As per the plan

                console.log(`[Screenshot] Capturing intraday for ${symbol} on ${date}`);

                const imageBuffer = await takeScreenshot(targetUrl, selector);

                const ext = 'png';
                const key = `ai-screenshots/${symbol.toUpperCase()}/${date}_${label}.${ext}`;

                await env.SSSAHAM_EMITEN.put(key, imageBuffer, {
                    httpMetadata: {
                        contentType: 'image/png',
                        cacheControl: 'public, max-age=86400', // 24 hours
                    },
                    customMetadata: {
                        symbol: symbol.toUpperCase(),
                        label: label,
                        version: SCREENSHOT_VERSION,
                        source: 'intraday-interceptor',
                        generated_at: new Date().toISOString(),
                    },
                });

                console.log(`[Screenshot] Uploaded to ${key}`);

                return new Response(JSON.stringify({ ok: true, key }), {
                    headers: { 'Content-Type': 'application/json' },
                });

            } catch (error) {
                console.error('[Screenshot] Error:', error);
                return new Response(JSON.stringify({ ok: false, error: error.message }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
};
