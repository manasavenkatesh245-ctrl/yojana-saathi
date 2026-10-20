import type { Profile, Rule, RuleOutcome, RuleResult, Scheme, SchemeResult, ProfileField } from "./types.ts";

/** Three-valued check: a rule on an unknown field is "unknown", never a silent fail. */
export function checkRule(rule: Rule, profile: Profile): RuleOutcome {
  const v = profile[rule.field];
  if (v === undefined || v === null || v === "") return "unknown";
  switch (rule.op) {
    case "eq":
      return v === rule.value ? "pass" : "fail";
    case "ne":
      return v !== rule.value ? "pass" : "fail";
    case "gte":
      return typeof v === "number" && v >= (rule.value as number) ? "pass" : "fail";
    case "lte":
      return typeof v === "number" && v <= (rule.value as number) ? "pass" : "fail";
    case "in":
      return Array.isArray(rule.value) && rule.value.includes(v as string) ? "pass" : "fail";
    case "true":
      return v === true ? "pass" : "fail";
    case "false":
      return v === false ? "pass" : "fail";
  }
}

export function evaluateScheme(scheme: Scheme, profile: Profile): SchemeResult {
  const all: RuleResult[] = scheme.rules.all.map((r) => ({ label: r.label, field: r.field, outcome: checkRule(r, profile) }));
  const anyOf: RuleResult[] = (scheme.rules.anyOf ?? []).map((r) => ({ label: r.label, field: r.field, outcome: checkRule(r, profile) }));

  const allFail = all.some((r) => r.outcome === "fail");
  const allUnknown = all.some((r) => r.outcome === "unknown");
  const anyPass = anyOf.some((r) => r.outcome === "pass");
  const anyAllFail = anyOf.length > 0 && anyOf.every((r) => r.outcome === "fail");
  const anyUnknown = anyOf.length > 0 && !anyPass && !anyAllFail;

  let verdict: SchemeResult["verdict"];
  if (allFail || anyAllFail) verdict = "not_eligible";
  else if (allUnknown || anyUnknown) verdict = "needs_info";
  else verdict = "eligible";

  // For anyOf, only the passing condition matters once one passes; otherwise show all options.
  const shownAny = anyPass ? anyOf.filter((r) => r.outcome === "pass") : anyOf;
  const rules = [...all, ...shownAny];

  const missing = new Set<ProfileField>();
  if (verdict === "needs_info") {
    for (const r of all) if (r.outcome === "unknown") missing.add(r.field);
    if (anyUnknown) for (const r of anyOf) if (r.outcome === "unknown") missing.add(r.field);
  }

  const settled = all.filter((r) => r.outcome === "pass").length + (anyOf.length ? (anyPass ? 1 : 0) : 0);
  const total = all.length + (anyOf.length ? 1 : 0);
  const confidence = verdict === "not_eligible" ? 0 : total === 0 ? 1 : settled / total;

  return {
    id: scheme.id,
    name: scheme.name,
    name_hi: scheme.name_hi,
    category: scheme.category,
    verdict,
    confidence: Math.round(confidence * 100) / 100,
    benefit: scheme.benefit,
    cashValue: scheme.cashValue,
    cashPeriod: scheme.cashPeriod,
    coverage: scheme.coverage,
    rules,
    missing: [...missing],
    source: scheme.source,
  };
}

const ORDER = { eligible: 0, needs_info: 1, not_eligible: 2 } as const;

/** Rank: eligible first, then the closest "needs info" matches, then by cash value. */
export function evaluateAll(schemes: Scheme[], profile: Profile): SchemeResult[] {
  return schemes
    .map((s) => evaluateScheme(s, profile))
    .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.confidence - a.confidence || (b.cashValue ?? 0) - (a.cashValue ?? 0));
}

/** The few questions most likely to confirm a scheme: near-complete schemes weigh more than long shots. */
export function nextQuestions(results: SchemeResult[], limit = 3): ProfileField[] {
  const score = new Map<ProfileField, number>();
  for (const r of results) {
    if (r.verdict !== "needs_info") continue;
    const w = (r.confidence + 0.1) / r.missing.length;
    for (const f of r.missing) score.set(f, (score.get(f) ?? 0) + w);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([f]) => f);
}

type FieldSpec = { type: "number" | "string" | "boolean"; enum?: readonly string[]; desc: string; q: { en: string; hi: string } };

