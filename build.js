#!/usr/bin/env node
/**
 * build.js — CPEF Social Media Dashboard Data Builder
 *
 * Reads every Sprout export under ./data/ (any subfolder), identifies each one
 * by its columns and account names, and writes:
 *   ./docs/data.js              — org dashboard data (window.DASHBOARD_DATA)
 *   ./docs/influencer_data.js   — influencer dashboard data (window.INFLUENCER_DATA)
 *   ./docs/competitor_data.js   — competitor data (window.COMPETITOR_DATA)
 *
 * Usage:
 *   node build.js
 *
 * To add new data: download the export from Sprout, upload it anywhere under
 * ./data/, commit. Filenames and folders don't matter, and old files never
 * need to be deleted: overlapping rows are de-duplicated and the file whose
 * data reaches the latest date wins. See MAIN for details, ./data/corrections/
 * for pinned fixes, and "Data checks" for the automatic revision warnings.
 */
 
const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx'); // only used to read raw LinkedIn native .xlsx exports, see PART 3
 
// ── SHARED: CSV PARSER ───────────────────────────────────────────────────────
// Handles quoted fields containing embedded newlines and commas correctly.
// Sprout Social Post Performance exports frequently include newlines inside
// the Post text column, which breaks naive line-split parsers.
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
 
  function tokenise(src) {
    const records = [];
    let fields = [];
    let cur = '';
    let inQuote = false;
    let i = 0;
 
    while (i < src.length) {
      const ch = src[i];
 
      if (inQuote) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cur += '"'; i += 2; continue; } // escaped quote
          inQuote = false; i++; continue; // closing quote
        }
        cur += ch; i++; continue; // any char including \n is part of the field
      }
 
      if (ch === '"')  { inQuote = true; i++; continue; }
      if (ch === ',')  { fields.push(cur); cur = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') {
        fields.push(cur); cur = '';
        records.push(fields);
        fields = [];
        i++; continue;
      }
      cur += ch; i++;
    }
    // flush trailing content
    if (cur || fields.length) {
      fields.push(cur);
      if (fields.some(f => f !== '')) records.push(fields);
    }
    return records;
  }
 
  const records = tokenise(raw);
  if (records.length < 2) return [];
 
  const headers = records[0].map(h => h.trim());
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    const vals = records[i];
    if (vals.length < 3) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}
 
