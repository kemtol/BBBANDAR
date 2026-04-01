export function createRequestTracker(page) {
  const requests = [];

  const onRequest = (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType()
    });
  };

  page.on('request', onRequest);

  return {
    requests,
    stop() {
      page.off('request', onRequest);
    },
    count(predicate) {
      return requests.filter(predicate).length;
    },
    byUrl(partial) {
      return requests.filter((item) => item.url.includes(partial));
    },
    waitForRequestCount(predicate, expectedCount, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const tick = () => {
          const count = requests.filter(predicate).length;
          if (count >= expectedCount) {
            resolve(count);
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error(`Timed out waiting for ${expectedCount} requests; got ${count}`));
            return;
          }
          setTimeout(tick, 250);
        };
        tick();
      });
    }
  };
}

export function isApiRequest(url, baseURL, pathFragment) {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(baseURL).origin && parsed.pathname.includes(pathFragment);
  } catch {
    return url.includes(pathFragment);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
