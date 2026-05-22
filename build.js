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
 */

const fs   = require('fs');
const path = require('path');

// ── SHARED: CSV PARSER ───────────────────────────────────────────────────────
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());

  function parseLine(line) {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        fields.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
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

// ── SHARED: DATE FORMATTER ───────────────────────────────────────────────────
function fmtISO(d) {
  return d.toISOString().slice(0, 10);
}

function fmtHuman(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── PART 1: ORG DASHBOARD (Profile Performance CSVs) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

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

function buildOrgData(allRows) {
  const daily = {};

  for (const row of allRows) {
    // Date format: MM-DD-YYYY
    const parts = row['Date'].split('-');
    if (parts.length !== 3) continue;
    const dateObj = new Date(
      parseInt(parts[2]),
      parseInt(parts[0]) - 1,
      parseInt(parts[1])
    );
    if (isNaN(dateObj.getTime())) continue;

    const plt = platformKey(row['Network']);
    if (!plt) continue;

    const dateKey = row['Date'];
    if (!daily[dateKey]) daily[dateKey] = {};

    daily[dateKey][plt] = {
      dateObj,
      imp:  num(row['Impressions'])                          ?? 0,
      eng:  num(row['Engagements'])                          ?? 0,
      rate: num(row['Engagement Rate (per Impression)']),
      aud:  num(row['Audience']),
    };
  }

  const monthly = {}, quarterly = {}, annual = {}, weeklyMap = {};
  const PLTS = ['x', 'fb', 'li'];

  function initMetrics() {
    return { imp: 0, eng: 0, rateNumer: 0, rateDenom: 0, audSamples: [] };
  }

  function addDay(slot, imp, eng, rate, aud) {
    slot.imp += imp;
    slot.eng += eng;
    if (rate !== null) {
      const w = imp > 0 ? imp : 1;
      slot.rateNumer += rate * w;
      slot.rateDenom += w;
    }
    if (aud !== null) slot.audSamples.push(aud);
  }

  const sortedDates = Object.keys(daily).sort((a, b) => {
    const [ma, da, ya] = a.split('-').map(Number);
    const [mb, db, yb] = b.split('-').map(Number);
    return new Date(ya, ma-1, da) - new Date(yb, mb-1, db);
  });

  for (const dateKey of sortedDates) {
    const dayData = daily[dateKey];
    const sampleDate = Object.values(dayData)[0]?.dateObj;
    if (!sampleDate) continue;

    const yr = sampleDate.getFullYear();
    const mo = sampleDate.getMonth();
    const q  = Math.floor(mo / 3) + 1;
    const { wy, wn } = isoWeek(sampleDate);
    const wKey = `${wy}-${wn}`;
    const ws   = weekStart(sampleDate);
    const syr  = String(yr), smo = String(mo), sq = String(q);

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
      const { imp, eng, rate, aud } = d;
      addDay(monthly[syr][smo][plt], imp, eng, rate, aud);
      addDay(quarterly[syr][sq][plt], imp, eng, rate, aud);
      addDay(annual[syr][plt], imp, eng, rate, aud);
      addDay(weeklyMap[wKey][plt], imp, eng, rate, aud);
      allDay.imp += imp;
      allDay.eng += eng;
      if (rate !== null) allDay.rates.push({ r: rate, w: imp > 0 ? imp : 1 });
      if (aud  !== null) allDay.auds.push(aud);
    }

    const allRateNumer = allDay.rates.reduce((s, x) => s + x.r * x.w, 0);
    const allRateDenom = allDay.rates.reduce((s, x) => s + x.w, 0);

    monthly[syr][smo]['all'].imp        += allDay.imp;
    monthly[syr][smo]['all'].eng        += allDay.eng;
    monthly[syr][smo]['all'].rateNumer  += allRateNumer;
    monthly[syr][smo]['all'].rateDenom  += allRateDenom;
    allDay.auds.forEach(a => monthly[syr][smo]['all'].audSamples.push(a));

    quarterly[syr][sq]['all'].imp       += allDay.imp;
    quarterly[syr][sq]['all'].eng       += allDay.eng;
    quarterly[syr][sq]['all'].rateNumer += allRateNumer;
    quarterly[syr][sq]['all'].rateDenom += allRateDenom;
    allDay.auds.forEach(a => quarterly[syr][sq]['all'].audSamples.push(a));

    annual[syr]['all'].imp              += allDay.imp;
    annual[syr]['all'].eng              += allDay.eng;
    annual[syr]['all'].rateNumer        += allRateNumer;
    annual[syr]['all'].rateDenom        += allRateDenom;
    allDay.auds.forEach(a => annual[syr]['all'].audSamples.push(a));

    weeklyMap[wKey]['all'].imp          += allDay.imp;
    weeklyMap[wKey]['all'].eng          += allDay.eng;
    weeklyMap[wKey]['all'].rateNumer    += allRateNumer;
    weeklyMap[wKey]['all'].rateDenom    += allRateDenom;
    allDay.auds.forEach(a => weeklyMap[wKey]['all'].audSamples.push(a));

    weeklyMap[wKey].endDate = sampleDate;
  }

  function finalize(slot) {
    const rate = slot.rateDenom > 0 ? +(slot.rateNumer / slot.rateDenom).toFixed(2) : null;
    const aud  = slot.audSamples.length > 0
      ? Math.round(slot.audSamples[slot.audSamples.length - 1])
      : null;
    return { imp: slot.imp, eng: slot.eng, rate, aud };
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
    const d = new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd));
    lastDateFormatted = fmtHuman(d);
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
  // Post Performance CSVs use MM/DD/YYYY H:MM am/pm date format
  // and are post-level (one row per post), not daily aggregates.
  // We only process Post Performance exports (they have a 'Post ID' column).

  const postRows = allRows.filter(r => r['Post ID'] && r['Post ID'].trim());
  if (postRows.length === 0) return null;

  const posts = [];

  for (const row of postRows) {
    // Parse date: "1/24/2024 1:19 pm" or "1/24/2024 1:19 PM"
    let dateObj = null;
    const rawDate = row['Date'];
    if (rawDate) {
      // Try M/D/YYYY H:MM am/pm
      const m = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) {
        dateObj = new Date(parseInt(m[3]), parseInt(m[1])-1, parseInt(m[2]));
      }
    }
    if (!dateObj || isNaN(dateObj.getTime())) continue;

    posts.push({
      date:        fmtISO(dateObj),
      year:        dateObj.getFullYear(),
      month:       dateObj.getMonth(),   // 0-based
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

  // Sort chronologically
  posts.sort((a, b) => a.date.localeCompare(b.date));

  // Deduplicate by link (later file wins — same merge strategy as org data)
  const seen = new Map();
  for (const p of posts) seen.set(p.link || p.date + p.post.slice(0,20), p);
  const dedupedPosts = Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ── Monthly aggregates ──────────────────────────────────────────────────────
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

  // ── Annual aggregates ───────────────────────────────────────────────────────
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

  // ── Identify unique influencers ─────────────────────────────────────────────
  const profiles = [...new Set(dedupedPosts.map(p => p.profile))].filter(Boolean);

  const firstDate = dedupedPosts[0].date;
  const lastDate  = dedupedPosts[dedupedPosts.length - 1].date;

  return {
    posts:   dedupedPosts,
    monthly: monthlyMap,
    annual:  annualMap,
    meta: {
      builtAt:    new Date().toISOString(),
      firstDate,
      lastDate,
      totalPosts: dedupedPosts.length,
      // Use first profile name found, or join multiple
      name: profiles.length === 1 ? profiles[0] : profiles.join(', '),
      profiles,
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MAIN ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const dataDir        = path.join(__dirname, 'data');
const influencerDir  = path.join(__dirname, 'data', 'influencers');
const orgOutFile     = path.join(__dirname, 'docs', 'data.js');
const infOutFile     = path.join(__dirname, 'docs', 'influencer_data.js');

// ── Build org data ────────────────────────────────────────────────────────────
const orgFiles = fs.readdirSync(dataDir)
  .filter(f => f.toLowerCase().endsWith('.csv'))
  .sort();

if (orgFiles.length === 0) {
  console.error('No org CSV files found in ./data/');
  process.exit(1);
}

console.log(`\n── Org data (${orgFiles.length} file(s)) ──`);
let orgRows = [];
for (const f of orgFiles) {
  const rows = parseCSV(path.join(dataDir, f));
  console.log(`  ${f}  (${rows.length} rows)`);
  orgRows = orgRows.concat(rows);
}

console.log(`Total org rows: ${orgRows.length}`);
const orgData = buildOrgData(orgRows);
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
  const infFiles = fs.readdirSync(influencerDir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .sort();

  if (infFiles.length > 0) {
    console.log(`\n── Influencer data (${infFiles.length} file(s)) ──`);
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
    console.log('\n── No influencer CSVs found in ./data/influencers/ — skipping ──');
  }
} else {
  console.log('\n── No ./data/influencers/ folder found — skipping influencer data ──');
}

console.log('\nBuild complete.');