// ── SHARED: NUMERIC CLEANER ──────────────────────────────────────────────────
function num(str) {
  if (!str || str === '' || str === '-') return null;
  const s = str.replace(/,/g, '').replace(/%$/, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
 
// ── SHARED: DATE FORMATTERS ──────────────────────────────────────────────────
function fmtISO(d) {
  return d.toISOString().slice(0, 10);
}
function fmtHuman(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
 
// ── SHARED: DATE RANGE FROM A SPROUT FILENAME ────────────────────────────────
// Sprout export filenames end in a date range like "January 1, 2024 - June 30, 2026".
// Returns the LAST date in the filename (the range's end). Used only as a
// tie-breaker: file priority is decided by the latest date inside each file
// (see MAIN), so renamed files still sort correctly.
function extractEndDateFromFilename(filename) {
  const months = { January:0, February:1, March:2, April:3, May:4, June:5,
                    July:6, August:7, September:8, October:9, November:10, December:11 };
  // Tolerates renamed downloads, e.g. "October_14__2026" as well as "October 14, 2026"
  filename = String(filename).replace(/_/g, ' ');
  const re = /([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/g;
  let match, last = null;
  while ((match = re.exec(filename)) !== null) {
    const [, monthName, day, year] = match;
    if (months[monthName] === undefined) continue;
    last = new Date(parseInt(year), months[monthName], parseInt(day));
  }
  return last;
}
 
// ═══════════════════════════════════════════════════════════════════════════════
// ── PART 1: ORG DASHBOARD (Profile Performance CSVs) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
 
// ── FACEBOOK PAGES CSV PARSER ─────────────────────────────────────────────────
// Reads Facebook Pages exports (from Sprout's "Facebook Pages" report) which
// contain Organic Views and Paid Views columns, and returns a Map of
// dateKey (MM-DD-YYYY) → { impOrganic, impPaid }
function buildFbPaidMap(fbFiles) {
  const map = {};
  if (fbFiles.length === 0) return map;
  console.log(`\n── Facebook Pages data (${fbFiles.length} file(s), oldest→newest by data date) ──`);
  for (const df of fbFiles) {
    const rows = df.rows.filter(r => isOrgProfile(r['Facebook Page']));
    console.log(`  ${df.rel}  (${rows.length} rows)`);
    for (const row of rows) {
      const dateKey = row['Date'];
      if (!dateKey) continue;
      const organic = num(row['Organic Views']) ?? 0;
      const paid    = num(row['Paid Views'])    ?? 0;
      // Last file wins for overlapping dates (files are sorted oldest→newest
      // by the latest date inside each file, so "last" means "newest data")
      map[dateKey] = { impOrganic: organic, impPaid: paid };
    }
  }
  console.log(`Facebook paid/organic entries: ${Object.keys(map).length}`);
  return map;
}
 
function platformKey(network) {
  const n = String(network || '').toLowerCase();
  if (n === 'x') return 'x';
  if (n === 'facebook') return 'fb';
  if (n === 'linkedin') return 'li';
  return null;
}
 
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wn = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + (4 - (thursday.getUTCDay() || 7)));
  return { wy: thursday.getUTCFullYear(), wn };
}
 
function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - (day - 1));
  return d;
}
 
function buildOrgData(allRows, fbPaidMap) {
  const daily = {};
 
  for (const row of allRows) {
    const parts = row['Date'].split('-');
    if (parts.length !== 3) continue;
    const dateObj = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
    if (isNaN(dateObj.getTime())) continue;
 
    const plt = platformKey(row['Network']);
    if (!plt) continue;
 
    const dateKey = row['Date'];
    if (!daily[dateKey]) daily[dateKey] = {};
 
    const totalImp = num(row['Impressions']) ?? 0;
    const entry = {
      dateObj,
      imp:  totalImp,
      eng:  num(row['Engagements'])                         ?? 0,
      rate: num(row['Engagement Rate (per Impression)']),
      aud:  num(row['Audience']),
    };
 
    // Facebook organic/paid split. Total impressions come from Profile
    // Performance (the source of truth for totals); only the PAID portion comes
    // from the Facebook Pages report. Organic = total - paid, so organic + paid
    // always equals total, and a Facebook Pages export that is older than the
    // Profile export can never understate organic. (Before Oct 2026 organic was
    // taken directly from the Pages report's "Organic Views", which ran ~2-5%
    // below total in 2022-23 even with no paid activity.)
    if (plt === 'fb') {
      const paid = fbPaidMap[dateKey] ? fbPaidMap[dateKey].impPaid : 0;
      entry.impPaid    = paid;
      entry.impOrganic = Math.max(totalImp - paid, 0);
    }
 
    daily[dateKey][plt] = entry;
  }
 
  const monthly = {}, quarterly = {}, annual = {}, weeklyMap = {};
  const PLTS = ['x', 'fb', 'li'];
  // Platforms rolled into the 'all' (All Platforms) aggregate. X was officially
  // sunset in Q3 2026, so it is excluded from 'all' and appears only in its own
  // per-platform series (shown on the dashboard's X Archive tab).
  const ALL_PLTS = ['fb', 'li'];
 
  function initMetrics() {
    return { imp: 0, impOrganic: 0, impPaid: 0, eng: 0, rateNumer: 0, rateDenom: 0, audSamples: [], days: 0 };
  }
  function addDay(slot, imp, eng, rate, aud, impOrganic, impPaid) {
    slot.imp += imp; slot.eng += eng; slot.days++;
    if (impOrganic !== undefined) slot.impOrganic += impOrganic;
    if (impPaid    !== undefined) slot.impPaid    += impPaid;
    if (rate !== null) {
      const w = imp > 0 ? imp : 1;
      slot.rateNumer += rate * w; slot.rateDenom += w;
    }
    if (aud !== null) slot.audSamples.push(aud);
  }
 
  // Tracks the most recent non-null audience per platform across all dates.
  // Used to fill gaps (e.g. LinkedIn NaN on Aug 30–Sep 2 2025) so the 'all'
  // aggregate doesn't collapse when one platform is temporarily missing.
  const lastKnownAud = { x: null, fb: null, li: null };
 
  const sortedDates = Object.keys(daily).sort((a, b) => {
    const [ma, da, ya] = a.split('-').map(Number);
    const [mb, db, yb] = b.split('-').map(Number);
    return new Date(ya, ma-1, da) - new Date(yb, mb-1, db);
  });
 
  for (const dateKey of sortedDates) {
    const dayData = daily[dateKey];
    const sampleDate = Object.values(dayData)[0]?.dateObj;
    if (!sampleDate) continue;
 
    const yr = sampleDate.getFullYear(), mo = sampleDate.getMonth();
    const q  = Math.floor(mo / 3) + 1;
    const { wy, wn } = isoWeek(sampleDate);
    const wKey = `${wy}-${wn}`;
    const ws = weekStart(sampleDate);
    const syr = String(yr), smo = String(mo), sq = String(q);
 
    if (!monthly[syr])       monthly[syr] = {};
    if (!monthly[syr][smo])  monthly[syr][smo] = {};
    if (!quarterly[syr])     quarterly[syr] = {};
    if (!quarterly[syr][sq]) quarterly[syr][sq] = {};
    if (!annual[syr])        annual[syr] = {};
 
    for (const plt of [...PLTS, 'all']) {
      if (!monthly[syr][smo][plt])  monthly[syr][smo][plt]  = initMetrics();
      if (!quarterly[syr][sq][plt]) quarterly[syr][sq][plt] = initMetrics();
      if (!annual[syr][plt])        annual[syr][plt]        = initMetrics();
    }
 
    if (!weeklyMap[wKey]) {
      weeklyMap[wKey] = { wy, wn, startDate: ws, endDate: null };
      for (const p2 of [...PLTS, 'all']) weeklyMap[wKey][p2] = initMetrics();
    }
 
    const allDay = { imp: 0, eng: 0, rates: [], auds: [] };
    for (const plt of PLTS) {
      const d = dayData[plt];
      if (!d) continue;
      const { imp, eng, rate, aud, impOrganic, impPaid } = d;
      addDay(monthly[syr][smo][plt], imp, eng, rate, aud, impOrganic, impPaid);
      addDay(quarterly[syr][sq][plt], imp, eng, rate, aud, impOrganic, impPaid);
      addDay(annual[syr][plt], imp, eng, rate, aud, impOrganic, impPaid);
      addDay(weeklyMap[wKey][plt], imp, eng, rate, aud, impOrganic, impPaid);
      // Update last known audience for this platform (used for 'all' sum below)
      if (aud !== null) lastKnownAud[plt] = aud;
      if (!ALL_PLTS.includes(plt)) continue; // X excluded from 'all' (sunset Q3 2026)
      allDay.imp += imp; allDay.eng += eng;
      if (rate !== null) allDay.rates.push({ r: rate, w: imp > 0 ? imp : 1 });
    }
 
    const allRN = allDay.rates.reduce((s, x) => s + x.r * x.w, 0);
    const allRD = allDay.rates.reduce((s, x) => s + x.w, 0);
 
    monthly[syr][smo]['all'].imp        += allDay.imp;
    monthly[syr][smo]['all'].eng        += allDay.eng;
    monthly[syr][smo]['all'].rateNumer  += allRN;
    monthly[syr][smo]['all'].rateDenom  += allRD;
 
    quarterly[syr][sq]['all'].imp       += allDay.imp;
    quarterly[syr][sq]['all'].eng       += allDay.eng;
    quarterly[syr][sq]['all'].rateNumer += allRN;
    quarterly[syr][sq]['all'].rateDenom += allRD;
 
    annual[syr]['all'].imp              += allDay.imp;
    annual[syr]['all'].eng              += allDay.eng;
    annual[syr]['all'].rateNumer        += allRN;
    annual[syr]['all'].rateDenom        += allRD;
 
    weeklyMap[wKey]['all'].imp          += allDay.imp;
    weeklyMap[wKey]['all'].eng          += allDay.eng;
    weeklyMap[wKey]['all'].rateNumer    += allRN;
    weeklyMap[wKey]['all'].rateDenom    += allRD;
 
    // Push a single summed audience sample for 'all', using each platform's
    // last known value to fill any gaps (e.g. LinkedIn NaN days). This prevents
    // a temporarily-missing platform from collapsing the aggregate total.
    const knownPlts = ALL_PLTS.filter(p => lastKnownAud[p] !== null);
    if (knownPlts.length > 0) {
      const audSum = knownPlts.reduce((s, p) => s + lastKnownAud[p], 0);
      monthly[syr][smo]['all'].audSamples.push(audSum);
      quarterly[syr][sq]['all'].audSamples.push(audSum);
      annual[syr]['all'].audSamples.push(audSum);
      weeklyMap[wKey]['all'].audSamples.push(audSum);
    }
 
    weeklyMap[wKey].endDate = sampleDate;
  }
 
  function finalize(slot) {
    const rate = slot.rateDenom > 0 ? +(slot.rateNumer / slot.rateDenom).toFixed(2) : null;
    const aud  = slot.audSamples.length > 0
      ? Math.round(slot.audSamples[slot.audSamples.length - 1]) : null;
    const result = { imp: slot.imp, eng: slot.eng, rate, aud };
    if (slot.impOrganic !== undefined || slot.impPaid !== undefined) {
      result.impOrganic = slot.impOrganic || 0;
      result.impPaid    = slot.impPaid    || 0;
    }
    return result;
  }
 
  // A platform with no source rows in a period (e.g. X after the newest export
  // stopped including it) is omitted rather than written as zeros, so archived
  // series end where their data ends. 'all' is always written.
  const hasRows = (plt, slot) => plt === 'all' || slot.days > 0;

  const finalMonthly = {};
  for (const [yr, months] of Object.entries(monthly)) {
    finalMonthly[yr] = {};
    for (const [mo, plts] of Object.entries(months)) {
      if (!Object.values(plts).some(p => p.imp > 0 || p.eng > 0)) continue;
      finalMonthly[yr][mo] = {};
      for (const [plt, slot] of Object.entries(plts)) { if (!hasRows(plt, slot)) continue; finalMonthly[yr][mo][plt] = finalize(slot); }
    }
  }
 
  const finalQuarterly = {};
  for (const [yr, quarters] of Object.entries(quarterly)) {
    finalQuarterly[yr] = {};
    for (const [q, plts] of Object.entries(quarters)) {
      if (!Object.values(plts).some(p => p.imp > 0 || p.eng > 0)) continue;
      finalQuarterly[yr][q] = {};
      for (const [plt, slot] of Object.entries(plts)) { if (!hasRows(plt, slot)) continue; finalQuarterly[yr][q][plt] = finalize(slot); }
    }
  }
 
  const finalAnnual = {};
  for (const [yr, plts] of Object.entries(annual)) {
    if (!Object.values(plts).some(p => p.imp > 0 || p.eng > 0)) continue;
    finalAnnual[yr] = {};
    for (const [plt, slot] of Object.entries(plts)) { if (!hasRows(plt, slot)) continue; finalAnnual[yr][plt] = finalize(slot); }
  }
 
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const finalWeekly = Object.values(weeklyMap)
    .sort((a, b) => a.wy !== b.wy ? a.wy - b.wy : a.wn - b.wn)
    .map(w => {
      const start = w.startDate;
      const end = new Date(start); end.setDate(end.getDate() + 6);
      const label = `W${w.wn} ${w.wy} (${MONTH_ABBR[start.getMonth()]} ${start.getDate()}\u2013${MONTH_ABBR[end.getMonth()]} ${end.getDate()})`;
      const entry = { wy: w.wy, wn: w.wn, start: fmtISO(start), end: fmtISO(end), label };
      for (const plt of [...PLTS, 'all']) { if (!hasRows(plt, w[plt])) continue; entry[plt] = finalize(w[plt]); }
      return entry;
    });
 
  const lastDate = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : '';
  let lastDateFormatted = '';
  if (lastDate) {
    const [mm, dd, yyyy] = lastDate.split('-');
    lastDateFormatted = fmtHuman(new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd)));
  }
 
  return {
    monthly: finalMonthly, quarterly: finalQuarterly,
    annual: finalAnnual, weekly: finalWeekly,
    meta: { builtAt: new Date().toISOString(), lastDate: lastDateFormatted }
  };
}
 
