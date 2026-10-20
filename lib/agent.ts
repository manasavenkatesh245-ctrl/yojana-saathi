import schemesData from "../data/schemes.json" with { type: "json" };
import { detectLang, isLang, LANGS } from "./types.ts";
import type { AgentEvent, AgentRequest, AgentResult, ChatTurn, Lang, Profile, ProfileField, Scheme, SchemeResult, TraceStep } from "./types.ts";
import { benefitTotals, cleanProfile, draftApplication, evaluateAll, evaluateScheme, FIELDS, nextQuestions } from "./engine.ts";
import { extractProfile, schemeIntent } from "./nlu.ts";

export const SCHEMES = schemesData as Scheme[];
type Emit = (e: AgentEvent) => void;
/** Template language for offline replies and field questions (only English and Hindi are hand-written). */
const tl = (l: Lang): "en" | "hi" => (l === "hi" || l === "mr" ? "hi" : "en");

interface Ctx {
  profile: Profile;
  results: SchemeResult[];
  drafts: Record<string, string>;
  centres?: unknown;
  trace: TraceStep[];
  lang: Lang;
  emit: Emit;
}

let stepNo = 0;
function trace(ctx: Ctx, step: Omit<TraceStep, "id">) {
  const s = { id: `s${++stepNo}`, ...step };
  ctx.trace.push(s);
  ctx.emit({ type: "trace", step: s });
}

/** Re-run the rule engine and return a compact summary the model can reason over. */
function checkEligibility(ctx: Ctx) {
  ctx.results = evaluateAll(SCHEMES, ctx.profile);
  ctx.emit({ type: "schemes", schemes: ctx.results });
  const eligible = ctx.results.filter((r) => r.verdict === "eligible");
  const maybe = ctx.results.filter((r) => r.verdict === "needs_info");
  // Compact on purpose: the free tier allows ~8k tokens a minute.
  return {
    eligible: eligible.map((r) => ({ id: r.id, name: r.name, benefit: r.benefit, because: r.rules.filter((x) => x.outcome === "pass").map((x) => x.label).join("; ") })),
    could_fit: maybe.slice(0, 5).map((r) => `${r.name} (needs: ${r.missing.join(", ")})`),
    ask_next: nextQuestions(ctx.results).map((f) => FIELDS[f].q.en),
  };
}

// ---------- Tools: the agent's hands. Same implementations for the LLM and offline mode. ----------

const SCHEME_IDS = SCHEMES.map((s) => s.id);

