// Shared by the API routes: CORS, JSON with explicit charset, and a per-IP rate limit.

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

// Explicit charset: some clients mis-decode Hindi as Latin-1 without it.
export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// ponytail: in-memory per-instance limiter; use Vercel KV / Upstash if abuse becomes real.
const hits = new Map<string, number[]>();
export function limited(req: Request, bucket: string, perMinute: number) {
  const key = `${bucket}:${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > perMinute;
}
