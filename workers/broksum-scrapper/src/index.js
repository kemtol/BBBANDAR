export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // ROUTE 1: Update Watchlist (Fetch from Templates -> Save to KV)
            if (path === "/update-watchlist") {
                return await this.updateWatchlist(env);
            }

            // ROUTE 2: Trigger Scraping (Read KV -> Dispatch to Queue)
            if (path === "/scrape") {
                let date = url.searchParams.get("date");
                // Default to yesterday if date not provided
                if (!date) {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    date = yesterday.toISOString().split("T")[0]; // YYYY-MM-DD
                }
                return await this.dispatchScrapeJobs(env, date);
            }

            return new Response("Not Found", { status: 404 });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
    },

    // Helper: Update Watchlist
    async updateWatchlist(env) {
        const TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjU3MDc0NjI3LTg4MWItNDQzZC04OTcyLTdmMmMzOTNlMzYyOSIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7InVzZSI6ImtlbXRvbCIsImVtYSI6Im1rZW1hbHdAZ21haWwuY29tIiwiZnVsIjoiTXVzdGFmYSBLZW1hbCBXaXJ5YXdhbiIsInNlcyI6IiIsImR2YyI6IjVjZjJmZjljM2JkMjFhYzFmYmZhNTZiNGE1MjE4YWJhIiwiZGlkIjoiZGVza3RvcCIsInVpZCI6MjMwNTM1MCwiY291IjoiSUQifSwiZXhwIjoxNzY3MTgyNDA5LCJpYXQiOjE3NjcwOTYwMDksImlzcyI6IlNUT0NLQklUIiwianRpIjoiMDY3Mjg1YjAtYjgxMy00NjZlLTk5ZWMtZjBhOGJjYzNhZmRlIiwibmJmIjoxNzY3MDk2MDA5LCJ2ZXIiOiJ2MSJ9.MeM21u4oWbfoa90-QZZTa-0bNvqqUFHxjyjHmFq84GaUO0mzQEKKZlQScUbbdKbmOb9gRkyEAK1zFTn_UEWo_nQBStDgNvycAH6CMGz5PQ5L49vQIav-fGVy1YmiDntVV3jx6ge1oHhTzBFnU2VsUCB1ydftWlZyYqWt74TfC8ntaELaTWgG3oJOKhZ9f1GvKGdMxbF9hAlFzZx9sGMehE9Zc6Xgy6mv4l-CmZPBHgTWm7o50wG_p-5cL0tvSSr7yYgYz_MlNHU8v6xJ8UOlG27RIRyyfhw5z4OTfU_QikYQ1N0xrKUd66xtlFIkx7eOwHk365VHrhhIRLclCSHv0Q";
        const TEMPLATE_IDS = [97, 96, 92, 106, 63, 108];
        const uniqueSymbols = new Set();
        const errors = [];

        console.log("Starting watchlist update...");

        await Promise.all(TEMPLATE_IDS.map(async (id) => {
            const url = `https://exodus.stockbit.com/screener/templates/${id}?type=1&limit=50`;
            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        "Host": "exodus.stockbit.com",
                        "Connection": "keep-alive",
                        "X-Platform": "desktop",
                        "Authorization": `Bearer ${TOKEN}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                        "Accept": "application/json"
                    }
                });

                if (!response.ok) {
                    console.error(`Failed to fetch template ${id}: ${response.status}`);
                    errors.push(`Template ${id} failed: ${response.status}`);
                    return;
                }

                const data = await response.json();
                if (data && data.data && data.data.calcs) {
                    for (const item of data.data.calcs) {
                        if (item.company && item.company.symbol) {
                            uniqueSymbols.add(item.company.symbol);
                        }
                    }
                }
            } catch (err) {
                console.error(`Error fetching template ${id}:`, err);
                errors.push(`Template ${id} error: ${err.message}`);
            }
        }));

        const watchlist = Array.from(uniqueSymbols).sort();

        const output = {
            updated_at: new Date().toISOString(),
            total_symbols: watchlist.length,
            watchlist: watchlist,
            errors: errors
        };

        // Save to KV
        if (env.SSSAHAM_WATCHLIST) {
            await env.SSSAHAM_WATCHLIST.put("LATEST", JSON.stringify(output));
        } else {
            console.warn("KV namespace SSSAHAM_WATCHLIST is not bound.");
            errors.push("KV namespace SSSAHAM_WATCHLIST is not bound.");
        }

        return new Response(JSON.stringify({
            message: "Watchlist updated successfully",
            data: output
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    // Helper: Dispatch Scrape Jobs
    async dispatchScrapeJobs(env, date) {
        console.log(`Triggered scraping for date: ${date}`);

        // 1. Get Watchlist from KV
        const watchlistData = await env.SSSAHAM_WATCHLIST.get("LATEST", { type: "json" });
        if (!watchlistData || !watchlistData.watchlist) {
            return new Response("Watchlist not found in KV. Please run /update-watchlist first.", { status: 404 });
        }

        const watchlist = watchlistData.watchlist;

        // 2. Dispatch to Queue
        const messages = watchlist.map(symbol => ({
            body: { symbol, date }
        }));

        const chunkSize = 50;
        for (let i = 0; i < messages.length; i += chunkSize) {
            const chunk = messages.slice(i, i + chunkSize);
            await env.SSSAHAM_QUEUE.sendBatch(chunk);
        }

        return new Response(JSON.stringify({
            message: `Dispatched ${watchlist.length} jobs to queue`,
            date: date,
            total_batches: Math.ceil(watchlist.length / chunkSize)
        }), {
            headers: { "Content-Type": "application/json" }
        });
    },

    async queue(batch, env) {
        const TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjU3MDc0NjI3LTg4MWItNDQzZC04OTcyLTdmMmMzOTNlMzYyOSIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7InVzZSI6ImtlbXRvbCIsImVtYSI6Im1rZW1hbHdAZ21haWwuY29tIiwiZnVsIjoiTXVzdGFmYSBLZW1hbCBXaXJ5YXdhbiIsInNlcyI6IiIsImR2YyI6IjVjZjJmZjljM2JkMjFhYzFmYmZhNTZiNGE1MjE4YWJhIiwiZGlkIjoiZGVza3RvcCIsInVpZCI6MjMwNTM1MCwiY291IjoiSUQifSwiZXhwIjoxNzY3MTgyNDA5LCJpYXQiOjE3NjcwOTYwMDksImlzcyI6IlNUT0NLQklUIiwianRpIjoiMDY3Mjg1YjAtYjgxMy00NjZlLTk5ZWMtZjBhOGJjYzNhZmRlIiwibmJmIjoxNzY3MDk2MDA5LCJ2ZXIiOiJ2MSJ9.MeM21u4oWbfoa90-QZZTa-0bNvqqUFHxjyjHmFq84GaUO0mzQEKKZlQScUbbdKbmOb9gRkyEAK1zFTn_UEWo_nQBStDgNvycAH6CMGz5PQ5L49vQIav-fGVy1YmiDntVV3jx6ge1oHhTzBFnU2VsUCB1ydftWlZyYqWt74TfC8ntaELaTWgG3oJOKhZ9f1GvKGdMxbF9hAlFzZx9sGMehE9Zc6Xgy6mv4l-CmZPBHgTWm7o50wG_p-5cL0tvSSr7yYgYz_MlNHU8v6xJ8UOlG27RIRyyfhw5z4OTfU_QikYQ1N0xrKUd66xtlFIkx7eOwHk365VHrhhIRLclCSHv0Q";

        for (const message of batch.messages) {
            const { symbol, date } = message.body;

            console.log(`Processing ${symbol} for ${date}`);

            try {
                const url = `https://exodus.stockbit.com/marketdetectors/${symbol}?from=${date}&to=${date}&transaction_type=TRANSACTION_TYPE_GROSS&market_board=MARKET_BOARD_ALL&investor_type=INVESTOR_TYPE_ALL&limit=25`;

                const response = await fetch(url, {
                    headers: {
                        "Host": "exodus.stockbit.com",
                        "Connection": "keep-alive",
                        "X-Platform": "desktop",
                        "Authorization": `Bearer ${TOKEN}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                        "Accept": "application/json"
                    }
                });

                if (!response.ok) {
                    console.error(`Failed to fetch ${symbol}: ${response.status}`);
                    // Optionally retry message: message.retry();
                    continue;
                }

                const data = await response.json();

                // Save to R2: RAW_BROKSUM / SYMBOL / DATE.json
                const key = `${symbol}/${date}.json`;
                await env.RAW_BROKSUM.put(key, JSON.stringify(data));

                console.log(`Saved ${key} to R2`);

                // Ack message
                message.ack();

            } catch (err) {
                console.error(`Error processing ${symbol}:`, err);
                message.retry(); // Retry later
            }
        }
    }
};
