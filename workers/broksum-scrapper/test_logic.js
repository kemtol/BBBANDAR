
const TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjU3MDc0NjI3LTg4MWItNDQzZC04OTcyLTdmMmMzOTNlMzYyOSIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7InVzZSI6ImtlbXRvbCIsImVtYSI6Im1rZW1hbHdAZ21haWwuY29tIiwiZnVsIjoiTXVzdGFmYSBLZW1hbCBXaXJ5YXdhbiIsInNlcyI6IiIsImR2YyI6IjVjZjJmZjljM2JkMjFhYzFmYmZhNTZiNGE1MjE4YWJhIiwiZGlkIjoiZGVza3RvcCIsInVpZCI6MjMwNTM1MCwiY291IjoiSUQifSwiZXhwIjoxNzY3MTgyNDA5LCJpYXQiOjE3NjcwOTYwMDksImlzcyI6IlNUT0NLQklUIiwianRpIjoiMDY3Mjg1YjAtYjgxMy00NjZlLTk5ZWMtZjBhOGJjYzNhZmRlIiwibmJmIjoxNzY3MDk2MDA5LCJ2ZXIiOiJ2MSJ9.MeM21u4oWbfoa90-QZZTa-0bNvqqUFHxjyjHmFq84GaUO0mzQEKKZlQScUbbdKbmOb9gRkyEAK1zFTn_UEWo_nQBStDgNvycAH6CMGz5PQ5L49vQIav-fGVy1YmiDntVV3jx6ge1oHhTzBFnU2VsUCB1ydftWlZyYqWt74TfC8ntaELaTWgG3oJOKhZ9f1GvKGdMxbF9hAlFzZx9sGMehE9Zc6Xgy6mv4l-CmZPBHgTWm7o50wG_p-5cL0tvSSr7yYgYz_MlNHU8v6xJ8UOlG27RIRyyfhw5z4OTfU_QikYQ1N0xrKUd66xtlFIkx7eOwHk365VHrhhIRLclCSHv0Q";

async function run() {
    const TEMPLATE_IDS = [97, 96, 92, 106, 63, 108];
    const uniqueSymbols = new Set();
    const errors = [];

    console.log(`Fetching from templates: ${TEMPLATE_IDS.join(", ")}...`);

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
                    "sec-ch-ua-platform": "\"Windows\"",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                    "Accept": "application/json, text/plain, */*",
                    "sec-ch-ua": "\"Microsoft Edge WebView2\";v=\"143\", \"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
                    "sec-ch-ua-mobile": "?0",
                    "Origin": "https://tauri.localhost",
                    "Sec-Fetch-Site": "cross-site",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Dest": "empty",
                    "Referer": "https://tauri.localhost/",
                    "Accept-Encoding": "gzip, deflate, br, zstd",
                    "Accept-Language": "en-US,en;q=0.9"
                }
            });

            if (!response.ok) {
                console.error(`Failed to fetch template ${id}: ${response.status}`);
                errors.push(`Template ${id} failed: ${response.status}`);
                return;
            }

            const data = await response.json();
            let count = 0;
            if (data && data.data && data.data.calcs) {
                for (const item of data.data.calcs) {
                    if (item.company && item.company.symbol) {
                        uniqueSymbols.add(item.company.symbol);
                        count++;
                    }
                }
            }
            console.log(`Template ${id}: Found ${count} symbols.`);

        } catch (err) {
            console.error(`Error fetching template ${id}:`, err);
            errors.push(`Template ${id} error: ${err.message}`);
        }
    }));

    const watchlist = Array.from(uniqueSymbols);

    const output = {
        token: TOKEN,
        watchlist: watchlist,
        meta: {
            total_unique: watchlist.length,
            errors: errors
        }
    };

    console.log("FINAL OUTPUT:");
    console.log(JSON.stringify(output, null, 2));
}

run();
