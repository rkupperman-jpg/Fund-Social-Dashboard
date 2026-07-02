#!/usr/bin/env node
/**
 * build.js — CPEF Social Media Dashboard Data Builder
 *
 * Reads org CSVs from ./data/ (Sprout Social "Profile Performance" exports)
 * and influencer CSVs from ./data/influencers/ (Sprout "Post Performance" exports),
 * then writes:
 *   ./docs/data.js             — org dashboard data (window.DASHBOARD_DATA)
 *   ./docs/influencer_data.js  — influencer dashboard data (window.INFLUENCER_DATA)
 *
 * Usage:
 *   node build.js
 *
 * To add new data:
 *   - Org updates:        drop new Profile Performance CSVs into ./data/
 *   - Influencer updates: drop new Post Performance CSVs into ./data/influencers/
 *
 * Multiple CSVs covering overlapping date ranges are supported — files are
 * sorted by the date range embedded in their filename (not upload time or
 * alphabetical order), and posts/rows are deduplicated so the newest export
 * always wins. Old files do NOT need to be deleted before uploading new ones.
 */
 
const fs   = require('fs');
const path = require('path');
 
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
 
// ── SHARED: FILE SORTING BY EMBEDDED DATE RANGE ──────────────────────────────
// Sprout export filenames end in a date range like "January 1, 2024 - June 30, 2026".
// We extract the LAST date found in the filename (the range's end date) and sort
// files by that, so the export with the newest data is always processed last —
// regardless of upload time, alphabetical filename sort, or git checkout mtimes.
// This means old exports can be left in place; simply uploading a CSV with a
// later end date is enough for it to take precedence.
function extractEndDateFromFilename(filename) {
  const months = { January:0, February:1, March:2, April:3, May:4, June:5,
                    July:6, August:7, September:8, October:9, November:10, December:11 };
  const re = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/g;
  let match, last = null;
  while ((match = re.exec(filename)) !== null) {
    const [, monthName, day, year] = match;
    if (months[monthName] === undefined) continue;
    last = new Date(parseInt(year), months[monthName], parseInt(day));
  }
  return last;
}
 
function sortFilesByEndDate(files) {
  return files
    .map(f => ({ f, endDate: extractEndDateFromFilename(f) }))
    .sort((a, b) => {
      if (!a.endDate && !b.endDate) return a.f.localeCompare(b.f);
      if (!a.endDate) return -1;
      if (!b.endDate) return 1;
      return a.endDate - b.endDate;
    })
    .map(x => {
      if (!x.endDate) console.log(`  \u26a0 Could not parse a date range from "${x.f}" — falling back to alphabetical order`);
      return x.f;
    });
}
 
// ═══════════════════════════════════════════════════════════════════════════════
// ── PART 1: ORG DASHBOARD (Profile Performance CSVs) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
 
// ── FACEBOOK PAGES CSV PARSER ─────────────────────────────────────────────────
// Reads Facebook Pages exports (from Sprout's "Facebook Pages" report) which
// contain Organic Views and Paid Views columns, and returns a Map of
// dateKey (MM-DD-YYYY) → { impOrganic, impPaid }
function buildFbPaidMap(fbDir) {
  const map = {};
  if (!fs.existsSync(fbDir)) return map;
  const files = sortFilesByEndDate(
    fs.readdirSync(fbDir).filter(f => f.toLowerCase().endsWith('.csv'))
  );
  if (files.length === 0) return map;
  console.log(`\n── Facebook Pages data (${files.length} file(s)) ──`);
  for (const f of files) {
    const rows = parseCSV(path.join(fbDir, f));
    console.log(`  ${f}  (${rows.length} rows)`);
    for (const row of rows) {
      const dateKey = row['Date'];
      if (!dateKey) continue;
      const organic = num(row['Organic Views']) ?? 0;
      const paid    = num(row['Paid Views'])    ?? 0;
      // Last file wins for overlapping dates (files now sorted oldest→newest
      // by embedded end date, so "last" reliably means "newest data")
      map[dateKey] = { impOrganic: organic, impPaid: paid };
    }
  }
  console.log(`Facebook paid/organic entries: ${Object.keys(map).length}`);
  return map;
}
 
