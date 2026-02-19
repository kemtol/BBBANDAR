export interface Env {
  GROK_API_KEY: string;
  GROK_API_URL?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Use POST for /grok-sentiment',
      }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract the Tweets data from the request
    let tweets: string[];
    try {
      const data = await request.json();
      tweets = data.tweets;
      if (!Array.isArray(tweets)) {
        throw new Error('Invalid tweets format');
      }
    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Invalid JSON body',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Prepare the payload for Grok API
    const payload = {
      prompt: `Analyze the following tweets for sentiment.\n\nTweets:\n${tweets.join('\n')}\n\nOutput JSON:\n 1. Overall sentiment score (-1.0 to 1.0)\n 2. Sentiment label (bullish/bearish/neutral)\n 3. Key discussion themes\n`,
    };

    // API URL for Grok; default to a test endpoint in local dev
    const grokApiUrl = env.GROK_API_URL || 'https://grok.api.local/test';

    // Fetch analysis from Grok
    let response: Response;
    try {
      response = await fetch(grokApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROK_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Failed to contact Grok API',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return new Response(JSON.stringify({
        ok: false,
        error: `Grok API error: ${errorText}`,
      }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Return Grok's analysis
    const analysis = await response.json();
    return new Response(JSON.stringify({
      ok: true,
      result: analysis,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
