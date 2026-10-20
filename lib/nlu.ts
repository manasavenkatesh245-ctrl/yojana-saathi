import type { Profile, Occupation } from "./types.ts";

// ponytail: keyword/regex understanding for offline mode (no LLM key). Covers common English, Hindi and
// Hinglish phrasing; the Gemini path handles anything richer. Upgrade path: a small local model.

const STATES: [string, RegExp][] = [
  ["Andhra Pradesh", /andhra|आंध्र/i], ["Arunachal Pradesh", /arunachal|अरुणाचल/i], ["Assam", /assam|असम/i],
  ["Bihar", /bihar|बिहार/i], ["Chhattisgarh", /chhattisgarh|chattisgarh|छत्तीसगढ़/i], ["Goa", /\bgoa\b|गोवा/i],
  ["Gujarat", /gujarat|गुजरात/i], ["Haryana", /haryana|हरियाणा/i], ["Himachal Pradesh", /himachal|हिमाचल/i],
  ["Jharkhand", /jharkhand|झारखंड|झारखण्ड/i], ["Karnataka", /karnataka|कर्नाटक/i], ["Kerala", /kerala|केरल/i],
  ["Madhya Pradesh", /[Mm]adhya [Pp]radesh|MADHYA PRADESH|\bMP\b|मध्य प्रदेश|मध्यप्रदेश|[Bb]hopal|[Ii]ndore/], ["Maharashtra", /maharashtra|महाराष्ट्र|mumbai|pune|nagpur/i],
  ["Manipur", /manipur|मणिपुर/i], ["Meghalaya", /meghalaya|मेघालय/i], ["Mizoram", /mizoram|मिज़ोरम|मिजोरम/i],
  ["Nagaland", /nagaland|नागालैंड/i], ["Odisha", /odisha|orissa|ओडिशा|उड़ीसा/i], ["Punjab", /punjab|पंजाब/i],
  ["Rajasthan", /rajasthan|राजस्थान|jaipur/i], ["Sikkim", /sikkim|सिक्किम/i], ["Tamil Nadu", /tamil ?nadu|तमिलनाडु|chennai/i],
  ["Telangana", /telangana|तेलंगाना|hyderabad/i], ["Tripura", /tripura|त्रिपुरा/i],
  ["Uttar Pradesh", /[Uu]ttar [Pp]radesh|UTTAR PRADESH|\bUP\b|उत्तर प्रदेश|यूपी|[Ll]ucknow|[Vv]aranasi/], ["Uttarakhand", /uttarakhand|उत्तराखंड/i],
  ["West Bengal", /bengal|बंगाल|kolkata/i], ["Delhi", /delhi|दिल्ली/i], ["Jammu and Kashmir", /jammu|kashmir|जम्मू|कश्मीर/i],
  ["Ladakh", /ladakh|लद्दाख/i], ["Puducherry", /puducherry|pondicherry|पुडुचेरी/i], ["Chandigarh", /chandigarh|चंडीगढ़/i],
];