const TOOLS = {
  update_profile: {
    description: "Record facts the user stated or clearly implied about themselves/family, then re-check all 27 schemes. Returns eligible schemes (with reasons), schemes that could fit, and the best next questions.",
    parameters: {
      type: "object",
      // Descriptions only where the name alone is ambiguous (tokens are scarce on the free tier).
      properties: Object.fromEntries(
        Object.entries(FIELDS).map(([k, f]) => [k, { type: f.type, ...(f.enum ? { enum: f.enum } : {}), ...(/annualIncome|bpl|educationLevel|class12Top20|isGovtEmployee|inEpfoOrEsic|disabilityPercent|area|ownsLand/.test(k) ? { description: f.desc } : {}) }]),
      ),
    },
    run: (ctx: Ctx, args: Record<string, unknown>) => {
      const added = cleanProfile(args);
      // Models like to fill "false" defaults for things nobody said; for these optional facts a false would
      // silently rule schemes out, so only the user's own words (offline reader / an explicit "yes") can set them.
      for (const k of ["wantsToStartBusiness", "isPregnant", "hasDaughterUnder10", "class12Top20"] as const) if (added[k] === false) delete added[k];
      ctx.profile = { ...ctx.profile, ...added };
      ctx.emit({ type: "profile", profile: ctx.profile });
      return { recorded: Object.keys(added), ...checkEligibility(ctx) };
    },
  },
  find_schemes: {
    description: "Re-check eligibility for the current profile without new facts.",
    parameters: { type: "object", properties: {} },
    run: (ctx: Ctx) => checkEligibility(ctx),
  },
  get_scheme_details: {
    description: "Details of one scheme (benefit, documents, how to apply, official link) and this user's status for it. Use when they ask about a specific scheme.",
    parameters: { type: "object", properties: { scheme_id: { type: "string", enum: SCHEME_IDS } }, required: ["scheme_id"] },
    run: (ctx: Ctx, args: Record<string, unknown>) => {
      const s = SCHEMES.find((x) => x.id === args.scheme_id);
      if (!s) return { error: `Unknown scheme_id. Valid: ${SCHEME_IDS.join(", ")}` };
      const r = evaluateScheme(s, ctx.profile);
      const by = (o: string) => r.rules.filter((x) => x.outcome === o).map((x) => x.label);
      return {
        name: s.name, summary: s.summary, benefit: s.benefit, documents: s.documents, howToApply: s.howToApply, applyUrl: s.applyUrl, source: s.source, verifyNote: s.verifyNote,
        your_status: r.verdict, met: by("pass"), not_met: by("fail"), ask: r.missing.map((f) => FIELDS[f].q.en),
      };
    },
  },
  draft_application: {
    description: "Prepare a printable pre-filled application helper sheet for a scheme. It is shown in the app; do not paste it.",
    parameters: { type: "object", properties: { scheme_id: { type: "string", enum: SCHEME_IDS } }, required: ["scheme_id"] },
    run: (ctx: Ctx, args: Record<string, unknown>) => {
      const s = SCHEMES.find((x) => x.id === args.scheme_id);
      if (!s) return { error: "Unknown scheme_id" };
      const text = draftApplication(s, ctx.profile);
      ctx.drafts[s.id] = text;
      ctx.emit({ type: "draft", schemeId: s.id, text });
      return { ok: true, scheme: s.name, shown_to_user: true };
    },
  },
  find_help_centre: {
    description: "Look up a 6-digit Indian PIN code (India Post API): district, state, nearby post offices, and the CSC locator. Also fills state/district.",
    parameters: { type: "object", properties: { pincode: { type: "string" } }, required: ["pincode"] },
    run: async (ctx: Ctx, args: Record<string, unknown>) => {
      const pin = String(args.pincode ?? "");
      if (!/^[1-9]\d{5}$/.test(pin)) return { error: "PIN code must be 6 digits" };
      try {
        const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: AbortSignal.timeout(6000) });
        const data = (await res.json()) as { Status: string; PostOffice?: { Name: string; District: string; State: string; BranchType: string; Block: string }[] }[];
        const offices = data?.[0]?.PostOffice ?? [];
        if (data?.[0]?.Status !== "Success" || !offices.length) return { error: "PIN code not found" };
        const { District, State } = offices[0];
        ctx.profile = { ...ctx.profile, pincode: pin, district: ctx.profile.district ?? District, state: ctx.profile.state ?? State };
        ctx.emit({ type: "profile", profile: ctx.profile });
        ctx.centres = {
          district: District,
          state: State,
          postOffices: offices.slice(0, 5).map((o) => `${o.Name} (${o.BranchType}${o.Block && o.Block !== "NA" ? `, ${o.Block}` : ""})`),
          cscLocator: "https://locator.csccloud.in",
          note: "Post offices open Jan Dhan, Sukanya Samriddhi, APY and insurance accounts. CSCs handle most scheme registrations.",
        };
        return ctx.centres;
      } catch {
        return { error: "India Post lookup unavailable right now", cscLocator: "https://locator.csccloud.in" };
      }
    },
  },
} as const;

const TITLES: Record<string, string> = {
  update_profile: "Recorded facts, re-checked 27 schemes",
  find_schemes: "Checked eligibility rules",
  get_scheme_details: "Looked up scheme details",
  draft_application: "Drafted application",
  find_help_centre: "Looked up help centre",
};

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const t0 = Date.now();
  const tool = TOOLS[name as keyof typeof TOOLS];
  const output = tool ? await tool.run(ctx, args) : { error: `No tool ${name}` };
  trace(ctx, { kind: "tool", title: TITLES[name] ?? name, tool: name, input: args, output, ms: Date.now() - t0 });
  return output;
}