/** Single source of truth for profile fields: validation, LLM tool schema and follow-up questions. */
export const FIELDS: Record<ProfileField, FieldSpec> = {
  name: { type: "string", desc: "First name, only if the user offers it", q: { en: "What should I call you?", hi: "आपका नाम क्या है?" } },
  age: { type: "number", desc: "Age in years", q: { en: "How old are you?", hi: "आपकी उम्र कितनी है?" } },
  gender: { type: "string", enum: ["female", "male", "other"], desc: "Gender", q: { en: "Are you a woman or a man?", hi: "आप महिला हैं या पुरुष?" } },
  maritalStatus: { type: "string", enum: ["married", "widowed", "single", "divorced"], desc: "Marital status", q: { en: "Are you married, widowed or single?", hi: "आप विवाहित हैं, विधवा/विधुर हैं या अविवाहित?" } },
  state: { type: "string", desc: "Indian state or UT", q: { en: "Which state do you live in?", hi: "आप किस राज्य में रहते हैं?" } },
  district: { type: "string", desc: "District", q: { en: "Which district?", hi: "कौन सा जिला?" } },
  pincode: { type: "string", desc: "6-digit PIN code", q: { en: "What is your PIN code? (to find the nearest help centre)", hi: "आपका पिन कोड क्या है? (नज़दीकी सहायता केंद्र के लिए)" } },
  area: { type: "string", enum: ["rural", "urban"], desc: "Lives in a village (rural) or town/city (urban)", q: { en: "Do you live in a village or a town/city?", hi: "आप गाँव में रहते हैं या शहर में?" } },
  annualIncome: { type: "number", desc: "Total household income in rupees per YEAR (convert monthly x12)", q: { en: "Roughly how much does your whole family earn in a year?", hi: "आपके पूरे परिवार की साल भर की कमाई लगभग कितनी है?" } },
  category: { type: "string", enum: ["general", "obc", "sc", "st"], desc: "Social category", q: { en: "Do you belong to SC, ST, OBC or General category?", hi: "आपकी श्रेणी क्या है: SC, ST, OBC या सामान्य?" } },
  occupation: {
    type: "string",
    enum: ["farmer", "agri_labourer", "fisher", "student", "artisan", "street_vendor", "small_business", "unorganised_worker", "salaried", "govt_employee", "unemployed", "homemaker", "retired", "other"],
    desc: "Main work",
    q: { en: "What work do you do?", hi: "आप क्या काम करते हैं?" },
  },
  educationLevel: { type: "string", enum: ["school", "post_matric", "graduate"], desc: "For students: school (up to class 10), post_matric (class 11-12 / diploma), graduate (college/university)", q: { en: "Which class or course are you studying in?", hi: "आप किस कक्षा या कोर्स में पढ़ रहे हैं?" } },
  bpl: { type: "boolean", desc: "Has a BPL / Antyodaya / priority-household ration card", q: { en: "Do you have a BPL or Antyodaya ration card?", hi: "क्या आपके पास BPL या अंत्योदय राशन कार्ड है?" } },
  hasBankAccount: { type: "boolean", desc: "Has any bank or post office account", q: { en: "Do you have a bank account?", hi: "क्या आपका बैंक खाता है?" } },
  hasLpg: { type: "boolean", desc: "Household already has an LPG gas connection", q: { en: "Does your home have an LPG gas connection?", hi: "क्या आपके घर में LPG गैस कनेक्शन है?" } },
  ownsPuccaHouse: { type: "boolean", desc: "Family owns a pucca (permanent) house", q: { en: "Does your family own a pucca (brick/concrete) house?", hi: "क्या आपके परिवार का अपना पक्का मकान है?" } },
  ownsLand: { type: "boolean", desc: "Family owns farmland in their name", q: { en: "Is there farmland in your family's name?", hi: "क्या आपके परिवार के नाम पर खेती की ज़मीन है?" } },
  disabilityPercent: { type: "number", desc: "Certified disability percentage, 0 if none", q: { en: "Do you have a disability certificate? What percentage?", hi: "क्या आपके पास विकलांगता प्रमाणपत्र है? कितने प्रतिशत?" } },
  isPregnant: { type: "boolean", desc: "Currently pregnant or delivered recently", q: { en: "Are you pregnant or did you recently have a baby?", hi: "क्या आप गर्भवती हैं या हाल ही में बच्चा हुआ है?" } },
  hasDaughterUnder10: { type: "boolean", desc: "Has a daughter younger than 10", q: { en: "Do you have a daughter under 10 years old?", hi: "क्या आपकी 10 साल से कम उम्र की बेटी है?" } },
  paysIncomeTax: { type: "boolean", desc: "Anyone in the family paid income tax last year", q: { en: "Did anyone in your family pay income tax last year?", hi: "क्या पिछले साल परिवार में किसी ने इनकम टैक्स भरा?" } },
  isGovtEmployee: { type: "boolean", desc: "Applicant or family member is a serving/retired government employee", q: { en: "Is anyone in your family a government employee?", hi: "क्या परिवार में कोई सरकारी कर्मचारी है?" } },
  inEpfoOrEsic: { type: "boolean", desc: "Member of EPFO (PF), ESIC or NPS", q: { en: "Do you get PF (EPFO) or ESIC at work?", hi: "क्या आपको काम पर PF या ESIC मिलता है?" } },
  wantsToStartBusiness: { type: "boolean", desc: "Wants to start or expand a small business", q: { en: "Do you want to start or grow a small business?", hi: "क्या आप छोटा व्यवसाय शुरू करना या बढ़ाना चाहते हैं?" } },
  class12Top20: { type: "boolean", desc: "Scored above the 80th percentile in Class 12 board", q: { en: "Were you in the top 20% of your Class 12 board results?", hi: "क्या आप 12वीं बोर्ड में शीर्ष 20% में थे?" } },
};

