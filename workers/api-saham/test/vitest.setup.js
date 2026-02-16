import { vi, beforeAll, afterEach, afterAll } from "vitest";

const defaultResponse = () =>
  new Response(
    JSON.stringify({ ok: true, mocked: true }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );

const mockFetch = vi.fn(() => Promise.resolve(defaultResponse()));

beforeAll(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  mockFetch.mockImplementation(() => Promise.resolve(defaultResponse()));
  mockFetch.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});