// ═══════════════════════════════════════════════════════════════════════════════
// ── PART 2: INFLUENCER DASHBOARD (Post Performance CSVs) ────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
 
function buildInfluencerData(allRows) {
  const postRows = allRows.filter(r => r['Post ID'] && r['Post ID'].trim());
  if (postRows.length === 0) return null;
 
  const posts = [];
  for (const row of postRows) {
    const rawDate = row['Date'];
    let dateObj = null;
    if (rawDate) {
      const m = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) dateObj = new Date(parseInt(m[3]), parseInt(m[1])-1, parseInt(m[2]));
    }
    if (!dateObj || isNaN(dateObj.getTime())) continue;
 
    posts.push({
      date:        fmtISO(dateObj),
      year:        dateObj.getFullYear(),
      month:       dateObj.getMonth(),
      postId:      row['Post ID']      || '',
      network:     row['Network']      || '',
      profile:     row['Profile']      || '',
      post:        row['Post']         || '',
      link:        row['Link']         || '',
      contentType: row['Content Type'] || '',
      imp:         num(row['Impressions']),
      reach:       num(row['Reach']),
      eng:         num(row['Engagements']),
      reactions:   num(row['Reactions']),
      comments:    num(row['Comments']),
      shares:      num(row['Shares']),
      rate:        num(row['Engagement Rate (per Impression)']),
      tags:        row['Tags'] && row['Tags'].trim() ? row['Tags'].trim() : null,
    });
  }
 
  if (posts.length === 0) return null;
 
  posts.sort((a, b) => a.date.localeCompare(b.date));
 
  // Deduplicate by Post ID — stable across re-exports, unlike Link, which is
  // frequently blank on X replies. Falls back to Link, then to a date+text
  // snippet, for any legacy rows that predate consistent Post ID population.
  // Input files are pre-sorted oldest→newest (by embedded filename date range),
  // so whichever file contributes a given post LAST in this loop is the newest
  // export of it — "later wins" therefore reliably means "newest data wins."
  const seen = new Map();
  for (const p of posts) seen.set(p.postId || p.link || p.date + p.post.slice(0, 20), p);
  const dedupedPosts = Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));
 
  const monthlyMap = {};
  for (const p of dedupedPosts) {
    const key = `${p.year}-${p.month}`;
    if (!monthlyMap[key]) monthlyMap[key] = { eng:0, posts:0, imp:0, reactions:0, comments:0 };
    monthlyMap[key].eng       += p.eng       || 0;
    monthlyMap[key].posts     += 1;
    monthlyMap[key].reactions += p.reactions || 0;
    monthlyMap[key].comments  += p.comments  || 0;
    monthlyMap[key].imp       += p.imp       || 0;
  }
 
  const annualMap = {};
  for (const p of dedupedPosts) {
    const yr = String(p.year);
    if (!annualMap[yr]) annualMap[yr] = { posts:0, eng:0, reactions:0, comments:0, imp:0, shares:0 };
    annualMap[yr].posts     += 1;
    annualMap[yr].eng       += p.eng       || 0;
    annualMap[yr].reactions += p.reactions || 0;
    annualMap[yr].comments  += p.comments  || 0;
    annualMap[yr].imp       += p.imp       || 0;
    annualMap[yr].shares    += p.shares    || 0;
  }
 
  const profiles = [...new Set(dedupedPosts.map(p => p.profile))].filter(Boolean);
 
  return {
    posts:   dedupedPosts,
    monthly: monthlyMap,
    annual:  annualMap,
    meta: {
      builtAt:    new Date().toISOString(),
      firstDate:  dedupedPosts[0].date,
      lastDate:   dedupedPosts[dedupedPosts.length - 1].date,
      totalPosts: dedupedPosts.length,
      name:       profiles.length === 1 ? profiles[0] : profiles.join(', '),
      profiles,
    }
  };
}
 
// ═══════════════════════════════════════════════════════════════════════════════
// ── MAIN ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// UPLOAD WORKFLOW: download any Sprout export, drop it anywhere under ./data/
// (any subfolder, original or renamed filename), commit. Nothing needs to be
// deleted. The build identifies each file by its columns and account names:
//   • Profile Performance  → Fund rows feed the org dashboard. Rows for any other
//                            profile (e.g. Heather's profile export) are ignored,
//                            so they can never overwrite Fund numbers.
//   • Post Performance     → non-Fund profiles (Heather) feed the influencer page.
//                            Fund post rows are logged but not used yet.
//   • Facebook Pages       → paid views for the Facebook organic/paid split.
//   • Competitor Performance → competitor dashboard (Facebook + X peers).
//   • LinkedIn native Competitors exports (.xlsx) → LinkedIn peer data.
//   • Anything else        → skipped with a log line; never stops the build.
// When files overlap, the file whose rows reach the LATEST date wins (newest
// data), with the filename's date range as a tie-breaker. Rows that only an
// older file has (e.g. X history, which newer exports no longer include) are
// kept, so archives never disappear.
// ./data/corrections/ is special: pinned fixes and accepted changes, see below.