/** Trust boundary: keep only known fields with valid types and ranges. */
export function cleanProfile(input: unknown): Profile {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out as Profile;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.hasOwn(FIELDS, key)) continue;
    const spec = FIELDS[key as ProfileField];
    if (raw === null || raw === undefined || raw === "") continue;
    if (spec.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,₹\s]/g, ""));
      const max = key === "age" ? 120 : key === "disabilityPercent" ? 100 : 1e10;
      if (Number.isFinite(n) && n >= 0 && n <= max) out[key] = Math.round(n);
    } else if (spec.type === "boolean") {
      if (typeof raw === "boolean") out[key] = raw;
      else if (raw === "true" || raw === "false") out[key] = raw === "true";
    } else {
      const s = String(raw).trim();
      if (spec.enum) {
        if (spec.enum.includes(s.toLowerCase())) out[key] = s.toLowerCase();
      } else {
        // Free text (name, state, district) is echoed into markdown and drafts: letters, digits, basic punctuation only.
        const clean = s.replace(/[^\p{L}\p{M}\p{N} .,'-]/gu, "").trim().slice(0, 60);
        if (clean) out[key] = clean;
      }
    }
  }
  if (out.pincode !== undefined && !/^[1-9]\d{5}$/.test(String(out.pincode))) delete out.pincode;
  return out as Profile;
}

const LABEL: Partial<Record<ProfileField, string>> = {
  age: "Age", gender: "Gender", maritalStatus: "Marital status", state: "State", district: "District", pincode: "PIN code",
  area: "Area", annualIncome: "Household income (₹/year)", category: "Category", occupation: "Occupation", educationLevel: "Education",
};

/** A printable pre-filled draft. Never carries ID numbers: those go on the official form only. */
export function draftApplication(scheme: Scheme, profile: Profile, date = new Date()): string {
  const r = evaluateScheme(scheme, profile);
  const line = (k: ProfileField) => `  ${(LABEL[k] ?? k).padEnd(28)} ${profile[k] ?? "________________"}`;
  const mark = { pass: "[x]", unknown: "[?]", fail: "[!]" } as const;
  return [
    `APPLICATION DRAFT: ${scheme.name}`,
    `${scheme.ministry}`,
    `Prepared with Yojana Saathi on ${date.toISOString().slice(0, 10)}. This is a helper sheet, not an official form.`,
    "",
    "APPLICANT",
    `  ${"Name".padEnd(28)} ${profile.name ?? "________________"}`,
    ...(Object.keys(LABEL) as ProfileField[]).map(line),
    `  ${"Aadhaar / bank details".padEnd(28)} Fill on the official form only. Never share them in chat.`,
    "",
    "WHY I QUALIFY",
    ...r.rules.map((x) => `  ${mark[x.outcome]} ${x.label}${x.outcome === "unknown" ? " (confirm at the counter)" : ""}`),
    "",
    "DOCUMENTS TO CARRY",
    ...scheme.documents.map((d) => `  [ ] ${d}`),
    "",
    "STEPS",
    ...scheme.howToApply.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    `BENEFIT: ${scheme.benefit}`,
    scheme.verifyNote ? `NOTE: ${scheme.verifyNote}` : "",
    `Apply: ${scheme.applyUrl}`,
    `Official source: ${scheme.source}`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export function benefitTotals(results: SchemeResult[]) {
  let yearly = 0;
  let once = 0;
  for (const r of results) {
    if (r.verdict !== "eligible" || !r.cashValue) continue;
    if (r.cashPeriod === "once") once += r.cashValue;
    else yearly += r.cashValue;
  }
  return { yearly, once, eligibleCount: results.filter((r) => r.verdict === "eligible").length };
}
