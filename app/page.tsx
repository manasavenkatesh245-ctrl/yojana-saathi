"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import schemesData from "@/data/schemes.json";
import { benefitTotals, draftApplication, FIELDS } from "@/lib/engine.ts";
import { isLang, LANGS, type AgentEvent, type ChatTurn, type Lang, type Profile, type ProfileField, type Scheme, type SchemeResult, type TraceStep } from "@/lib/types.ts";
import { SAMPLES, t as strings, type Strings } from "./i18n.ts";

const SCHEMES = schemesData as Scheme[];
// Plain reduce, not Object.groupBy: that crashes on iOS Safari before 17.4.
const BY_CATEGORY = SCHEMES.reduce<Record<string, Scheme[]>>((acc, s) => ((acc[s.category] ??= []).push(s), acc), {});
/** Field labels and questions are hand-written in English and Hindi; Marathi reads the Hindi (same script). */
const fl = (l: Lang): 0 | 1 => (l === "hi" || l === "mr" ? 1 : 0);

const PF: Partial<Record<ProfileField, [string, string]>> = {
  age: ["Age", "उम्र"], gender: ["Gender", "लिंग"], maritalStatus: ["Marital status", "वैवाहिक स्थिति"], state: ["State", "राज्य"],
  district: ["District", "ज़िला"], pincode: ["PIN code", "पिन कोड"], area: ["Lives in", "रहते हैं"], occupation: ["Work", "काम"],
  annualIncome: ["Family income / year", "परिवार की सालाना आय"], category: ["Category", "श्रेणी"], educationLevel: ["Studying", "पढ़ाई"],
  bpl: ["BPL / Antyodaya card", "BPL / अंत्योदय कार्ड"], hasBankAccount: ["Bank account", "बैंक खाता"], hasLpg: ["LPG connection", "LPG कनेक्शन"],
  ownsPuccaHouse: ["Owns pucca house", "पक्का मकान"], ownsLand: ["Owns farmland", "खेती की ज़मीन"], disabilityPercent: ["Disability %", "विकलांगता %"],
  isPregnant: ["Pregnant / new mother", "गर्भवती / नई माँ"], hasDaughterUnder10: ["Daughter under 10", "10 से कम उम्र की बेटी"],
  paysIncomeTax: ["Pays income tax", "इनकम टैक्स"], isGovtEmployee: ["Govt employee in family", "परिवार में सरकारी कर्मचारी"],
  inEpfoOrEsic: ["PF / ESIC", "PF / ESIC"], wantsToStartBusiness: ["Wants business loan", "व्यवसाय ऋण चाहिए"], class12Top20: ["Top 20% in Class 12", "12वीं में शीर्ष 20%"],
};