// ---------- Groq (free tier, OpenAI-compatible) tool-calling loop ----------

const MODELS = (process.env.GROQ_MODELS || "qwen/qwen3.8-27b,openai/gpt-oss-120b,openai/gpt-oss-20b").split(",").map((m) => m.trim()).filter(Boolean);
const TOOL_DEFS = Object.entries(TOOLS).map(([name, t]) => ({ type: "function", function: { name, description: t.description, parameters: t.parameters } }));

const system = (lang: Lang) => `You are Yojana Saathi, an assistant for citizens of INDIA that finds Indian central government welfare schemes they qualify for and gets them ready to apply. You act through tools; the rule engine, not you, decides eligibility.

Each turn:
1. If the user stated or clearly implied facts about themselves or family, call update_profile with ONLY those facts. Read indirect wording, e.g. "my husband passed away" = widowed + female; "we cook on firewood / chulha" = hasLpg false; "I sell vegetables from a cart" = street_vendor; "I work on other people's fields" = agri_labourer + ownsLand false; "tenant / sharecropper" = farmer + ownsLand false; "mud / kutcha house, hut, on rent" = ownsPuccaHouse false; "I earn 300 a day" = annualIncome 90000; "monthly X" = X*12 per year; "7 months pregnant" = isPregnant true; "Antyodaya / BPL / priority ration card" = bpl true; "blind, lost a leg" with a certificate % = disabilityPercent. Never record what was not said.
   Include negatives that were said ("no bank account" = hasBankAccount false). Leave out every field the user did not mention; never fill defaults like false.
2. update_profile already returns eligibility. Without new facts, call find_schemes only if needed.
3. Question about one scheme (documents, how to apply, am I eligible, what is it) = get_scheme_details.
4. A 6-digit PIN code = find_help_centre. Asking for a form or help applying = draft_application.

Reply rules:
- Write ONLY in ${LANGS[lang].name} (${LANGS[lang].native} script), in simple everyday words and short sentences. Scheme names may stay in English.
- Use only schemes, amounts, documents and links returned by tools. Never invent.
- Format: one line of what you understood; then eligible schemes as a short list "Name: benefit (because …)"; then at most 3 questions from ask_next, translated naturally; mention a draft is ready in the app if you made one.
- Never ask for Aadhaar, bank account numbers, OTPs or passwords; if shared, tell them not to share these.
- End by saying final eligibility is confirmed at the office or official site.
- Off-topic or not about India: say briefly that you only help with Indian government schemes.`;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_call_id?: string };

/** One completion, falling through the model list on rate limits or errors. `at` remembers the working model. */
async function groq(messages: Msg[], at: { i: number }, ctx: Ctx): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  let last = "";
  for (; at.i < MODELS.length; at.i++) {
    const model = MODELS[at.i];
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          model,
          messages,
          tools: TOOL_DEFS,
          tool_choice: "auto",
          temperature: 0.2,
          max_completion_tokens: 1200,
          reasoning_effort: model.startsWith("qwen") ? "none" : "low",
        }),
      });
      if (res.ok) {
        const m = ((await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] }).choices?.[0]?.message;
        if (m) return { content: (m.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(), tool_calls: m.tool_calls?.length ? m.tool_calls : undefined };
        last = `${model}: empty`;
      } else {
        last = `${model}: ${res.status}`;
        if (res.status === 401) break; // bad key: other models won't help
      }
    } catch (e) {
      last = `${model}: ${(e as Error).name}`;
    }
    if (at.i + 1 < MODELS.length) trace(ctx, { kind: "reason", title: `Model busy (${last}), switching to ${MODELS[at.i + 1]}` });
  }
  throw new Error(`Groq unavailable (${last})`);
}

