import { CORS, json, limited } from "@/lib/http.ts";
import { isLang, type Lang } from "@/lib/types.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

// Whisper uses the prompt as spelling context: domain words it would otherwise mishear.
// Only for languages whose script matches the prompt; a wrong-script prompt pulls output into that script.
const VOCAB: Partial<Record<Lang, string>> = {
  en: "Government schemes in India: PM-KISAN, Ayushman Bharat, Ujjwala, Jan Dhan, MGNREGA, PM Awas, Mudra, SVANidhi, e-Shram, Atal Pension. BPL card, Antyodaya, ration card, Aadhaar, widow pension, bigha, acre, lakh, village, chulha.",
  hi: "सरकारी योजनाएँ: पीएम किसान, आयुष्मान भारत, उज्ज्वला, जन धन, मनरेगा, प्रधानमंत्री आवास, मुद्रा, ई-श्रम। बीपीएल कार्ड, अंत्योदय, राशन कार्ड, आधार, विधवा पेंशन, बीघा, एकड़, लाख, गाँव, चूल्हा।",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** POST multipart { audio: Blob, lang } -> { text }. Groq Whisper large-v3, language pinned, temperature 0. */
export async function POST(req: Request) {
  if (!process.env.GROQ_API_KEY) return json({ error: "Server speech-to-text is not configured." }, 503);
  if (limited(req, "stt", 30)) return json({ error: "Too many requests. Please wait a minute." }, 429);

  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size < 1000) return json({ error: "Send a recording in the 'audio' field." }, 400);
  if (audio.size > 10 * 1024 * 1024) return json({ error: "Recording too long." }, 413);
  const lang: Lang = isLang(form?.get("lang")) ? (form!.get("lang") as Lang) : "en";

  const ext = /mp4|m4a|aac/.test(audio.type) ? "m4a" : /ogg/.test(audio.type) ? "ogg" : /wav/.test(audio.type) ? "wav" : "webm";
  // Most accurate first; on a timeout, rate limit or error, retry once with the faster turbo model.
  const models = [process.env.GROQ_STT_MODEL || "whisper-large-v3", "whisper-large-v3-turbo"];
  let failure = "";
  for (const model of models) {
    const body = new FormData();
    body.append("file", audio, `speech.${ext}`);
    body.append("model", model);
    body.append("language", lang);
    body.append("temperature", "0");
    body.append("response_format", "json");
    if (VOCAB[lang]) body.append("prompt", VOCAB[lang]!);
    try {
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { failure = `${res.status}`; continue; }
      const text = String(((await res.json()) as { text?: string }).text ?? "").trim();
      // Whisper can echo its prompt on silence; that is not speech.
      return json({ text: text && VOCAB[lang]?.includes(text) ? "" : text, lang, model });
    } catch {
      failure = "timeout";
    }
  }
  return json({ error: `Could not transcribe right now (${failure}). Please try again.` }, 502);
}