// Readable labels for coded values (English / Hindi; other languages show the English).
const VAL: Record<string, [string, string]> = {
  female: ["Woman", "महिला"], male: ["Man", "पुरुष"], other: ["Other", "अन्य"], married: ["Married", "विवाहित"], widowed: ["Widowed", "विधवा/विधुर"],
  single: ["Single", "अविवाहित"], divorced: ["Divorced", "तलाकशुदा"], rural: ["Village", "गाँव"], urban: ["Town / city", "शहर"],
  general: ["General", "सामान्य"], obc: ["OBC", "OBC"], sc: ["SC", "SC"], st: ["ST", "ST"], school: ["School", "स्कूल"], post_matric: ["Class 11–12 / diploma", "11वीं–12वीं / डिप्लोमा"],
  graduate: ["College", "कॉलेज"], farmer: ["Farmer", "किसान"], agri_labourer: ["Farm labourer", "खेतिहर मज़दूर"], fisher: ["Fisher", "मछुआरा"], student: ["Student", "छात्र"],
  artisan: ["Artisan", "कारीगर"], street_vendor: ["Street vendor", "रेहड़ी-पटरी विक्रेता"], small_business: ["Small business", "छोटा व्यापार"], unorganised_worker: ["Daily-wage worker", "दिहाड़ी मज़दूर"],
  salaried: ["Salaried", "नौकरीपेशा"], govt_employee: ["Government employee", "सरकारी कर्मचारी"], unemployed: ["Looking for work", "बेरोज़गार"], homemaker: ["Homemaker", "गृहिणी"], retired: ["Retired", "सेवानिवृत्त"],
};
const fmt = (k: ProfileField, v: unknown, t: Strings, l: Lang) =>
  typeof v === "boolean" ? (v ? t.yes : t.no) : k === "annualIncome" ? `₹${Number(v).toLocaleString("en-IN")}` : k === "disabilityPercent" ? `${v}%` : VAL[String(v)]?.[fl(l)] ?? String(v);

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const cssVar = (name: string, v: number) => ({ [name]: v }) as CSSProperties;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Numbers count up to their new value (ease-out cubic). Interruptible: a new target starts from what's on screen. */
function CountUp({ value, format = String }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const cur = useRef(value);
  useEffect(() => {
    const from = cur.current;
    if (from === value || reducedMotion()) { cur.current = value; setShown(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 800);
      cur.current = Math.round(from + (value - from) * (1 - (1 - p) ** 3));
      setShown(cur.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // rAF pauses in hidden tabs; the timer guarantees the true final value lands regardless.
    const settle = setTimeout(() => { cur.current = value; setShown(value); }, 850);
    return () => { cancelAnimationFrame(raf); clearTimeout(settle); };
  }, [value]);
  return <>{format(shown)}</>;
}

/* Inline SVG icons (no emoji, no icon dependency). */
const I = {
  pass: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  unknown: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M7.8 8a2.3 2.3 0 114 1.6c-.9.6-1.8 1.1-1.8 2.2M10 14.6v.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  fail: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>,
  mic: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  stop: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>,
  send: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h12M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  out: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  doc: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5M7.5 15h3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>,
  clip: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M14.5 9.5l-5.8 5.8a3.5 3.5 0 01-5-5L10 3.9a2.3 2.3 0 013.3 3.3l-6.3 6.3a1.2 1.2 0 01-1.7-1.7L11 6.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  globe: <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 10h15M10 2.5c2.2 2.2 2.2 12.8 0 15M10 2.5c-2.2 2.2-2.2 12.8 0 15" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>,
};

/** Tiny safe formatter for agent replies: paragraphs, "-"/"1." lists, **bold**. No HTML injection. */
function Rich({ text }: { text: string }) {
  const bold = (s: string) => s.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>));
  const blocks: { type: "p" | "ul" | "ol"; items: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const ul = line.match(/^[-*•]\s+(.*)/);
    const ol = line.match(/^\d+[.)]\s+(.*)/);
    const type = ul ? "ul" : ol ? "ol" : "p";
    const content = (ul ?? ol)?.[1] ?? line;
    const last = blocks.at(-1);
    if (type !== "p" && last?.type === type) last.items.push(content);
    else blocks.push({ type, items: [content] });
  }
  return (
    <>
      {blocks.map((b, i) => {
        const style = cssVar("--b", Math.min(i, 8));
        return b.type === "p" ? <p key={i} style={style}>{bold(b.items[0])}</p>
          : b.type === "ul" ? <ul key={i} style={style}>{b.items.map((x, j) => <li key={j}>{bold(x)}</li>)}</ul>
          : <ol key={i} style={style}>{b.items.map((x, j) => <li key={j}>{bold(x)}</li>)}</ol>;
      })}
    </>
  );
}

