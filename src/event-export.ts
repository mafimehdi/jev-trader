import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
};

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function tokenMatches(expected: string, authorization: string | null): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}

/** Serve one allowed JSONL segment. The endpoint is disabled unless a bearer secret is configured. */
export async function eventLogResponse(
  request: Request,
  token: string | undefined,
  dataDir = "data",
): Promise<Response> {
  if (!token) return jsonError("not found", 404);
  if (request.method !== "GET") return jsonError("method not allowed", 405);
  if (!tokenMatches(token, request.headers.get("authorization"))) return jsonError("unauthorized", 401);

  const url = new URL(request.url);
  const part = url.searchParams.get("part") ?? "current";
  const name = part === "current" ? "events.jsonl" : part === "previous" ? "events.jsonl.1" : null;
  if (!name) return jsonError("part must be current or previous", 400);

  const file = Bun.file(join(dataDir, name));
  if (!(await file.exists())) return jsonError("event log not found", 404);
  return new Response(file, {
    headers: {
      ...CORS,
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