async function runGroq(ctx: Ctx, req: AgentRequest): Promise<{ reply: string; model: string }> {
  const messages: Msg[] = [
    { role: "system", content: system(ctx.lang) },
    ...(req.history ?? []).slice(-6).map((t): Msg => ({ role: t.role === "user" ? "user" : "assistant", content: t.text.slice(0, 800) })),
    { role: "user", content: `${req.message}\n\n[Known profile so far: ${JSON.stringify(ctx.profile)}]` },
  ];
  const at = { i: 0 };
  for (let turn = 0; turn < 6; turn++) {
    const m = await groq(messages, at, ctx);
    if (!m.tool_calls) return { reply: m.content, model: MODELS[at.i] };
    messages.push({ role: "assistant", content: m.content, tool_calls: m.tool_calls });
    if (m.content) trace(ctx, { kind: "reason", title: "Planned next step", output: m.content });
    for (const c of m.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* malformed args: tool sees {} and reports */ }
      const out = await callTool(ctx, c.function.name, args);
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  return { reply: "", model: MODELS[at.i] };
}

// ---------- Offline mode: same tools, rule-based understanding (English, Hindi, Hinglish) ----------

const OCC_WORD: Record<string, [string, string]> = {
  farmer: ["farmer", "किसान"], agri_labourer: ["farm labourer", "खेतिहर मज़दूर"], fisher: ["fisher", "मछुआरा"], student: ["student", "छात्र"],
  artisan: ["artisan", "कारीगर"], street_vendor: ["street vendor", "रेहड़ी-पटरी विक्रेता"], small_business: ["small business owner", "छोटे व्यापारी"],
  unorganised_worker: ["daily-wage worker", "दिहाड़ी मज़दूर"], salaried: ["salaried", "नौकरीपेशा"], govt_employee: ["government employee", "सरकारी कर्मचारी"],
  unemployed: ["looking for work", "बेरोज़गार"], homemaker: ["homemaker", "गृहिणी"], retired: ["retired", "सेवानिवृत्त"], other: ["other work", "अन्य काम"],
};

export function describeProfile(p: Profile, lang: Lang): string {
  const hi = tl(lang) === "hi";
  const bits = [
    p.age !== undefined && (hi ? `${p.age} साल` : `${p.age} years`),
    p.gender && (hi ? { female: "महिला", male: "पुरुष", other: "अन्य" }[p.gender] : p.gender),
    p.maritalStatus === "widowed" && (hi ? (p.gender === "male" ? "विधुर" : p.gender === "female" ? "विधवा" : "विधवा/विधुर") : "widowed"),
    p.occupation && OCC_WORD[p.occupation][hi ? 1 : 0],
    p.state,
    p.area && (hi ? (p.area === "rural" ? "गाँव" : "शहर") : p.area === "rural" ? "village" : "town/city"),
    p.annualIncome !== undefined && `₹${p.annualIncome.toLocaleString("en-IN")}${hi ? "/साल" : "/year"}`,
    p.category && p.category.toUpperCase(),
    p.bpl && (hi ? "BPL कार्ड" : "BPL card"),
  ].filter(Boolean);
  return bits.join(", ");
}

function composeReply(ctx: Ctx, understood: number): string {
  const hi = tl(ctx.lang) === "hi";
  const eligible = ctx.results.filter((r) => r.verdict === "eligible");
  const maybe = ctx.results.filter((r) => r.verdict === "needs_info");
  const asks = nextQuestions(ctx.results).map((f: ProfileField) => FIELDS[f].q[tl(ctx.lang)]);
  if (!understood && !Object.keys(ctx.profile).length) {
    return hi
      ? "मैं सरकारी योजनाएँ ढूँढने में मदद करता हूँ। अपने बारे में बताइए: उम्र, राज्य, गाँव या शहर, काम, और परिवार की कमाई।"
      : "I help you find government schemes you qualify for. Tell me about yourself: age, state, village or city, your work, and family income.";
  }
  const lines: string[] = [];
  lines.push(hi ? `मैंने समझा: ${describeProfile(ctx.profile, "hi")}.` : `What I understood: ${describeProfile(ctx.profile, "en")}.`);
  if (eligible.length) {
    lines.push("", hi ? `आप अभी ${eligible.length} योजनाओं के लिए पात्र दिखते हैं:` : `You look eligible for ${eligible.length} scheme${eligible.length > 1 ? "s" : ""} right now:`);
    for (const r of eligible.slice(0, 6)) lines.push(`- ${hi ? r.name_hi : r.name}: ${r.benefit}`);
  } else {
    lines.push("", hi ? "अभी किसी योजना की पुष्टि नहीं हुई। कुछ और जानकारी चाहिए।" : "No scheme is confirmed yet. I need a few more details.");
  }
  if (maybe.length && asks.length) {
    lines.push("", hi ? `${maybe.length} और योजनाएँ मिल सकती हैं। बताइए:` : `${maybe.length} more could fit. Tell me:`);
    asks.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  }
  lines.push("", hi ? "अंतिम पात्रता आधिकारिक साइट या कार्यालय में जाँच लें।" : "Final eligibility is confirmed at the office or official site.");
  return lines.join("\n");
}

/** Offline answer to "what documents / how to apply / am I eligible for <scheme>". */
function composeSchemeAnswer(ctx: Ctx, d: ReturnType<(typeof TOOLS)["get_scheme_details"]["run"]>): string {
  if ("error" in d) return "";
  const hi = tl(ctx.lang) === "hi";
  const status = { eligible: hi ? "आप पात्र दिखते हैं" : "You look eligible", needs_info: hi ? "कुछ जानकारी और चाहिए" : "I need a little more information", not_eligible: hi ? "आप पात्र नहीं दिखते" : "You don't look eligible" }[d.your_status];
  return [
    `**${d.name}**: ${d.benefit}`,
    "",
    `${status}${d.not_met.length ? ` (${d.not_met.join("; ")})` : ""}.`,
    ...(d.ask.length ? ["", hi ? "बताइए:" : "Tell me:", ...d.ask.slice(0, 3).map((q, i) => `${i + 1}. ${q}`)] : []),
    "",
    hi ? "ज़रूरी कागज़:" : "Documents:",
    ...d.documents.map((x) => `- ${x}`),
    "",
    hi ? "आवेदन कैसे करें:" : "How to apply:",
    ...d.howToApply.map((x, i) => `${i + 1}. ${x}`),
    "",
    `${hi ? "आधिकारिक स्रोत" : "Official source"}: ${d.source}`,
  ].join("\n");
}

async function runOffline(ctx: Ctx, req: AgentRequest): Promise<string> {
  const t0 = Date.now();
  const facts = extractProfile(req.message);
  const asked = schemeIntent(req.message);
  trace(ctx, { kind: "understand", title: "Read your message (offline rules)", input: req.message, output: { facts, asked_about: asked }, ms: Date.now() - t0 });
  if (Object.keys(facts).length) await callTool(ctx, "update_profile", facts as Record<string, unknown>);
  else await callTool(ctx, "find_schemes", {});
  if (facts.pincode) await callTool(ctx, "find_help_centre", { pincode: facts.pincode });
  if (asked) {
    const d = (await callTool(ctx, "get_scheme_details", { scheme_id: asked })) as ReturnType<(typeof TOOLS)["get_scheme_details"]["run"]>;
    const answer = composeSchemeAnswer(ctx, d);
    if (answer) return answer;
  }
  const eligible = ctx.results.filter((r) => r.verdict === "eligible");
  if (eligible.length === 1) await callTool(ctx, "draft_application", { scheme_id: eligible[0].id });
  return composeReply(ctx, Object.keys(facts).length);
}

// ---------- Entry point ----------

export async function runAgent(req: AgentRequest, emit: Emit = () => {}): Promise<AgentResult> {
  const lang = detectLang(req.message, req.lang ?? "en");
  const ctx: Ctx = { profile: cleanProfile(req.profile), results: [], drafts: {}, trace: [], lang, emit };
  let mode: AgentResult["mode"] = process.env.GROQ_API_KEY ? "groq" : "offline";
  let reply = "";
  let model: string | undefined;

  if (mode === "groq") {
    // Hybrid: facts the rule reader is sure of go in first, so even a fallback model can't drop them.
    const sure = extractProfile(req.message);
    if (Object.keys(sure).length) {
      ctx.profile = { ...ctx.profile, ...sure };
      trace(ctx, { kind: "understand", title: "Pre-read message (rules)", input: req.message, output: sure });
      ctx.emit({ type: "profile", profile: ctx.profile });
    }
    try {
      ({ reply, model } = await runGroq(ctx, req));
    } catch (e) {
      // ponytail: any LLM failure (quota, timeout, bad key) degrades to offline mode instead of failing the citizen.
      trace(ctx, { kind: "error", title: "LLM unavailable, switched to offline mode", output: String((e as Error).message) });
      mode = "offline";
    }
  }
  if (mode === "offline") reply = await runOffline(ctx, req);

  // The UI always gets fresh results, even if the model skipped the tool.
  if (!ctx.results.length) checkEligibility(ctx);
  if (!reply) reply = composeReply(ctx, 1);
  trace(ctx, { kind: "answer", title: model ? `Answered (${model})` : "Answered" });
  emit({ type: "reply", text: reply });

  const result: AgentResult = {
    reply,
    lang,
    profile: ctx.profile,
    schemes: ctx.results,
    trace: ctx.trace,
    followUps: nextQuestions(ctx.results).map((f) => FIELDS[f].q[tl(lang)]),
    mode,
    model,
    drafts: ctx.drafts,
    centres: ctx.centres,
  };
  emit({ type: "done", result });
  return result;
}

// ---------- Shared I/O for both submission methods (API endpoint and aiKart sandbox) ----------

/** "ta", "Tamil", "தமிழ்", "hindi", "हिंदी" -> Lang. */
function toLang(v: unknown): Lang | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (isLang(s)) return s;
  const hit = (Object.entries(LANGS) as [Lang, (typeof LANGS)[Lang]][]).find(([, l]) => s.startsWith(l.name.toLowerCase().slice(0, 4)) || s === l.native.toLowerCase());
  return hit?.[0] ?? (s.includes("हिं") ? "hi" : undefined);
}