const dataDir        = path.join(__dirname, 'data');
const correctionsDir = path.join(dataDir, 'corrections');
const orgOutFile     = path.join(__dirname, 'docs', 'data.js');
const infOutFile     = path.join(__dirname, 'docs', 'influencer_data.js');

// Fund accounts as Sprout names them ("The Chicago Public Education Fund",
// "'@TheFundChicago"). Everything else is treated as a non-Fund profile.
const ORG_PROFILE_RE = /chicago public education fund|thefundchicago/i;
function isOrgProfile(name) { return ORG_PROFILE_RE.test(String(name || '')); }

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

// Accepts Sprout's "MM-DD-YYYY" (daily reports) and "M/D/YYYY h:mm am" (post reports)
function parseRowDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
  return isNaN(d.getTime()) ? null : d;
}

function classifyCsv(headers) {
  const has = h => headers.includes(h);
  if (has('Facebook Page') && has('Organic Views') && has('Paid Views'))           return 'fbPages';
  if (has('Public Engagements') && has('Audience') && has('Date') && !has('Post ID')) return 'compPerf';
  if (has('Post ID') && has('Public Engagements') && !has('Impressions'))          return 'compPosts';
  if (has('Post ID') && has('Profile') && has('Impressions'))                      return 'posts';
  if (has('Network') && has('Profile') && has('Impressions') && has('Sent Messages (Total)')) return 'profile';
  const lower = headers.map(h => h.toLowerCase());
  if (lower.includes('month') && lower.includes('organization'))                   return 'liCompCsv';
  return 'unknown';
}

const KIND_LABELS = {
  profile: 'Profile Performance', posts: 'Post Performance', fbPages: 'Facebook Pages',
  compPerf: 'Competitor Performance', compPosts: 'Competitor Posts (not used)',
  liCompCsv: 'LinkedIn competitor CSV', unknown: 'unrecognized — skipped',
};

console.log('\n── Discovering data files under ./data/ ──');
const discovered = [];
for (const full of listFilesRecursive(dataDir)) {
  if (full.startsWith(correctionsDir + path.sep)) continue;
  if (!full.toLowerCase().endsWith('.csv')) continue;
  const rel = path.relative(dataDir, full);
  let rows;
  try { rows = parseCSV(full); }
  catch (e) { console.log(`  ⚠ ${rel}  (skipped — could not be read: ${e.message})`); continue; }
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const kind = classifyCsv(headers);
  let maxDate = null;
  for (const r of rows) { const d = parseRowDate(r['Date']); if (d && (!maxDate || d > maxDate)) maxDate = d; }
  discovered.push({ full, rel, kind, rows, maxDate, nameDate: extractEndDateFromFilename(path.basename(full)) });
}
// Oldest → newest: latest date inside the file, then the filename's end date, then name
discovered.sort((a, b) =>
  ((a.maxDate || 0) - (b.maxDate || 0)) ||
  ((a.nameDate || 0) - (b.nameDate || 0)) ||
  a.rel.localeCompare(b.rel));
for (const d of discovered) {
  const thru = d.maxDate ? fmtISO(d.maxDate) : 'no dates';
  console.log(`  ${d.rel}  → ${KIND_LABELS[d.kind]} (${d.rows.length} rows, data through ${thru})`);
}
const filesOfKind = k => discovered.filter(d => d.kind === k);

// ── Build org data ────────────────────────────────────────────────────────────
const profileFiles = filesOfKind('profile');
if (profileFiles.length === 0) {
  console.error('No Profile Performance exports found under ./data/');
  process.exit(1);
}
console.log(`\n── Org data (${profileFiles.length} Profile Performance file(s), oldest→newest) ──`);
let orgRows = [];
for (const df of profileFiles) {
  const fund  = df.rows.filter(r => isOrgProfile(r['Profile']));
  const other = df.rows.length - fund.length;
  console.log(`  ${df.rel}  (${fund.length} Fund rows${other ? `; ${other} rows for other profiles ignored` : ''})`);
  orgRows = orgRows.concat(fund);
}
console.log(`Total org rows: ${orgRows.length}`);