function platformKey(network) {
  const n = network.toLowerCase();
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
 
    // Attach organic/paid split for Facebook if available
    if (plt === 'fb' && fbPaidMap[dateKey]) {
      entry.impOrganic = fbPaidMap[dateKey].impOrganic;
      entry.impPaid    = fbPaidMap[dateKey].impPaid;
    } else if (plt === 'fb') {
      // No Facebook Pages data for this date — treat all as organic
      entry.impOrganic = totalImp;
      entry.impPaid    = 0;
    }
 
    daily[dateKey][plt] = entry;
  }
 
  const monthly = {}, quarterly = {}, annual = {}, weeklyMap = {};
  const PLTS = ['x', 'fb', 'li'];
 
  function initMetrics() {
    return { imp: 0, impOrganic: 0, impPaid: 0, eng: 0, rateNumer: 0, rateDenom: 0, audSamples: [] };
  }
  function addDay(slot, imp, eng, rate, aud, impOrganic, impPaid) {
    slot.imp += imp; slot.eng += eng;
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
      allDay.imp += imp; allDay.eng += eng;
      if (rate !== null) allDay.rates.push({ r: rate, w: imp > 0 ? imp : 1 });
      // Update last known audience for this platform (used for 'all' sum below)
      if (aud !== null) lastKnownAud[plt] = aud;
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
    const knownPlts = PLTS.filter(p => lastKnownAud[p] !== null);
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
 
  const finalMonthly = {};
  for (const [yr, months] of Object.entries(monthly)) {
    finalMonthly[yr] = {};
    for (const [mo, plts] of Object.entries(months)) {
      if (!Object.values(plts).some(p => p.imp > 0 || p.eng > 0)) continue;
      finalMonthly[yr][mo] = {};
      for (const [plt, slot] of Object.entries(plts)) finalMonthly[yr][mo][plt] = finalize(slot);
    }
  }
 
  const finalQuarterly = {};
  for (const [yr, quarters] of Object.entries(quarterly)) {
    finalQuarterly[yr] = {};
    for (const [q, plts] of Object.entries(quarters)) {
      if (!Object.values(plts).some(p => p.imp > 0 || p.eng > 0)) continue;
      finalQuarterly[yr][q] = {};
      for (const [plt, slot] of Object.entries(plts)) finalQuarterly[yr][q][plt] = finalize(slot);
    }
  }
 
  const finalAnnual = {};
  for (const [yr, plts] of Object.entries(annual)) {
    if (!Object.values(plts).some(p => p.imp > 0 || p.eng > 0)) continue;
    finalAnnual[yr] = {};
    for (const [plt, slot] of Object.entries(plts)) finalAnnual[yr][plt] = finalize(slot);
  }
 
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const finalWeekly = Object.values(weeklyMap)
    .sort((a, b) => a.wy !== b.wy ? a.wy - b.wy : a.wn - b.wn)
    .map(w => {
      const start = w.startDate;
      const end = new Date(start); end.setDate(end.getDate() + 6);
      const label = `W${w.wn} ${w.wy} (${MONTH_ABBR[start.getMonth()]} ${start.getDate()}\u2013${MONTH_ABBR[end.getMonth()]} ${end.getDate()})`;
      const entry = { wy: w.wy, wn: w.wn, start: fmtISO(start), end: fmtISO(end), label };
      for (const plt of [...PLTS, 'all']) entry[plt] = finalize(w[plt]);
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
 
const dataDir       = path.join(__dirname, 'data');
const fbPagesDir    = path.join(__dirname, 'data', 'facebook_pages');
const influencerDir = path.join(__dirname, 'data', 'influencers');
const orgOutFile    = path.join(__dirname, 'docs', 'data.js');
const infOutFile    = path.join(__dirname, 'docs', 'influencer_data.js');
 
// ── Build org data ────────────────────────────────────────────────────────────
const orgFiles = sortFilesByEndDate(
  fs.readdirSync(dataDir).filter(f => f.toLowerCase().endsWith('.csv'))
);
 
if (orgFiles.length === 0) {
  console.error('No org CSV files found in ./data/');
  process.exit(1);
}
 
console.log(`\n── Org data (${orgFiles.length} file(s), oldest→newest by filename date range) ──`);
let orgRows = [];
for (const f of orgFiles) {
  const rows = parseCSV(path.join(dataDir, f));
  console.log(`  ${f}  (${rows.length} rows)`);
  orgRows = orgRows.concat(rows);
}
console.log(`Total org rows: ${orgRows.length}`);
 
// ── Load Facebook paid/organic split data ─────────────────────────────────────
const fbPaidMap = buildFbPaidMap(fbPagesDir);
 
const orgData = buildOrgData(orgRows, fbPaidMap);
console.log(`Years: ${Object.keys(orgData.annual).sort().join(', ')}`);
console.log(`Last date: ${orgData.meta.lastDate}`);
 
const orgOutput = `// Auto-generated by build.js — do not edit manually.
// Built: ${orgData.meta.builtAt}
// Last data date: ${orgData.meta.lastDate}
window.DASHBOARD_DATA = ${JSON.stringify(orgData)};
`;
fs.writeFileSync(orgOutFile, orgOutput, 'utf8');
console.log(`✓ Written ${orgOutFile} (${(orgOutput.length/1024).toFixed(1)} KB)`);
 
// ── Build influencer data ─────────────────────────────────────────────────────
if (fs.existsSync(influencerDir)) {
  const infFiles = sortFilesByEndDate(
    fs.readdirSync(influencerDir).filter(f => f.toLowerCase().endsWith('.csv'))
  );
 
  if (infFiles.length > 0) {
    console.log(`\n── Influencer data (${infFiles.length} file(s), oldest→newest by filename date range) ──`);
    let infRows = [];
    for (const f of infFiles) {
      const rows = parseCSV(path.join(influencerDir, f));
      console.log(`  ${f}  (${rows.length} rows)`);
      infRows = infRows.concat(rows);
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
      console.log('  No Post Performance rows found — skipping influencer_data.js');
    }
  } else {
    console.log('\n── No influencer CSVs in ./data/influencers/ — skipping ──');
  }
} else {
  console.log('\n── No ./data/influencers/ folder — skipping influencer data ──');
}
 
console.log('\nBuild complete.');
 
