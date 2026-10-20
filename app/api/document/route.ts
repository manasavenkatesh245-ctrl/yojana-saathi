import { cleanProfile } from "@/lib/engine.ts";
import { CORS, json, limited } from "@/lib/http.ts";
import { isLang, LANGS, type Lang } from "@/lib/types.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

const prompt = (lang: Lang) => `You read Indian documents (ration card, income / caste / disability (UDID) certificate, land record, birth certificate, pension order, marksheet) to check welfare-scheme eligibility. Today is ${new Date().toISOString().slice(0, 10)}.
Return ONLY a JSON object: {"doc_type": string, "facts": {...}, "summary": string}.
"facts" may use only these keys, and only for what the document clearly shows:
age (years; compute from date of birth), gender ("female"|"male"|"other"), maritalStatus ("married"|"widowed"|"single"|"divorced"), state, district, area ("rural"|"urban"),
annualIncome (rupees per year), category ("general"|"obc"|"sc"|"st"), bpl (true for Antyodaya / AAY / BPL / Priority Household cards), disabilityPercent (number),
ownsLand (true if a land record in the holder's name), educationLevel ("school"|"post_matric"|"graduate"), class12Top20 (boolean).
NEVER output any person's name, Aadhaar, ration card, account, phone or certificate numbers, anywhere.
"summary": one short line in ${LANGS[lang].name} saying what the document is and the key facts.`;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** POST multipart { file: image, lang } -> { docType, facts, summary }. Nothing is stored. */
export async function POST(req: Request) {
  if (!process.env.GROQ_API_KEY) return json({ error: "Document reading needs the AI engine (GROQ_API_KEY)." }, 503);
  if (limited(req, "doc", 10)) return json({ error: "Too many uploads. Please wait a minute." }, 429);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || !/^image\/(jpeg|png|webp)$/.test(file.type)) return json({ error: "Send a JPEG, PNG or WebP image in the 'file' field." }, 400);
  if (file.size > 4 * 1024 * 1024) return json({ error: "Image too large (max 4 MB)." }, 413);
  const lang: Lang = isLang(form?.get("lang")) ? (form!.get("lang") as Lang) : "en";
  const dataUrl = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b",
        temperature: 0,
        max_completion_tokens: 500,
        reasoning_effort: "none",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: [{ type: "text", text: prompt(lang) }, { type: "image_url", image_url: { url: dataUrl } }] }],
      }),
    });
    if (res.status === 429) return json({ error: "The document reader is busy. Please try again in a minute." }, 429);
    if (!res.ok) return json({ error: `Could not read the document (${res.status}).` }, 502);
    const raw = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "{}";
    const out = JSON.parse(raw.replace(/^```(json)?|```$/g, "")) as { doc_type?: unknown; facts?: unknown; summary?: unknown };
    // Belt and braces: whatever the model returns, long digit runs (ID / account / phone numbers) never leave the server.
    const scrub = (s: unknown) => String(s ?? "").replace(/\d[\d\s-]{7,}\d/g, "[hidden]").slice(0, 300);
    return json({ docType: scrub(out.doc_type).slice(0, 60) || "document", facts: cleanProfile(out.facts), summary: scrub(out.summary) });
  } catch {
    return json({ error: "Could not read the document. Try a clearer, well-lit photo." }, 502);
  }
}