type SpeechRec = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type SpeechCtor = new () => SpeechRec;
const browserSpeech = () => {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};
const canRecord = () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** Any photo or PDF -> a JPEG of at most 1600 px (smaller upload, fewer tokens, same legibility). */
async function toJpeg(file: File): Promise<Blob> {
  const canvas = document.createElement("canvas");
  if (file.type === "application/pdf") {
    // ponytail: first page only; certificates are one page. Loaded only when someone picks a PDF.
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const page = await (await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise).getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, 1600 / Math.max(base.width, base.height)) });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, viewport }).promise;
  } else {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  }
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("encode"))), "image/jpeg", 0.85));
}

type Turn = ChatTurn & { file?: { name: string; preview: string } };

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [profile, setProfile] = useState<Profile>({});
  const [schemes, setSchemes] = useState<SchemeResult[]>([]);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [drafted, setDrafted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState<{ mode: string; model?: string; speech?: string; documents?: boolean }>({ mode: "" });
  const [doc, setDoc] = useState<{ name: string; preview: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [voice, setVoice] = useState<"none" | "whisper" | "browser">("none");
  const [rec, setRec] = useState<"idle" | "recording" | "transcribing">("idle");
  const [secs, setSecs] = useState(0);
  const [draft, setDraft] = useState<{ title: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const t: Strings = strings(lang);

  useEffect(() => {
    try { const saved = localStorage.getItem("ys-lang"); if (isLang(saved)) setLang(saved); } catch { /* storage unavailable */ }
    fetch("/api/agent")
      .then((r) => r.json())
      .then((d: { mode: string; speech?: string; documents?: boolean }) => {
        setEngine({ mode: d.mode, speech: d.speech, documents: d.documents });
        setVoice(d.speech === "whisper" && canRecord() ? "whisper" : browserSpeech() ? "browser" : "none");
      })
      .catch(() => setVoice(browserSpeech() ? "browser" : "none"));
  }, []);

  useEffect(() => {
    if (messages.length) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, busy]);

  useEffect(() => {
    if (draft) dialogRef.current?.showModal();
  }, [draft]);

  // Recording clock; auto-stop at 60 s so a forgotten mic can't run forever.
  useEffect(() => {
    if (rec !== "recording") return;
    setSecs(0);
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [rec]);
  useEffect(() => {
    if (rec === "recording" && secs >= 60) stopRef.current?.();
  }, [rec, secs]);

  function handle(e: AgentEvent) {
    if (e.type === "trace") setTrace((s) => [...s, e.step]);
    else if (e.type === "profile") setProfile(e.profile);
    else if (e.type === "schemes") setSchemes(e.schemes);
    else if (e.type === "draft") setDrafted((d) => ({ ...d, [e.schemeId]: true }));
    else if (e.type === "reply") setMessages((m) => [...m, { role: "agent", text: e.text }]);
    else if (e.type === "done") setEngine((x) => ({ ...x, mode: e.result.mode, model: e.result.model }));
    else if (e.type === "error") setError(e.message);
  }

  async function send(text: string, extra?: Profile, file?: Turn["file"]) {
    const message = text.trim();
    if (!message || busy) return;
    stopRef.current?.();
    setInput("");
    setError("");
    setBusy(true);
    setTrace([]);
    const history = messages.slice(-10).map(({ role, text }) => ({ role, text }));
    setMessages((m) => [...m, { role: "user", text: message, file }]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history, profile: { ...profile, ...extra }, lang, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Error ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) handle(JSON.parse(l) as AgentEvent);
      }
    } catch (err) {
      setError((err as Error).message || "Network error. Please try again.");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  /** Photo / PDF -> facts (server reads it, IDs never kept) -> straight into the case, then the agent re-checks. */
  async function readDocument(file: File | undefined) {
    if (!file || doc || busy) return;
    if (!/^image\/|application\/pdf/.test(file.type)) return setError(t.docHint);
    setError("");
    let preview = "";
    try {
      const jpeg = await toJpeg(file);
      preview = URL.createObjectURL(jpeg);
      setDoc({ name: file.name, preview });
      const fd = new FormData();
      fd.append("file", jpeg, "document.jpg");
      fd.append("lang", lang);
      const res = await fetch("/api/document", { method: "POST", body: fd });
      const data = (await res.json()) as { docType?: string; facts?: Profile; summary?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      setDoc(null);
      await send(`${t.myDoc} (${data.docType}): ${data.summary || JSON.stringify(data.facts)}`, data.facts, { name: file.name, preview });
    } catch (e) {
      setDoc(null);
      if (preview) URL.revokeObjectURL(preview);
      setError((e as Error).message && (e as Error).message !== "encode" ? (e as Error).message : "Could not open this file. Try a JPG or PNG photo.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const appendText = (text: string) => text && setInput((prev) => `${prev ? prev.trimEnd() + " " : ""}${text}`);

  /** Server speech-to-text: record clean mono audio, send to Whisper, put the text in the box to review. */
  async function recordWhisper() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      return setError(t.micBlocked);
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
    const mr = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      stopRef.current = null;
      setRec("transcribing");
      try {
        const fd = new FormData();
        fd.append("audio", new Blob(chunks, { type: mr.mimeType }), "speech");
        fd.append("lang", lang);
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = (await res.json()) as { text?: string; error?: string };
        if (!res.ok) throw new Error(data.error);
        appendText(data.text ?? "");
      } catch (e) {
        setError((e as Error).message || "Could not transcribe. Please try again.");
      } finally {
        setRec("idle");
        inputRef.current?.focus();
      }
    };
    stopRef.current = () => { if (mr.state !== "inactive") mr.stop(); };
    mr.start();
    setError("");
    setRec("recording");
  }

  /** Fallback: the browser's own recogniser (Chrome / Edge / Safari). */
  function recordBrowser() {
    const Ctor = browserSpeech();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = LANGS[lang].stt;
    r.interimResults = false;
    r.onresult = (e) => appendText(e.results[0][0].transcript);
    r.onend = () => { stopRef.current = null; setRec("idle"); };
    r.onerror = () => { stopRef.current = null; setRec("idle"); };
    stopRef.current = () => r.stop();
    r.start();
    setRec("recording");
  }

  function toggleMic() {
    if (rec === "recording") return stopRef.current?.();
    if (rec === "transcribing") return;
    if (voice === "whisper") void recordWhisper();
    else recordBrowser();
  }

  function switchLang(next: Lang) {
    try { localStorage.setItem("ys-lang", next); } catch { /* storage unavailable */ }
    if (next === lang) return;
    type VT = { ready: Promise<void>; finished: Promise<void> };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => VT };
    if (!doc.startViewTransition || reducedMotion() || document.hidden) return setLang(next);
    const vt = doc.startViewTransition(() => flushSync(() => setLang(next)));
    // The update still applies if the browser skips the animation; nothing to recover.
    vt.ready.catch(() => {});
    vt.finished.catch(() => {});
  }

  function reset() {
    setMessages([]); setProfile({}); setSchemes([]); setTrace([]); setDrafted({}); setError(""); setInput("");
    inputRef.current?.focus();
  }

  function openDraft(id: string) {
    const s = SCHEMES.find((x) => x.id === id);
    if (s) { setCopied(false); setDraft({ title: s.name, text: draftApplication(s, profile) }); }
  }

  const eligible = schemes.filter((s) => s.verdict === "eligible");
  const maybe = schemes.filter((s) => s.verdict === "needs_info");
  const nope = schemes.filter((s) => s.verdict === "not_eligible");
  const totals = benefitTotals(schemes);
  const covers = eligible.filter((s) => s.coverage).length;
  const known = (Object.keys(PF) as ProfileField[]).filter((k) => profile[k] !== undefined);
  const lastStep = trace.at(-1);
  const showHindiName = lang === "hi" || lang === "mr";
  const engineLabel = engine.mode === "groq" ? `Groq${engine.model ? ` · ${engine.model.split("/").pop()}` : ""}` : engine.mode === "offline" ? "Offline rules" : "";
  const status = rec === "recording" ? `${t.listening} ${clock(secs)}` : rec === "transcribing" ? t.transcribing : busy ? `${t.working}${lastStep ? `: ${lastStep.title}` : ""}…` : schemes.length ? t.found(eligible.length) : "";

  // Key includes the verdict so the stamp lands again when a new answer changes it.
  const card = (s: SchemeResult, i: number) => (
    <article key={`${s.id}-${s.verdict}`} className="card" data-verdict={s.verdict} style={cssVar("--i", Math.min(i, 8))}>
      <div className="card-head">
        <h4>
          {showHindiName ? s.name_hi : s.name}
          {(lang === "en" || showHindiName) && <span className="alt" lang={showHindiName ? "en" : "hi"}>{showHindiName ? s.name : s.name_hi}</span>}
        </h4>
        <span className={`stamp stamp--${s.verdict}`}>{t.stamp[s.verdict]}</span>
      </div>
      <p className="benefit">{s.benefit}</p>
      <ul className="rules" aria-label="Eligibility checks">
        {s.rules.map((r, i) => (
          <li key={i} data-o={r.outcome}>
            {I[r.outcome]}
            <span><span className="sr-only">{r.outcome === "pass" ? "Met: " : r.outcome === "fail" ? "Not met: " : "Unknown: "}</span>{r.label}</span>
          </li>
        ))}
      </ul>
      {s.verdict === "needs_info" && (
        <div className="ask">
          <strong>{t.tellMe}</strong>
          <ul>{s.missing.map((f) => <li key={f}>{FIELDS[f].q[fl(lang) ? "hi" : "en"]}</li>)}</ul>
        </div>
      )}
      <div className="card-actions">
        {s.verdict === "eligible" && (
          <button className="btn btn--primary" onClick={() => openDraft(s.id)}>{I.doc}{t.draft}</button>
        )}
        <a className="btn" href={s.source} target="_blank" rel="noopener noreferrer">{t.source}{I.out}<span className="sr-only"> (opens in new tab)</span></a>
        {drafted[s.id] && <span className="ready">{t.ready}</span>}
      </div>
    </article>
  );

  return (
    <div lang={lang} className="app">
      <a className="skip" href="#composer">Skip to message box</a>
      <header className="masthead">
        <div className="brand">
          <svg className="seal" viewBox="0 0 44 44" aria-hidden="true">
            <circle cx="22" cy="22" r="20" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="22" cy="22" r="16" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
            <path d="M14.5 22.5l5 5 10-11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1>Yojana Saathi<span lang="hi">योजना साथी</span></h1>
            <p>{t.tagline}</p>
          </div>
        </div>
        <div className="tools">
          {engineLabel && <span className="badge" title="Reasoning engine">{engineLabel}</span>}
          <label className="lang-select">
            {I.globe}
            <span className="sr-only">{t.language}</span>
            <select value={lang} onChange={(e) => switchLang(e.target.value as Lang)} aria-label={`${t.language} / Language`}>
              {(Object.entries(LANGS) as [Lang, (typeof LANGS)[Lang]][]).map(([code, l]) => (
                <option key={code} value={code} lang={code}>{code === "en" ? l.native : `${l.native} · ${l.name}`}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={reset} disabled={busy}>{t.newCase}</button>
        </div>
      </header>

      <main className="shell">
        <section className="panel desk" aria-labelledby="convo-h">
          <div className="panel-head"><h2 id="convo-h">{t.convo}</h2></div>
          <div className="log" ref={logRef}>
            {!messages.length && (
              <div className="intro">
                <h2>{t.introTitle}</h2>
                <p>{t.introBody}</p>
                <ol className="steps">{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                <p className="eyebrow">{t.tryOne}</p>
                <div className="samples">
                  {SAMPLES[lang].map((s) => (
                    <button key={s.who} className="sample" onClick={() => send(s.text)} disabled={busy}>
                      <b>{s.who}</b>{s.text}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`entry entry--${m.role}`}>
                <div className="who">{m.role === "user" ? t.you : t.saathi}</div>
                {m.file && <figure className="attachment"><img src={m.file.preview} alt="" /><figcaption>{m.file.name}</figcaption></figure>}
                {m.role === "agent" ? <Rich text={m.text} /> : <p>{m.text}</p>}
              </div>
            ))}
          </div>
          <form
            className="composer"
            data-dragging={dragging || undefined}
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            onDragOver={(e) => { if (engine.documents && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (engine.documents) void readDocument(e.dataTransfer.files[0]); }}
            aria-busy={busy}
          >
            {(busy || rec === "transcribing" || !!doc) && <div className="busybar" aria-hidden="true" />}
            {dragging && <div className="dropzone" aria-hidden="true">{t.dropHere}</div>}
            <label htmlFor="composer">{t.label}</label>
            {doc && (
              <div className="doc-chip" role="status">
                <img src={doc.preview} alt="" />
                <span><strong>{doc.name}</strong>{t.reading}</span>
              </div>
            )}
            <textarea
              id="composer"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
              onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/")); if (f && engine.documents) { e.preventDefault(); void readDocument(f); } }}
              aria-describedby="composer-hint"
              maxLength={2000}
            />
            <p id="composer-hint" className="hint">{t.hint}</p>
            {engine.documents && <span id="doc-hint" className="sr-only">{t.docHint}</span>}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="composer-row">
              <p className="status" role="status" aria-atomic="true">{status}</p>
              {!busy && rec === "idle" && !!schemes.length && <a className="jump" href="#results">{t.seeResults}</a>}
              {engine.documents && (
                <>
                  <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => void readDocument(e.target.files?.[0])} />
                  <button type="button" className="btn btn--icon" onClick={() => fileRef.current?.click()} disabled={busy || !!doc || rec !== "idle"} aria-label={t.attach} aria-describedby="doc-hint" title={`${t.attach}\n${t.docHint}`}>
                    {I.clip}
                  </button>
                </>
              )}
              {voice !== "none" && (
                <button
                  type="button"
                  className="btn btn--icon mic"
                  onClick={toggleMic}
                  disabled={rec === "transcribing" || busy}
                  aria-pressed={rec === "recording"}
                  aria-label={rec === "recording" ? t.stop : t.speak}
                  title={rec === "recording" ? t.stop : t.speak}
                >
                  {rec === "recording" ? I.stop : I.mic}
                </button>
              )}
              <button type="submit" className="btn btn--primary" disabled={busy || rec !== "idle" || !input.trim()}>{t.send}{I.send}</button>
            </div>
          </form>
        </section>

        <div className="casefile">
          {!schemes.length && (
            <section className="panel" aria-labelledby="checks-h">
              <div className="panel-head"><h2 id="checks-h">{t.checks}</h2><span className="eyebrow">{t.checksSub}</span></div>
              <ul className="coverage">
                {Object.entries(BY_CATEGORY).map(([cat, list], i) => (
                  <li key={cat} style={cssVar("--i", i)}>
                    <strong className="num">{list.length}</strong>
                    <span>{t.cats[cat] ?? cat}</span>
                    <small>{list.slice(0, 3).map((s) => (fl(lang) ? s.name_hi : s.name)).join(" · ")}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!schemes.length && <section className="panel section" aria-labelledby="impact-h">
            <h2 id="impact-h" className="sr-only">{t.impact}</h2>
            <div className="impact">
              <div><strong><CountUp value={totals.eligibleCount} /></strong><span>{t.eligibleN}</span></div>
              <div><strong><CountUp value={totals.yearly} format={rupees} /></strong><span>{t.perYear}</span></div>
              <div><strong><CountUp value={totals.once} format={rupees} /></strong><span>{t.once}</span></div>
              <div><strong><CountUp value={covers} /></strong><span>{t.covers}</span></div>
            </div>
          </section>}

          <section className="panel" aria-labelledby="facts-h">
            <div className="panel-head"><h2 id="facts-h">{t.particulars}</h2><span className="eyebrow">{t.known(known.length)}</span></div>
            <div className="section">
              {known.length ? (
                <dl className="particulars">
                  {known.map((k) => <div key={`${k}:${String(profile[k])}`}><dt>{PF[k]![fl(lang)]}</dt><dd>{fmt(k, profile[k], t, lang)}</dd></div>)}
                </dl>
              ) : <p className="empty">{t.noFacts}</p>}
            </div>
          </section>

          <section className="panel" aria-labelledby="trace-h">
            <div className="panel-head"><h2 id="trace-h">{t.trace}</h2><span className="eyebrow">{t.traceSub}</span></div>
            <div className="section">
              {trace.length ? (
                <ol className="trace">
                  {trace.map((s, i) => (
                    <li key={s.id} data-kind={s.kind}>
                      <span className="no">{String(i + 1).padStart(2, "0")}</span>
                      <div>
                        <div className="line">
                          <span className="title">{s.title}</span>
                          {s.tool && <code>{s.tool}()</code>}
                          {s.ms !== undefined && <span className="ms">{s.ms} ms</span>}
                        </div>
                        {(s.input !== undefined || s.output !== undefined) && (
                          <details>
                            <summary>{t.details}</summary>
                            <pre>{JSON.stringify({ input: s.input, output: s.output }, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    </li>
                  ))}
                  {busy && <li><span className="no"><span className="working" aria-hidden="true" /></span><span className="title">{t.working}…</span></li>}
                </ol>
              ) : <p className="empty">{busy ? `${t.working}…` : t.noTrace}</p>}
            </div>
          </section>

          {!!schemes.length && (
            <section className="panel section" aria-labelledby="res-h" id="results" tabIndex={-1}>
              <h2 id="res-h" className="sr-only">{t.impact}</h2>
              {!!eligible.length && (<><div className="group-title"><h3>{t.eligible}</h3><span className="eyebrow num">{eligible.length}</span></div><div className="cards">{eligible.map(card)}</div></>)}
              {!!maybe.length && (<><div className="group-title"><h3>{t.needsInfo}</h3><span className="eyebrow num">{maybe.length}</span></div><div className="cards">{maybe.slice(0, 8).map(card)}</div></>)}
              {!!nope.length && (
                <details className="others">
                  <summary>{t.others(nope.length)}</summary>
                  <ul>{nope.map((s) => <li key={s.id}><strong>{showHindiName ? s.name_hi : s.name}</strong>: {s.rules.find((r) => r.outcome === "fail")?.label ?? ""}</li>)}</ul>
                </details>
              )}
            </section>
          )}
        </div>
      </main>

      <footer className="foot">
        <p>{t.foot1}</p>
        <p>{t.foot2}</p>
      </footer>

      <dialog ref={dialogRef} className="draft" aria-labelledby="draft-h" onClose={() => setDraft(null)}>
        {draft && (
          <>
            <header>
              <div><p className="eyebrow">{t.draftTitle}</p><h2 id="draft-h">{draft.title}</h2></div>
            </header>
            <div className="body"><pre>{draft.text}</pre></div>
            <footer className="no-print">
              <button className="btn" onClick={() => navigator.clipboard?.writeText(draft.text).then(() => setCopied(true))}>{copied ? t.copied : t.copy}</button>
              <button className="btn" onClick={() => window.print()}>{t.print}</button>
              <button className="btn btn--primary" onClick={() => dialogRef.current?.close()} autoFocus>{t.close}</button>
            </footer>
          </>
        )}
      </dialog>
    </div>
  );
}