// ── Apply pinned corrections (./data/corrections/) ────────────────────────────
// Some Sprout Profile Performance exports contain known errors. Each correction
// CSV holds Date + Network plus the metric columns to pin; for every matching
// org row, those columns are overwritten with the correction's values. All other
// columns (Audience, Reactions, etc.) are left untouched.
//
// Current correction (added Oct 2026):
//   Sprout exports pulled after June 2026 (seen in the Sep 30 and Oct 14, 2026
//   exports) report LinkedIn Impressions and Post Link Clicks at ~2x for
//   Feb 1 – Jun 10, 2026, while Reactions are unchanged. The June 30, 2026
//   export and post-level (Post Performance) data agree with each other at the
//   un-doubled level, so those dates are pinned to the June 30 export's
//   Impressions, Engagements, Engagement Rate and Post Link Clicks.
//   To retire it: if a fresh Sprout export shows ~1.00x against the correction
//   (see the ratio logged below), delete the correction file.
//
// accepted_changes.csv (columns Network, Month as YYYY-MM, Reason) is not a
// correction: it lists months whose large revision has been reviewed and
// accepted as real, which clears the dashboard warning (see data checks).
const ACCEPTED_FILE = 'accepted_changes.csv';
const correctedMonths = new Set();   // 'li|2026-02' etc. — excluded from data checks
const acceptedMonths  = new Set();
if (fs.existsSync(correctionsDir)) {
  const corrFiles = fs.readdirSync(correctionsDir).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  const fixFiles = corrFiles.filter(f => f.toLowerCase() !== ACCEPTED_FILE);
  if (fixFiles.length > 0) console.log(`\n── Corrections (${fixFiles.length} file(s)) ──`);
  for (const f of fixFiles) {
    const corrRows = parseCSV(path.join(correctionsDir, f));
    const corrMap = {};
    let fields = [];
    for (const r of corrRows) {
      corrMap[`${r['Date']}|${r['Network']}`] = r;
      fields = Object.keys(r).filter(k => k !== 'Date' && k !== 'Network');
      const d = parseRowDate(r['Date']), plt = platformKey(r['Network']);
      if (d && plt) correctedMonths.add(`${plt}|${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    let matched = 0, impBefore = 0, impAfter = 0;
    for (const row of orgRows) {
      const c = corrMap[`${row['Date']}|${row['Network']}`];
      if (!c) continue;
      impBefore += num(row['Impressions']) ?? 0;
      for (const k of fields) row[k] = c[k];
      impAfter += num(row['Impressions']) ?? 0;
      matched++;
    }
    const ratio = impAfter > 0 ? (impBefore / impAfter).toFixed(2) : 'n/a';
    console.log(`  ${f}  (${corrRows.length} rows; ${matched} org rows corrected; export/correction impressions ratio ${ratio}x)`);
  }
  if (corrFiles.some(f => f.toLowerCase() === ACCEPTED_FILE)) {
    for (const r of parseCSV(path.join(correctionsDir, ACCEPTED_FILE))) {
      const plt = platformKey(r['Network']);
      const mo  = String(r['Month'] || '').trim();
      if (plt && /^\d{4}-\d{2}$/.test(mo)) acceptedMonths.add(`${plt}|${mo}`);
    }
    if (acceptedMonths.size) console.log(`  ${ACCEPTED_FILE}  (${acceptedMonths.size} accepted month(s))`);
  }
}

// ── Load Facebook paid/organic split data ─────────────────────────────────────
const fbPaidMap = buildFbPaidMap(filesOfKind('fbPages'));

const orgData = buildOrgData(orgRows, fbPaidMap);
console.log(`Years: ${Object.keys(orgData.annual).sort().join(', ')}`);
console.log(`Last date: ${orgData.meta.lastDate}`);

// ── Data checks: catch Sprout revisions to settled months ─────────────────────
// Compares this build's monthly totals with the previously published
// docs/data.js. A month is "settled" if it ended at least 31 days before the
// previous build's last data date; settled months normally move by a few
// percent at most. A move of more than 25% (and at least 500 impressions or
// 100 engagements) is flagged in meta.dataWarnings and shown as a banner on the
// dashboard. Warnings persist across builds until the month returns to within
// 25% of its earlier value (e.g. a fixed re-export is uploaded), a correction
// file covers it, or it is listed in data/corrections/accepted_changes.csv.
// This is what would have caught the Feb–Jun 2026 LinkedIn doubling.
(function runDataChecks() {
  let prev = null;
  try {
    if (fs.existsSync(orgOutFile)) {
      const txt = fs.readFileSync(orgOutFile, 'utf8');
      prev = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    }
  } catch (e) { console.log(`  ⚠ Could not read previous ${path.relative(__dirname, orgOutFile)} for data checks: ${e.message}`); }

  const PLT_NAMES = { fb: 'Facebook', li: 'LinkedIn', x: 'X' };
  const THRESH = { imp: 500, eng: 100 };
  const ym = (y, m) => `${y}-${String(Number(m) + 1).padStart(2, '0')}`;
  const cur = (plt, month, metric) => {
    const [y, mm] = month.split('-').map(Number);
    const v = orgData.monthly[String(y)]?.[String(mm - 1)]?.[plt];
    return v ? v[metric] : null;
  };
  const exempt = (plt, month) => correctedMonths.has(`${plt}|${month}`) || acceptedMonths.has(`${plt}|${month}`);
  const bigMove = (before, after, metric) =>
    before != null && after != null &&
    Math.abs(after - before) >= THRESH[metric] &&
    Math.abs(after - before) / Math.max(before, 1) > 0.25;

  const warnings = new Map();
  // Carry forward earlier warnings that are still unresolved
  for (const w of (prev?.meta?.dataWarnings || [])) {
    if (exempt(w.plt, w.month)) continue;
    const now = cur(w.plt, w.month, w.metric);
    if (!bigMove(w.before, now, w.metric)) continue; // back within 25% → resolved
    warnings.set(w.key, { ...w, after: now });
  }
  // New warnings from this build
  if (prev?.monthly && prev?.meta?.lastDate) {
    const prevLast = new Date(prev.meta.lastDate);
    const cutoff = new Date(prevLast); cutoff.setDate(cutoff.getDate() - 31);
    for (const [y, months] of Object.entries(prev.monthly)) {
      for (const [m, plts] of Object.entries(months)) {
        const monthEnd = new Date(Number(y), Number(m) + 1, 0);
        if (isNaN(cutoff) || monthEnd > cutoff) continue; // not settled yet
        const month = ym(y, m);
        for (const plt of ['fb', 'li', 'x']) {
          if (!plts[plt] || exempt(plt, month)) continue;
          for (const metric of ['imp', 'eng']) {
            const before = plts[plt][metric], after = cur(plt, month, metric);
            const key = `${plt}|${month}|${metric}`;
            if (warnings.has(key) || !bigMove(before, after, metric)) continue;
            warnings.set(key, { key, plt, network: PLT_NAMES[plt], month, metric, before, after,
                                flaggedAt: fmtISO(new Date()) });
          }
        }
      }
    }
  }
  orgData.meta.dataWarnings = [...warnings.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (orgData.meta.dataWarnings.length) {
    console.log(`\n── ⚠ Data checks: ${orgData.meta.dataWarnings.length} settled month(s) changed by more than 25% ──`);
    for (const w of orgData.meta.dataWarnings)
      console.log(`  ${w.network} ${w.month} ${w.metric}: ${w.before} → ${w.after}`);
  } else {
    console.log('\n── Data checks: no unexpected revisions to settled months ──');
  }
})();

const orgOutput = `// Auto-generated by build.js — do not edit manually.
// Built: ${orgData.meta.builtAt}
// Last data date: ${orgData.meta.lastDate}
window.DASHBOARD_DATA = ${JSON.stringify(orgData)};
`;
fs.writeFileSync(orgOutFile, orgOutput, 'utf8');
console.log(`✓ Written ${orgOutFile} (${(orgOutput.length/1024).toFixed(1)} KB)`);

// ── Build influencer data ─────────────────────────────────────────────────────
// Post Performance rows for non-Fund profiles (Heather today; any future
// influencer profiles automatically). Fund post rows are skipped here.
const postFiles = filesOfKind('posts');
if (postFiles.length > 0) {
  console.log(`\n── Influencer data (${postFiles.length} Post Performance file(s), oldest→newest) ──`);
  let infRows = [];
  for (const df of postFiles) {
    const inf  = df.rows.filter(r => !isOrgProfile(r['Profile']));
    const fund = df.rows.length - inf.length;
    console.log(`  ${df.rel}  (${inf.length} influencer rows${fund ? `; ${fund} Fund post rows not used yet` : ''})`);
    infRows = infRows.concat(inf);
  }

  const infData = buildInfluencerData(infRows);
  if (infData) {
    console.log(`Posts: ${infData.meta.totalPosts}`);
    console.log(`Profiles: ${infData.meta.profiles.join(', ')}`);
    console.log(`Date range: ${infData.meta.firstDate} → ${infData.meta.lastDate}`);

    const infOutput = `// Auto-generated by build.js — do not edit manually.
// Built: ${infData.meta.builtAt}
// Last data date: ${infData.meta.lastDate}
window.INFLUENCER_DATA = ${JSON.stringify(infData)};
`;
    fs.writeFileSync(infOutFile, infOutput, 'utf8');
    console.log(`✓ Written ${infOutFile} (${(infOutput.length/1024).toFixed(1)} KB)`);
  } else {
    console.log('  No influencer post rows found — skipping influencer_data.js');
  }
} else {
  console.log('\n── No Post Performance exports found — skipping influencer data ──');
}
 
// ═══════════════════════════════════════════════════════════════════════════════
// ── PART 3: COMPETITOR DASHBOARD (Sprout Competitor Performance + LinkedIn) ──
// ═══════════════════════════════════════════════════════════════════════════════
//
// Reads:
//   ./data/competitors/           Sprout "Competitor Performance" CSVs (Facebook + X).
//                                 "Competitor Posts" files in the same folder are
//                                 detected by their headers and skipped.
//   ./data/competitors_linkedin/  LinkedIn competitor snapshots. Two accepted forms:
//                                 (a) .xlsx — raw export downloaded directly from
//                                     LinkedIn's native "Competitors" tab, no
//                                     conversion needed. Parsed by
//                                     parseLinkedInRawXlsx() below; the month is
//                                     read from the date range in row 1, so each
//                                     file must cover a single calendar month
//                                     (multi-month aggregate exports are skipped
//                                     with a log message, not guessed at).
//                                 (b) .csv — pre-converted rows with columns
//                                     Month, Organization, Followers,
//                                     New Followers, Posts, Engagements.
//                                     Month accepts "2026-10" or "10/2026" or
//                                     "Oct 2026". Kept for historical/manual use.
// Writes:
//   ./docs/competitor_data.js     window.COMPETITOR_DATA
//
// Methodology notes baked in:
//   • Sprout backfills every profile's rows to the export start date regardless of
//     when tracking began, so coverage is derived from the data itself: an org's
//     series is masked (null) before its first month of non-zero activity, and its
//     follower series is masked before its first non-null Audience value.
//   • The four peers with verified continuous history to 2024 are flagged
//     hist2024:true — this powers the peer-set toggle in the dashboard.
//   • All Facebook/X engagement figures are Sprout PUBLIC engagements (reactions +
//     comments + shares). The Fund's own series in this dataset uses the identical
//     basis, so Fund-vs-peer comparisons are same-basis by construction.
//
// LinkedIn data source note (as of July 2026):
//   The original plan was a Sprout Social Premium Company Page upgrade in Q4 2026,
//   supporting up to 9 tracked competitors with 365-day retention. That plan is no
//   longer viable as described: LinkedIn now restricts free Company Pages to
//   tracking just 1 competitor (down from a prior limit of 9), and the peer list
//   cannot be edited, added to, or removed from on the free tier. Multi-competitor
//   *management* requires a paid LinkedIn Premium Company Page subscription (from
//   $99/month). However, LinkedIn appears to still be updating data for the 9-peer
//   list that was in place before the cap took effect (grandfathered, not editable)
//   pulled from LinkedIn's native admin "Competitors" analytics tab. This is
//   provisional, not guaranteed — LinkedIn could stop providing it at any time — so
//   treat new monthly exports as "keep uploading while it lasts," not a stable feed.
//   Engagements here = reactions + comments only (no shares field was available),
//   which differs from Facebook/X's public-engagements basis; see the in-app caveat.
//   New monthly files can be dropped in as the raw .xlsx export directly — no
//   manual conversion needed, see parseLinkedInRawXlsx() above.
//   Update (Oct 2026): The Fund now has a LinkedIn Premium Company Page and manages
//   its own competitor list. The first export on the new list covers Sep 2026. The
//   build detects peer-list changes automatically (meta.liPeerSets) so the dashboard
//   never mixes the legacy and current lists in one peer comparison.

// Parses a raw LinkedIn native "Competitors" tab export (.xlsx), no manual
// conversion needed. Expected shape:
//   Row 1:  [start date, end date]           e.g. 8/1/2025, 8/31/2025
//   Row 2:  Page | New Followers | Posts | Comments | Comments per day | Reactions
//   Row 3+: one row per tracked organization
// The month is derived from the row-1 date range; if start and end don't fall
// in the same calendar month (e.g. a rolling 12-month aggregate export rather
// than a single month), the file is skipped rather than guessed at, since
// mixing it with the monthly files would double-count.
function parseLinkedInRawXlsx(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = wb.SheetNames.includes('COMPETITORS') ? 'COMPETITORS' : wb.SheetNames[0];
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
  if (!grid.length) return { rows: [], skippedReason: 'empty sheet' };

  const parseDate = (v) => {
    if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
    const mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
    return mm ? new Date(Number(mm[3]), Number(mm[1]) - 1, Number(mm[2])) : null;
  };
  const s = parseDate(grid[0] && grid[0][0]);
  const e = parseDate(grid[0] && grid[0][1]);
  if (!s || !e) return { rows: [], skippedReason: `couldn't read a date range from row 1 ("${grid[0]}")` };
  const fmtD = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const DAY = 86400000;
  const spanDays = Math.round((e - s) / DAY) + 1;
  // Exact calendar month (1st through last day)?
  const exact = s.getDate() === 1 && e.getFullYear() === s.getFullYear() && e.getMonth() === s.getMonth() &&
                new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1).getDate() === 1;
  let y, m;
  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) {
    y = s.getFullYear(); m = s.getMonth();
  } else if (spanDays <= 35) {
    // Rolling ~30-day window (e.g. LinkedIn's "last 30 days", 8/31 -> 9/29):
    // assign it to the calendar month holding most of its days, and record the
    // actual window so the dashboard can footnote it.
    const counts = {};
    for (let d = new Date(s); d <= e; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const k = d.getFullYear() + ':' + d.getMonth(); counts[k] = (counts[k] || 0) + 1;
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
      return { rows: [], skippedReason: `row-1 window (${grid[0][0]} \u2192 ${grid[0][1]}) splits evenly across two months, so it can't be assigned to one; export a single calendar month instead` };
    }
    [y, m] = ranked[0][0].split(':').map(Number);
  } else {
    return { rows: [], skippedReason: `row-1 range spans ${spanDays} days (${grid[0][0]} \u2192 ${grid[0][1]}) \u2014 looks like a multi-month aggregate export, not a single monthly one; upload the individual monthly export instead` };
  }
  const month = y + '-' + String(m + 1).padStart(2, '0');
  const windowLabel = `${fmtD(s)}\u2013${fmtD(e)}`;

  const headerRow = grid[1] || [];
  const idx = {};
  headerRow.forEach((h, i) => { idx[String(h || '').toLowerCase().trim()] = i; });
  const pageIdx = idx['page'], newFIdx = idx['new followers'], postsIdx = idx['posts'],
        commentsIdx = idx['comments'], reactionsIdx = idx['reactions'];
  if (pageIdx == null || postsIdx == null || reactionsIdx == null) {
    return { rows: [], skippedReason: 'header row (row 2) didn\u2019t match the expected Page / New Followers / Posts / Comments / Reactions layout' };
  }

  const rows = [];
  for (let r = 2; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row[pageIdx] == null || row[pageIdx] === '') continue;
    const comments = Math.max(Number(row[commentsIdx]) || 0, 0); // guards a rare negative-delta artifact
    const reactions = Number(row[reactionsIdx]) || 0;
    rows.push({
      Month: month,
      Organization: String(row[pageIdx]).trim(),
      Followers: '',
      'New Followers': newFIdx != null ? row[newFIdx] : '',
      Posts: postsIdx != null ? row[postsIdx] : 0,
      Engagements: comments + reactions, // reactions + comments only; LinkedIn's native export has no shares field
      Window: windowLabel,
      Exact: exact,
    });
  }
  return { rows, skippedReason: null, month, window: windowLabel, exact };
}