/**
 * Accepts the shapes a caller is likely to send: our own { message }, common { input | query | prompt | text },
 * and the aiKart manifest inputs { situation, language, pincode }. Returns null when there is no text.
 */
export function normalizeInput(body: unknown): AgentRequest | null {
  if (typeof body === "string") body = { message: body };
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const text = [b.message, b.situation, b.input, b.query, b.prompt, b.text].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (!text) return null;
  const pin = typeof b.pincode === "string" || typeof b.pincode === "number" ? String(b.pincode).trim() : "";
  const message = pin && /^[1-9]\d{5}$/.test(pin) && !text.includes(pin) ? `${text.trim()} PIN code ${pin}` : text.trim();
  const history: ChatTurn[] = Array.isArray(b.history)
    ? b.history
        .filter((t): t is ChatTurn => !!t && typeof t === "object" && (t.role === "user" || t.role === "agent") && typeof t.text === "string")
        .slice(-10)
        .map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }))
    : [];
  return { message, history, profile: cleanProfile(b.profile), lang: toLang(b.lang ?? b.language) ?? "en" };
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

/** A self-contained markdown report: what we understood, results with reasons, questions, next steps, trace. */
export function toMarkdown(r: AgentResult): string {
  const hi = tl(r.lang) === "hi";
  const eligible = r.schemes.filter((s) => s.verdict === "eligible");
  const maybe = r.schemes.filter((s) => s.verdict === "needs_info");
  const totals = benefitTotals(r.schemes);
  const top = [...eligible].sort((a, b) => (b.cashValue ?? 0) - (a.cashValue ?? 0))[0];
  const topScheme = top && SCHEMES.find((s) => s.id === top.id);
  const name = (s: SchemeResult) => (hi ? `${s.name_hi} (${s.name})` : s.name);
  const out: string[] = [];

  out.push(hi ? "# योजना साथी: आपकी योजनाएँ" : "# Yojana Saathi: your scheme check", "");
  if (r.mode === "groq" && r.reply) out.push(r.reply, "");
  const understood = describeProfile(r.profile, r.lang);
  if (understood) out.push(`**${hi ? "मैंने समझा" : "What I understood"}:** ${understood}`, "");

  if (eligible.length) {
    out.push(`## ${hi ? `आप ${eligible.length} योजनाओं के पात्र हैं` : `You qualify for ${eligible.length} scheme${eligible.length > 1 ? "s" : ""}`}`, "");
    if (totals.yearly || totals.once) {
      out.push(`${hi ? "नकद सहायता" : "Cash support"}: **₹${totals.yearly.toLocaleString("en-IN")}${hi ? "/साल" : " a year"}**${totals.once ? ` + ₹${totals.once.toLocaleString("en-IN")} ${hi ? "एक बार" : "one-time"}` : ""}`, "");
    }
    out.push(hi ? "| योजना | लाभ | क्यों |" : "| Scheme | Benefit | Why you qualify |", "|---|---|---|");
    for (const s of eligible) out.push(`| ${cell(name(s))} | ${cell(s.benefit)} | ${cell(s.rules.filter((x) => x.outcome === "pass").map((x) => x.label).join("; "))} |`);
    out.push("");
  } else {
    out.push(`## ${hi ? "अभी किसी योजना की पुष्टि नहीं हुई" : "No scheme confirmed yet"}`, "");
  }

  if (maybe.length && r.followUps.length) {
    out.push(`## ${hi ? `${maybe.length} और योजनाएँ मिल सकती हैं, ये बताइए` : `${maybe.length} more could fit. Answer these to check`}`, "");
    r.followUps.forEach((q, i) => out.push(`${i + 1}. ${q}`));
    out.push("", `${hi ? "संभावित" : "Possible"}: ${maybe.slice(0, 8).map(name).join(", ")}`, "");
  }

  if (topScheme) {
    out.push(`## ${hi ? "अगला कदम" : "Next step"}: ${hi ? topScheme.name_hi : topScheme.name}`, "");
    out.push(`**${hi ? "ज़रूरी कागज़" : "Documents to carry"}:**`, ...topScheme.documents.map((d) => `- ${d}`), "");
    out.push(`**${hi ? "आवेदन कैसे करें" : "How to apply"}:**`, ...topScheme.howToApply.map((s, i) => `${i + 1}. ${s}`), "");
    out.push(`${hi ? "आधिकारिक स्रोत" : "Official source"}: ${topScheme.source}`, "");
    out.push(`### ${hi ? "आवेदन सहायक पत्र" : "Application helper sheet"}`, "", "```", draftApplication(topScheme, r.profile), "```", "");
  }

  out.push(`## ${hi ? "एजेंट ने क्या किया" : "How the agent worked"}`, "");
  r.trace.filter((s) => s.kind !== "answer").forEach((s, i) => out.push(`${i + 1}. ${s.title}${s.tool ? ` (\`${s.tool}\`${s.ms !== undefined ? `, ${s.ms} ms` : ""})` : ""}`));
  out.push(
    "",
    `_${hi ? "यह सरकारी सेवा नहीं है। आवेदन से पहले कार्यालय या आधिकारिक साइट पर पात्रता की पुष्टि करें।" : "Not a government service. Confirm eligibility at the office or official site before applying."} (${r.mode === "groq" ? `Groq ${r.model ?? ""}`.trim() : "offline rules"})_`,
  );
  return out.join("\n");
}
