import { normalizeInput, runAgent, SCHEMES, toMarkdown } from "@/lib/agent.ts";
import { CORS, json, limited } from "@/lib/http.ts";
import { LANGS, type AgentEvent } from "@/lib/types.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  if (limited(req, "agent", 20)) return json({ error: "Too many requests. Please wait a minute." }, 429);

  const raw = await req.text();
  if (raw.length > 20_000) return json({ error: "Request body too large." }, 413);
  let body: unknown = raw;
  try { body = JSON.parse(raw); } catch { /* plain-text body is accepted as the message */ }

  const input = normalizeInput(body);
  if (!input) return json({ error: "Send JSON with a non-empty 'message' (or 'input' / 'query' / 'prompt' / 'situation') string." }, 400);
  if (input.message.length > 2100) return json({ error: "Message is too long (max 2000 characters)." }, 413);

  const stream = !!body && typeof body === "object" && (body as { stream?: unknown }).stream === true;
  if (!stream) {
    const result = await runAgent(input);
    return json({ format: "markdown", response: toMarkdown(result), ...result });
  }

  const enc = new TextEncoder();
  const events = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent(input, emit);
      } catch {
        emit({ type: "error", message: "Something went wrong. Please try again." });
      }
      controller.close();
    },
  });
  return new Response(events, { headers: { ...CORS, "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

/** Self-describing endpoint, handy for the hackathon API submission. */
export function GET() {
  const llm = !!process.env.GROQ_API_KEY;
  return json({
    name: "Yojana Saathi",
    description: "AI agent that finds Indian government welfare schemes a citizen qualifies for, explains why, and drafts the application.",
    status: "ok",
    mode: llm ? "groq" : "offline",
    speech: llm ? "whisper" : "browser",
    documents: llm,
    languages: Object.fromEntries(Object.entries(LANGS).map(([k, l]) => [k, l.native])),
    schemes: SCHEMES.length,
    usage: {
      method: "POST",
      path: "/api/agent",
      contentType: "application/json",
      body: {
        message: "string, required (aliases: input, query, prompt, situation; a plain-text body also works)",
        language: `optional: ${Object.keys(LANGS).join(" | ")} (or the language name)`,
        pincode: "6-digit PIN, optional",
        history: "[{ role: 'user'|'agent', text }], optional",
        profile: "object from a previous response, optional (continues the case)",
        stream: "true for NDJSON events, optional",
      },
      example: { message: "My husband passed away last year. I live in a village in Bihar, we cook on a chulha and I have a BPL card." },
      returns: "{ format: 'markdown', response, reply, lang, profile, schemes[], trace[], followUps[], drafts{}, mode, model }",
      speechToText: "POST /api/transcribe multipart { audio, lang } -> { text }",
    },
  });
}