const OCCUPATIONS: [Occupation, RegExp][] = [
  ["agri_labourer", /farm ?(labou?r|worker|hand)|agricultural labou?r|khet (mazdoor|majdoor)|work (on|in) (other people'?s|others'?|someone else'?s) (fields?|farms?)|dusron ke khet|खेतिहर मज़?दूर|खेत मज़?दूर|दूसरों के खेत/i],
  ["govt_employee", /(government|govt|sarkari) (job|employee|service|naukri)|सरकारी (नौकरी|कर्मचारी)/i],
  ["student", /\bstudent|studying|pursuing|college|university|chhatra|छात्र|छात्रा|पढ़ाई कर|पढ़ रही|पढ़ रहा|पढ़ती|पढ़ता/i],
  ["street_vendor", /street vendor|hawker|vendor|thela|thele|rehri|pheri|panipuri|golgappa|chaat|(tea|chai) stall|ठेला|ठेले|रेहड़ी|फेरी|sell (\w+ ){0,3}(on|from) (a |the )?(cart|street|road|footpath|pavement)|sell (vegetables|fruits|tea) on/i],
  ["fisher", /fisher|fishing|machhuara|मछुआरा|मछली पकड़/i],
  ["artisan", /carpenter|potter|pottery|tailor|silai|embroider|blacksmith|weav|cobbler|shoe repair|barber|mason|goldsmith|locksmith|artisan|craftsman|basket|toy mak|sculpt|बढ़ई|कुम्हार|दर्जी|सिलाई|कढ़ाई|लोहार|बुनकर|मोची|नाई|राजमिस्त्री|कारीगर/i],
  ["farmer", /farmer|farming|kisan|kheti|cultivat|agricultur|grow (wheat|rice|paddy|crops?|vegetables|sugarcane|cotton|maize|millets?)|tenant farm|sharecrop|bataidar|किसान|खेती|बटाईदार/i],
  ["small_business", /shop ?keeper|my shop|small business|kirana|दुकान|व्यापार/i],
  ["unorganised_worker", /labou?r(er)?\b|daily wage|dihadi|mazdoor|majdoor|मज़?दूर|मजदूरी|दिहाड़ी|construction|brick kiln|bhatta|domestic worker|house ?help|maid|cook in (houses|homes)|sweeper|safai|rag ?picker|kabadi|security guard|painter|plumber|electrician|loader|helper|rickshaw|driver|delivery|घरेलू काम|बर्तन/i],
  ["homemaker", /housewife|homemaker|grihini|गृहिणी/i],
  ["retired", /\bretired|सेवानिवृत्त|रिटायर/i],
  ["unemployed", /unemployed|no job|jobless|berozgar|बेरोज़?गार/i],
  ["salaried", /private job|salaried|company job|naukri karta|नौकरी करता|नौकरी करती/i],
];

const has = (t: string, re: RegExp) => re.test(t);
/** "no X", "do not have X", "doesn't own any X", "without a X": a negation up to two words before the noun. */
const NOT = String.raw`(?:\bno\b|\bnot\b|n'?t|\bwithout\b|\bnever\b)\s+(?:[\w']+\s+){0,2}`;
const neg = (noun: string) => new RegExp(NOT + `(?:${noun})\\b`, "i");

/** Pull every fact we can from one message. Explicit negatives are checked before positives. */
export function extractProfile(raw: string): Profile {
  const p: Profile = {};
  // Devanagari digits -> ASCII, drop scheme names that look like occupations.
  let t = raw.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966)).replace(/pm[\s-]?kisan/gi, "");

  // Daughter's age first, then remove it so it isn't read as the user's age.
  const daughter = t.match(/(?:daughter|beti|बेटी|बिटिया)[^.,;\d]{0,25}?(\d{1,2})\s*(?:-|\s)?(?:years?|yrs?|साल)|(\d{1,2})\s*(?:-|\s)?(?:years?|yrs?|year-old|साल)(?:\s*-?\s*old)?(?:\s*(?:ki|की))?\s*(?:daughter|beti|बेटी|बिटिया)/i);
  if (daughter) {
    p.hasDaughterUnder10 = Number(daughter[1] ?? daughter[2]) < 10;
    t = t.replace(daughter[0], " ");
  }

  const age = t.match(/(?:\bage[d]?\s*(?:is\s*)?|\bi am\s*|\bi'm\s*|उम्र\s*(?:है\s*)?|आयु\s*)(\d{1,3})\b/i) ?? t.match(/\b(\d{1,3})\s*(?:-\s*)?(?:years?|yrs?|साल|वर्ष|बरस)(?!ाना)/i);
  if (age && +age[1] > 0 && +age[1] <= 110) p.age = +age[1];
  const born = t.match(/born in (19[2-9]\d|20[0-2]\d)|(19[2-9]\d|20[0-2]\d) (?:में )?(?:पैदा|जन्म)/i);
  if (born && p.age === undefined) p.age = new Date().getFullYear() - Number(born[1] ?? born[2]);

  // Gender: explicit words, relationships, and Hindi verb endings (karti/karta hoon).
  if (has(t, /\b(widower|my wife|man|male|boy)\b|पुरुष|आदमी|विधुर|(करता|रहता|कमाता|चलाता) (हूँ|हूं)|(karta|rehta|kamata) (hu|hoon)/i)) p.gender = "male";
  if (has(t, /\b(woman|women|female|lady|widow|housewife|my husband|late husband|single mother|mother of|i am a mother)\b|महिला|औरत|विधवा|गृहिणी|पति|(करती|रहती|कमाती|चलाती|पढ़ती) (हूँ|हूं)|(karti|rehti|kamati|padhti) (hu|hoon)/i)) p.gender = "female";

  if (has(t, /widow|vidhwa|विधवा|विधुर|husband (has )?(died|passed|expired|is no more)|lost my (husband|wife)|late husband|wife (has )?(died|passed)|पति (की मृत्यु|का (देहांत|निधन)|नहीं रहे|गुज़र|गुजर)/i)) p.maritalStatus = "widowed";
  else if (has(t, /unmarried|\bsingle\b|not married|अविवाहित|कुंवार/i)) p.maritalStatus = "single";
  else if (has(t, /divorc|तलाक/i)) p.maritalStatus = "divorced";
  else if (has(t, /\bmarried\b|शादीशुदा|विवाहित|my (husband|wife)/i)) p.maritalStatus = "married";

  const state = STATES.find(([, re]) => re.test(t));
  if (state) p.state = state[0];

  if (has(t, /village|\bgaon\b|\bgaa?v\b|gaanv|rural|panchayat|tehsil|hamlet|गाँव|गांव|ग्रामीण|देहात|पंचायत/i)) p.area = "rural";
  else if (has(t, /\bcity\b|\btown\b|urban|shehar|municipal|nagar nigam|colony|apartment|\bflat\b|jhuggi|slum|basti|शहर|नगर|कस्बा|झुग्गी|mumbai|delhi|kolkata|chennai|pune|hyderabad|bengaluru|bangalore/i)) p.area = "urban";

  if (/\bSC\b|scheduled caste|dalit|अनुसूचित जाति/i.test(t) && !/scheduled tribe/i.test(t)) p.category = "sc";
  if (/\bST\b|scheduled tribe|adivasi|tribal|अनुसूचित जनजाति|आदिवासी/.test(t) || /scheduled tribe|adivasi|tribal/i.test(t)) p.category = "st";
  if (/\bOBC\b|other backward|पिछड़ा वर्ग|ओबीसी/i.test(t)) p.category = "obc";
  if (/general category|general caste|सामान्य (वर्ग|श्रेणी)/i.test(t)) p.category = "general";

  const noGovt = has(t, /(no ?one|nobody|no family member) (in my family )?(is |has )?(in )?(a )?(government|govt|sarkari)|not (a )?(government|govt) (employee|job)|सरकारी (नौकरी|कर्मचारी) नहीं/i);
  if (noGovt) p.isGovtEmployee = false;
  const occ = OCCUPATIONS.find(([o, re]) => re.test(t) && !(noGovt && o === "govt_employee"));
  if (occ) p.occupation = occ[0];
  if (occ?.[0] === "govt_employee") p.isGovtEmployee = true;

  // Income: needs a currency/unit, or sits right after an income word.
  const money = /(₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|लाख|thousand|hazar|हज़ार|हजार|k\b)?\s*(?:rupees?|rs|रुपये|रुपए|रु)?\s*(?:a|per|\/|every|in a|प्रति|हर|एक)?\s*(month|monthly|mahina|महीना|महीने|माह|year|yearly|annually|annual|saal|साल|वर्ष|सालाना|day|daily|din|roz|रोज़?|रोजाना|प्रतिदिन|दिन)?/gi;
  const incomeWord = /(income|earn|earning|salary|kamai|kamata|kamati|कमाई|आय|आमदनी|कमाता|कमाती|वेतन|तनख्वाह)[^\d]{0,25}$/i;
  if (has(t, /no (steady |fixed |regular )?(income|earning)|कोई (आय|कमाई) नहीं|आमदनी नहीं/i)) p.annualIncome = 0;
  else for (const m of t.matchAll(money)) {
    const [, cur, num, unit, period] = m;
    const near = incomeWord.test(t.slice(Math.max(0, m.index - 40), m.index));
    let v = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(v) || v <= 0) continue;
    // Money counts as income only beside an income word or a period ("1 lakh a year"); "give me 1 lakh" is not income.
    if (!near && !period) continue;
    if (!(cur || unit) && v < 100) continue;
    if (unit && /lakh|lac|लाख/i.test(unit)) v *= 100000;
    else if (unit) v *= 1000;
    // ponytail: daily wage x 300 working days, monthly x 12; a bare number under 50k is read as monthly.
    const daily = !!period && /day|daily|din|roz|रोज|प्रतिदिन|दिन/i.test(period);
    const monthly = period ? /month|mahina|महीन|माह/i.test(period) : v < 50000;
    p.annualIncome = Math.round(daily ? v * 300 : monthly ? v * 12 : v);
    break;
  }

  if (has(t, /\bBPL\b|below poverty|antyodaya|\bAAY\b|गरीबी रेखा|बीपीएल|अंत्योदय/i)) p.bpl = true;

  if (has(t, neg("bank account|bank")) || has(t, /bank account nahi|बैंक खाता नहीं|खाता नहीं है/i)) p.hasBankAccount = false;
  else if (has(t, /(have|has|got|with|and) (a |an |my )?(bank )?account|bank account hai|बैंक (में )?खाता है|jan dhan account/i)) p.hasBankAccount = true;

  if (has(t, neg("lpg|gas")) || has(t, /cook on (wood|a chulha)|chulha|चूल्हा|लकड़ी|गैस (कनेक्शन )?नहीं/i)) p.hasLpg = false;
  else if (has(t, /\b(have|has|got|with)\s+(?:[\w',]+\s+){0,4}(lpg|gas) (connection|cylinder)|गैस कनेक्शन है/i)) p.hasLpg = true;

  if (has(t, neg("house|home|pucca|roof")) || has(t, /kutcha|kachcha|kacha (house|ghar|makan)|mud house|\bhut\b|jhopdi|jhuggi|\b(in|under) a tent\b|footpath|homeless|rented|on rent|rent (a |in )|किराए|कच्चा (घर|मकान)|झोपड़ी|झुग्गी|बेघर|घर नहीं|मकान नहीं/i)) p.ownsPuccaHouse = false;
  else if (has(t, /pucca|pakka (house|ghar|makan)|own (a |my )?house|पक्का (घर|मकान)|अपना (घर|मकान)/i)) p.ownsPuccaHouse = true;

  if (has(t, neg("land|farm ?land|field")) || has(t, /landless|bhumihin|tenant|sharecrop|bataidar|on lease|leased land|others'? (fields|land)|भूमिहीन|बटाईदार|ठेके पर|ज़?जमीन नहीं|ज़मीन नहीं/i)) p.ownsLand = false;
  else if (has(t, /\d+(\.\d+)?\s*(acres?|bighas?|hectares?|katha|guntha|बीघा|एकड़|हेक्टेयर)|own (some |my )?(farm ?)?land|my (farm|field|land)|(ज़मीन|जमीन|खेत) है|अपनी (ज़मीन|जमीन)/i)) p.ownsLand = true;

  const dis = t.match(/(\d{1,3})\s*%\s*(?:disab|handicap|विकलांग|दिव्यांग)/i) ?? t.match(/(?:disab\w*|विकलांगता|दिव्यांगता)\D{0,20}(\d{1,3})\s*%/i);
  if (dis && +dis[1] <= 100) p.disabilityPercent = +dis[1];

  if (has(t, /pregnant|expecting (a|my|our) (baby|child|first|second)|baby is due|garbhvati|गर्भवती|गर्भ से|पेट से|new mother|just had a baby|recently delivered|gave birth/i)) p.isPregnant = true;
  if (p.hasDaughterUnder10 === undefined && has(t, /baby girl|infant daughter|newborn daughter|little daughter|छोटी बेटी|नन्ही बेटी/i)) p.hasDaughterUnder10 = true;

  if (has(t, /(don'?t|do not|never|no ?one|nobody|no family member)( in (my|the) family)? (pay|pays|paid|file|files)? ?(any )?(income )?tax|not a tax ?payer|टैक्स नहीं/i)) p.paysIncomeTax = false;
  else if (has(t, /(pay|paid|file|filed) (income )?tax|tax ?payer|\bITR\b|इनकम टैक्स भर/i)) p.paysIncomeTax = true;

  if (has(t, neg("EPFO|EPF|PF|ESIC|provident fund")) || has(t, /PF nahi/i)) p.inEpfoOrEsic = false;
  else if (/\b(EPF|PF|ESIC|EPFO)\b/.test(t)) p.inEpfoOrEsic = true;

  if (has(t, /start (a |my own |my |own )?(business|shop|venture|enterprise|dhanda)|open (a )?shop|grow my (business|shop)|loan for (my )?(business|shop)|apna (kaam|business|dhanda)|व्यवसाय शुरू|दुकान खोल|धंधा शुरू/i)) p.wantsToStartBusiness = true;

  const cls = t.match(/(?:class|std|grade)\s*(\d{1,2})\b|(\d{1,2})(?:st|nd|rd|th)\s*(?:class|std|standard)|कक्षा\s*(\d{1,2})|(\d{1,2})\s*वीं/i);
  if (has(t, /college|university|graduation|\bB\.?A\b|\bB\.?Sc|\bB\.?Com|\bB\.?Tech|\bBCA\b|\bMBBS\b|\bM\.?A\b|degree|कॉलेज|स्नातक/i)) p.educationLevel = "graduate";
  else if (has(t, /polytechnic|diploma|\bITI\b/i)) p.educationLevel = "post_matric";
  else if (cls) p.educationLevel = Number(cls[1] ?? cls[2] ?? cls[3] ?? cls[4]) >= 11 ? "post_matric" : "school";

  const pin = t.match(/(?:pin\s*(?:code)?|pincode|पिन\s*(?:कोड)?)\D{0,5}([1-9]\d{5})\b/i);
  if (pin) p.pincode = pin[1];

  return p;
}

// Everyday names people use for each scheme (first match wins, so specific names come before broad ones).
const SCHEME_NAMES: [string, RegExp][] = [
  ["ab-vay-vandana", /vay vandana|वय वंदना|senior citizen (health|ayushman)/i],
  ["pm-kisan", /pm[\s-]?kisan|kisan samman|किसान सम्मान|पीएम[\s-]?किसान/i],
  ["kisan-credit-card", /kisan credit|\bKCC\b|किसान क्रेडिट/i],
  ["pm-jay", /ayushman|pm-?jay|golden card|आयुष्मान/i],
  ["nsap-widow", /widow pension|vidhwa pension|विधवा पेंशन/i],
  ["nsap-disability", /(disability|divyang|viklang) pension|(विकलांग|दिव्यांग) पेंशन/i],
  ["nsap-old-age", /old[- ]age pension|vridh|budhapa|वृद्धावस्था|बुढ़ापा पेंशन/i],
  ["pm-ujjwala", /ujj?wala|उज्ज्वला|free (gas|lpg) connection/i],
  ["pmay-u", /pmay-?u\b|awas yojana (urban|shahari)|shahari awas|शहरी आवास/i],
  ["pmay-g", /pmay-?g\b|awas yojana|gramin awas|ग्रामीण आवास|आवास योजना|pm awas/i],
  ["pm-jan-dhan", /jan ?dhan|जन धन|zero balance account/i],
  ["pmjjby", /jeevan jyoti|pmjjby|जीवन ज्योति/i],
  ["pmsby", /suraksha bima|pmsby|सुरक्षा बीमा/i],
  ["atal-pension", /atal pension|\bAPY\b|अटल पेंशन/i],
  ["mgnrega", /mgnrega|mnrega|manrega|narega|\bnrega|मनरेगा|नरेगा|job card/i],
  ["sukanya-samriddhi", /sukanya|सुकन्या/i],
  ["pm-mudra", /mudra|मुद्रा/i],
  ["pm-vishwakarma", /vishwakarma|विश्वकर्मा/i],
  ["pm-svanidhi", /sva?n?idhi|swanidhi|स्वनिधि/i],
  ["post-matric-st", /post[- ]?matric.*(\bST\b|tribal|जनजाति)|(\bST\b|tribal).*post[- ]?matric/i],
  ["post-matric-sc", /post[- ]?matric|पोस्ट[- ]?मैट्रिक/i],
  ["central-sector-scholarship", /central sector scholarship|merit scholarship|केंद्रीय क्षेत्र छात्रवृत्ति/i],
  ["pmmvy", /matru vandana|pmmvy|मातृ वंदना|maternity benefit/i],
  ["pmfby", /fasal bima|pmfby|फसल बीमा|crop insurance/i],
  ["stand-up-india", /stand[- ]?up india|स्टैंड[- ]?अप/i],
  ["pm-sym", /shram yogi|maandhan|pm-?sym|श्रम योगी|मानधन/i],
  ["e-shram", /e-?shram|ई-?श्रम/i],
];

/** Which scheme, if any, the user is asking about ("documents for Ujjwala?", "am I eligible for PM Kisan"). */
export function schemeIntent(text: string): string | null {
  return SCHEME_NAMES.find(([, re]) => re.test(text))?.[0] ?? null;
}