const HISTORY_2024 = new Set([
  'A Better Chicago', 'Hope Chicago', 'IL Raise Your Hand', 'Kids First Chicago',
]);

const FUND_ORG_NAME = 'The Chicago Public Education Fund';

// Sprout exports X profiles as handles with a leading apostrophe (Excel guard).
const X_HANDLE_TO_ORG = {
  '@TheFundChicago':   FUND_ORG_NAME,
  '@_abetterchicago':  'A Better Chicago',
  '@HopeChicagoEdu':   'Hope Chicago',
  '@ILRaiseYourHand':  'IL Raise Your Hand',
  '@KidsFirstChi':     'Kids First Chicago',
};

function compNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (t === '' || t === 'N/A' || t === '-' || t === '—') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function monthKeyFromMDY(mdy) {
  // "01-31-2026" -> { y: 2026, m: 0 }
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((mdy || '').trim());
  if (!m) return null;
  return { y: Number(m[3]), m: Number(m[1]) - 1 };
}

function buildCompetitorData(perfRows, liRows) {
  // orgsByPlatform[platform][orgName] = {
  //   hist2024, firstActivity: 'YYYY-MM'|null, firstAudience: 'YYYY-MM'|null,
  //   monthly: { 'YYYY': [ {eng,posts,aud} | null  x12 ] } }
  const platforms = { fb: { orgs: {} }, x: { orgs: {} }, li: { orgs: {} } };
  let lastDateSeen = null;

  // ── Sprout Competitor Performance rows (daily) → monthly aggregates ──────────
  // accum[platform][org][ 'y:m' ] = { eng, posts, audLast, audDate, anyActivity }
  const accum = { fb: {}, x: {} };
  const firstActivity = { fb: {}, x: {} };
  const firstAudience = { fb: {}, x: {} };

  for (const row of perfRows) {
    const network = (row['Network'] || '').trim();
    let plat = null;
    if (network === 'Facebook') plat = 'fb';
    else if (network === 'X' || network === 'Twitter') plat = 'x';
    else continue; // ignore any other networks that appear in future exports

    let org = (row['Profile'] || '').trim().replace(/^'/, '');
    if (plat === 'x') org = X_HANDLE_TO_ORG[org] || org;

    const mk = monthKeyFromMDY(row['Date']);
    if (!mk) continue;
    const dateKey = row['Date'].trim();

    const eng   = compNum(row['Public Engagements']);
    const posts = compNum(row['Published Posts']);
    const aud   = compNum(row['Audience']);

    const byOrg = accum[plat];
    if (!byOrg[org]) byOrg[org] = {};
    const slotKey = mk.y + ':' + mk.m;
    if (!byOrg[org][slotKey]) byOrg[org][slotKey] = { eng: 0, posts: 0, audLast: null, audDate: '' };
    const slot = byOrg[org][slotKey];

    if (eng)   slot.eng   += eng;
    if (posts) slot.posts += posts;
    // Track the latest audience reading in the month (rows may not be ordered)
    if (aud != null && aud !== 0) {
      const sortable = dateKey.slice(6) + dateKey.slice(0, 2) + dateKey.slice(3, 5); // YYYYMMDD
      if (sortable >= slot.audDate) { slot.audLast = aud; slot.audDate = sortable; }
      const ym = mk.y + '-' + String(mk.m + 1).padStart(2, '0');
      if (!firstAudience[plat][org] || ym < firstAudience[plat][org]) firstAudience[plat][org] = ym;
    }
    if ((eng && eng !== 0) || (posts && posts !== 0) || (aud != null && aud !== 0)) {
      const ym = mk.y + '-' + String(mk.m + 1).padStart(2, '0');
      if (!firstActivity[plat][org] || ym < firstActivity[plat][org]) firstActivity[plat][org] = ym;
      if (!lastDateSeen || (dateKey.slice(6) + dateKey.slice(0, 2) + dateKey.slice(3, 5)) >
          (lastDateSeen.slice(6) + lastDateSeen.slice(0, 2) + lastDateSeen.slice(3, 5))) {
        lastDateSeen = dateKey;
      }
    }
  }

  for (const plat of ['fb', 'x']) {
    for (const org of Object.keys(accum[plat])) {
      const fa = firstActivity[plat][org] || null;
      const fAud = firstAudience[plat][org] || null;
      const monthly = {};
      for (const slotKey of Object.keys(accum[plat][org])) {
        const [y, m] = slotKey.split(':').map(Number);
        if (!monthly[y]) monthly[y] = Array(12).fill(null);
        const slot = accum[plat][org][slotKey];
        const ym = y + '-' + String(m + 1).padStart(2, '0');
        // Mask months before the org's first real activity (Sprout backfill guard)
        if (fa && ym < fa) continue;
        monthly[y][m] = {
          eng: slot.eng,
          posts: slot.posts,
          aud: (fAud && ym >= fAud) ? slot.audLast : null,
        };
      }
      platforms[plat].orgs[org] = {
        hist2024: HISTORY_2024.has(org) || org === FUND_ORG_NAME,
        firstActivity: fa,
        firstAudience: fAud,
        monthly,
      };
    }
  }

  // ── LinkedIn monthly snapshots ────────────────────────────────────────────────
  // liRows: array of parsed rows across all files, later files win on (month, org)
  const liByKey = {};
  const liWindows = {};   // 'YYYY-MM' -> { window, exact }
  for (const row of liRows) {
    // Header names are matched case-insensitively and loosely
    const get = (names) => {
      for (const k of Object.keys(row)) {
        const kk = k.toLowerCase().replace(/[^a-z]/g, '');
        for (const n of names) if (kk === n) return row[k];
      }
      return null;
    };
    const monthRaw = (get(['month', 'period', 'date']) || '').trim();
    const org = (get(['organization', 'org', 'page', 'company', 'profile']) || '').trim();
    if (!monthRaw || !org) continue;

    let y = null, m = null;
    let mm = /^(\d{4})-(\d{1,2})$/.exec(monthRaw);              // 2026-10
    if (mm) { y = Number(mm[1]); m = Number(mm[2]) - 1; }
    if (!mm) {
      mm = /^(\d{1,2})\/(\d{4})$/.exec(monthRaw);               // 10/2026
      if (mm) { y = Number(mm[2]); m = Number(mm[1]) - 1; }
    }
    if (!mm) {
      const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      mm = /^([A-Za-z]{3,})\s+(\d{4})$/.exec(monthRaw);          // Oct 2026 / October 2026
      if (mm) { y = Number(mm[2]); m = MON.indexOf(mm[1].slice(0, 3).toLowerCase()); }
    }
    if (y == null || m == null || m < 0) continue;

    const key = y + ':' + m + ':' + org;
    const exact = row.Exact !== false; // CSV rows (manual) are treated as calendar months
    // A true calendar-month export always beats a rolling-window export for the same month
    if (liByKey[key] && liByKey[key].exact && !exact) continue;
    const ymKey = y + '-' + String(m + 1).padStart(2, '0');
    if (row.Window && (!liWindows[ymKey] || !liWindows[ymKey].exact || exact)) liWindows[ymKey] = { window: row.Window, exact };
    liByKey[key] = {
      y, m, org, exact,
      aud:   compNum(get(['followers', 'totalfollowers', 'audience'])),
      newF:  compNum(get(['newfollowers', 'followergrowth'])),
      posts: compNum(get(['posts', 'totalposts', 'publishedposts'])),
      eng:   compNum(get(['engagements', 'totalengagements', 'publicengagements'])),
    };
  }
  for (const key of Object.keys(liByKey)) {
    const r = liByKey[key];
    if (!platforms.li.orgs[r.org]) {
      platforms.li.orgs[r.org] = { hist2024: false, firstActivity: null, firstAudience: null, monthly: {} };
    }
    const o = platforms.li.orgs[r.org];
    if (!o.monthly[r.y]) o.monthly[r.y] = Array(12).fill(null);
    o.monthly[r.y][r.m] = { eng: r.eng ?? 0, posts: r.posts ?? 0, aud: r.aud, newFollowers: r.newF };
    const ym = r.y + '-' + String(r.m + 1).padStart(2, '0');
    if (!o.firstActivity || ym < o.firstActivity) { o.firstActivity = ym; o.firstAudience = ym; }
  }

  // ── LinkedIn peer sets, derived from the data ─────────────────────────────────
  // A new peer set starts in any month where an org appears that the current set
  // hasn't tracked (e.g. the Sep 2026 switch from the grandfathered 9-peer list to
  // the Premium-managed list). An org dropping out of a month (e.g. Advance
  // Illinois missing from the Jul 2026 export) does NOT start a new set; it just
  // shows as a coverage gap for that org. Missing months don't start a set either.
  const liMonths = {};
  for (const r of Object.values(liByKey)) {
    const ym = r.y + '-' + String(r.m + 1).padStart(2, '0');
    (liMonths[ym] = liMonths[ym] || new Set()).add(r.org);
  }
  const liPeerSets = [];
  for (const ym of Object.keys(liMonths).sort()) {
    const monthOrgs = [...liMonths[ym]];
    const last = liPeerSets[liPeerSets.length - 1];
    if (last && monthOrgs.every(o => last.orgs.includes(o))) { last.to = ym; last.months.push(ym); }
    else liPeerSets.push({ from: ym, to: ym, months: [ym], orgs: monthOrgs });
  }
  liPeerSets.forEach(ps => ps.orgs.sort());
  const allLiMonths = Object.keys(liMonths).sort();
  const liMissingMonths = [];
  if (allLiMonths.length) {
    let [cy, cm] = allLiMonths[0].split('-').map(Number);
    const end = allLiMonths[allLiMonths.length - 1];
    while (true) {
      const k = cy + '-' + String(cm).padStart(2, '0');
      if (k > end) break;
      if (!liMonths[k]) liMissingMonths.push(k);
      cm++; if (cm > 12) { cm = 1; cy++; }
    }
  }

  return {
    fund: FUND_ORG_NAME,
    platforms,
    meta: {
      builtAt: new Date().toISOString(),
      lastDate: lastDateSeen,
      liActive: Object.keys(platforms.li.orgs).length > 0,
      liPeerSets,
      liWindows,
      liMissingMonths,
      notes: 'Facebook/X: public engagements (reactions+comments+shares). LinkedIn: reactions+comments only, no shares field available; LinkedIn native Competitors exports, one per month. Series masked before each org\u2019s first tracked activity.',
    },
  };
}

// ── Build competitor data ──────────────────────────────────────────────────────
// Inputs come from the same discovery pass as everything else, so competitor
// exports can sit anywhere under ./data/ (data/competitors/ still works).
const compOutFile = path.join(__dirname, 'docs', 'competitor_data.js');

// Sprout Competitor Performance (Facebook + X). Overlapping exports are
// de-duplicated by Date + Network + Profile, newest file winning, so leaving
// older exports in place can no longer double-count a period.
let compPerfRows = [];
const compPerfFiles = filesOfKind('compPerf');
if (compPerfFiles.length > 0) {
  console.log(`\n── Competitor data (${compPerfFiles.length} Competitor Performance file(s), oldest→newest) ──`);
  const byKey = new Map();
  let total = 0;
  for (const df of compPerfFiles) {
    console.log(`  ${df.rel}  (${df.rows.length} rows)`);
    for (const r of df.rows) {
      total++;
      byKey.set(`${(r['Date'] || '').trim()}|${(r['Network'] || '').trim()}|${(r['Profile'] || '').trim()}`, r);
    }
  }
  compPerfRows = [...byKey.values()];
  if (compPerfRows.length < total) console.log(`  ${total - compPerfRows.length} overlapping rows de-duplicated (newest export kept)`);
} else {
  console.log('\n── No Competitor Performance exports found — skipping Facebook/X peers ──');
}

// LinkedIn competitors: raw .xlsx exports from LinkedIn's native Competitors tab
// (any .xlsx under ./data/; other workbooks are skipped by the parser), plus the
// legacy pre-converted CSV form (Month, Organization, ...).
let compLiRows = [];
const liXlsx = listFilesRecursive(dataDir)
  .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith(correctionsDir + path.sep))
  .sort();
