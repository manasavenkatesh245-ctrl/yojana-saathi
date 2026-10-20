/** Supported languages. `stt` is the BCP-47 tag for browser speech; the key is the ISO-639-1 code Whisper uses. */
export const LANGS = {
  en: { name: "English", native: "English", stt: "en-IN", script: /[A-Za-z]/ },
  hi: { name: "Hindi", native: "हिन्दी", stt: "hi-IN", script: /[ऀ-ॿ]/ },
  bn: { name: "Bengali", native: "বাংলা", stt: "bn-IN", script: /[ঀ-৿]/ },
  mr: { name: "Marathi", native: "मराठी", stt: "mr-IN", script: /[ऀ-ॿ]/ },
  te: { name: "Telugu", native: "తెలుగు", stt: "te-IN", script: /[ఀ-౿]/ },
  ta: { name: "Tamil", native: "தமிழ்", stt: "ta-IN", script: /[஀-௿]/ },
  gu: { name: "Gujarati", native: "ગુજરાતી", stt: "gu-IN", script: /[઀-૿]/ },
  kn: { name: "Kannada", native: "ಕನ್ನಡ", stt: "kn-IN", script: /[ಀ-೿]/ },
  ml: { name: "Malayalam", native: "മലയാളം", stt: "ml-IN", script: /[ഀ-ൿ]/ },
  pa: { name: "Punjabi", native: "ਪੰਜਾਬੀ", stt: "pa-IN", script: /[਀-੿]/ },
} as const;
export type Lang = keyof typeof LANGS;
export const isLang = (v: unknown): v is Lang => typeof v === "string" && Object.hasOwn(LANGS, v);

/** Language of a message from its script; Devanagari keeps the chosen language if it is Hindi or Marathi. */
export function detectLang(text: string, chosen: Lang): Lang {
  if (LANGS[chosen].script.test(text) && chosen !== "en") return chosen;
  for (const [code, l] of Object.entries(LANGS) as [Lang, (typeof LANGS)[Lang]][]) if (code !== "en" && code !== "mr" && l.script.test(text)) return code;
  return chosen;
}

export type Gender = "female" | "male" | "other";
export type Area = "rural" | "urban";
export type Category = "general" | "obc" | "sc" | "st";
export type MaritalStatus = "married" | "widowed" | "single" | "divorced";
export type EducationLevel = "school" | "post_matric" | "graduate";
export type Occupation =
  | "farmer"
  | "agri_labourer"
  | "fisher"
  | "student"
  | "artisan"
  | "street_vendor"
  | "small_business"
  | "unorganised_worker"
  | "salaried"
  | "govt_employee"
  | "unemployed"
  | "homemaker"
  | "retired"
  | "other";

/** Everything the agent may learn about a citizen. All optional: unknown is a first-class state. */
export interface Profile {
  name?: string;
  age?: number;
  gender?: Gender;
  maritalStatus?: MaritalStatus;
  state?: string;
  district?: string;
  pincode?: string;
  area?: Area;
  /** Household income, INR per year. */
  annualIncome?: number;
  category?: Category;
  occupation?: Occupation;
  educationLevel?: EducationLevel;
  bpl?: boolean;
  hasBankAccount?: boolean;
  hasLpg?: boolean;
  ownsPuccaHouse?: boolean;
  ownsLand?: boolean;
  disabilityPercent?: number;
  isPregnant?: boolean;
  hasDaughterUnder10?: boolean;
  paysIncomeTax?: boolean;
  isGovtEmployee?: boolean;
  inEpfoOrEsic?: boolean;
  wantsToStartBusiness?: boolean;
  class12Top20?: boolean;
}

export type ProfileField = keyof Profile;

export type RuleOp = "eq" | "ne" | "gte" | "lte" | "in" | "true" | "false";

export interface Rule {
  field: ProfileField;
  op: RuleOp;
  value?: string | number | string[];
  label: string;
}

export interface Scheme {
  id: string;
  name: string;
  name_hi: string;
  ministry: string;
  category: string;
  summary: string;
  benefit: string;
  cashValue?: number;
  cashPeriod?: "year" | "once";
  cashNote?: string;
  coverage?: string;
  verifyNote?: string;
  rules: { all: Rule[]; anyOf?: Rule[] };
  documents: string[];
  howToApply: string[];
  applyUrl: string;
  source: string;
}

export type RuleOutcome = "pass" | "fail" | "unknown";

export interface RuleResult {
  label: string;
  field: ProfileField;
  outcome: RuleOutcome;
}

export type Verdict = "eligible" | "needs_info" | "not_eligible";

export interface SchemeResult {
  id: string;
  name: string;
  name_hi: string;
  category: string;
  verdict: Verdict;
  /** 0..1, share of rules already confirmed. */
  confidence: number;
  benefit: string;
  cashValue?: number;
  cashPeriod?: "year" | "once";
  coverage?: string;
  rules: RuleResult[];
  /** Profile fields that would settle this scheme. */
  missing: ProfileField[];
  source: string;
}

/** One step in the visible agent trace. */
export interface TraceStep {
  id: string;
  kind: "understand" | "tool" | "reason" | "answer" | "error";
  title: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  ms?: number;
}

export interface ChatTurn {
  role: "user" | "agent";
  text: string;
}

export interface AgentRequest {
  message: string;
  history?: ChatTurn[];
  profile?: Profile;
  lang?: Lang;
}

export interface AgentResult {
  reply: string;
  lang: Lang;
  profile: Profile;
  schemes: SchemeResult[];
  trace: TraceStep[];
  followUps: string[];
  mode: "groq" | "offline";
  model?: string;
  drafts: Record<string, string>;
  centres?: unknown;
}

/** Events streamed to the browser as NDJSON. */
export type AgentEvent =
  | { type: "trace"; step: TraceStep }
  | { type: "profile"; profile: Profile }
  | { type: "schemes"; schemes: SchemeResult[] }
  | { type: "draft"; schemeId: string; text: string }
  | { type: "reply"; text: string }
  | { type: "done"; result: AgentResult }
  | { type: "error"; message: string };