const liCsv = filesOfKind('liCompCsv');
if (liXlsx.length + liCsv.length > 0) {
  console.log(`\n── LinkedIn competitor snapshots (${liXlsx.length + liCsv.length} file(s)) ──`);
  for (const full of liXlsx) {
    const rel = path.relative(dataDir, full);
    let parsed;
    try { parsed = parseLinkedInRawXlsx(full); }
    catch (e) { console.log(`  ${rel}  (skipped — could not be read: ${e.message})`); continue; }
    const { rows, skippedReason, window: win, exact } = parsed;
    if (skippedReason) {
      console.log(`  ${rel}  (skipped — ${skippedReason})`);
    } else {
      console.log(`  ${rel}  (${rows.length} rows — raw LinkedIn export, ${rows[0] ? rows[0].Month : '?'}${exact ? '' : `, rolling window ${win} assigned by majority of days`})`);
      compLiRows = compLiRows.concat(rows);
    }
  }
  for (const df of liCsv) {
    console.log(`  ${df.rel}  (${df.rows.length} rows — pre-converted CSV)`);
    compLiRows = compLiRows.concat(df.rows);
  }
} else {
  console.log('\n── No LinkedIn competitor snapshots found ──');
}

if (compPerfRows.length > 0 || compLiRows.length > 0) {
  const compData = buildCompetitorData(compPerfRows, compLiRows);
  const fbOrgs = Object.keys(compData.platforms.fb.orgs).length;
  const xOrgs  = Object.keys(compData.platforms.x.orgs).length;
  const liOrgs = Object.keys(compData.platforms.li.orgs).length;
  console.log(`Competitor orgs — Facebook: ${fbOrgs}, X: ${xOrgs}, LinkedIn: ${liOrgs}${liOrgs === 0 ? ' (awaiting Q4 2026)' : ''}`);
  const compOutput = `// Auto-generated by build.js — do not edit manually.
// Built: ${compData.meta.builtAt}
window.COMPETITOR_DATA = ${JSON.stringify(compData)};
`;
  fs.writeFileSync(compOutFile, compOutput, 'utf8');
  console.log(`✓ Written ${compOutFile} (${(compOutput.length/1024).toFixed(1)} KB)`);
}

console.log('\nBuild complete.');
