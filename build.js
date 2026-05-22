#!/usr/bin/env node
/**
 * build.js — CPEF Social Media Dashboard Data Builder
 *
 * Reads every CSV file in ./data/ (Sprout Social "Profile Performance" exports),
 * merges them, and writes ./docs/data.js with a single `window.DASHBOARD_DATA`
 * object that the dashboard loads at runtime.
 *
 * Usage:
 *   node build.js
 */

const fs   = require('fs');
const path = require('path');

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

function num(str) {
  if (!str || str === '' || str === '-') return null;
  const s = str.replace(/,/g, '').replace(/%$/, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function platformKey(network) {
  const n = network.toLowerCase();
  if (n === 'x') return 'x';
  if (n === 'facebook') return 'fb';
  if (n === 'linkedin') return 'li';
  return null;
}

function buildData(allRows) {
  const daily = {};

  for (const row of allRows) {
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

  const monthly   = {};
  const quarterly = {};
  const annual    = {};
  const weeklyMap = {};
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

    const yr  = sampleDate.getFullYear();
    const mo  = sampleDate.getMonth();
    const q   = Math.floor(mo / 3) + 1;
    const { wy, wn } = isoWeek(sampleDate);
    const wKey = `${wy}-${wn}`;
    const ws   = weekStart(sampleDate);

    const syr = String(yr), smo = String(mo), sq = String(q);
    if (!monthly[syr])         monthly[syr] = {};
    if (!monthly[syr][smo])    monthly[syr][smo] = {};
    if (!quarterly[syr])       quarterly[syr] = {};
    if (!quarterly[syr][sq])   quarterly[syr][sq] = {};
    if (!annual[syr])          annual[syr] = {};

    for (const plt of [...PLTS, 'all']) {
      if (!monthly[syr][smo][plt])   monthly[syr][smo][plt]  = initMetrics();
      if (!quarterly[syr][sq][plt])  quarterly[syr][sq][plt] = initMetrics();
      if (!annual[syr][plt])         annual[syr][plt]        = initMetrics();
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
      const anyData = Object.values(plts).some(p => p.imp > 0 || p.eng > 0);
      if (!anyData) continue;
      finalMonthly[yr][mo] = {};
      for (const [plt, slot] of Object.entries(plts)) {
        finalMonthly[yr][mo][plt] = finalize(slot);
      }
    }
  }

  const finalQuarterly = {};
  for (const [yr, quarters] of Object.entries(quarterly)) {
    finalQuarterly[yr] = {};
    for (const [q, plts] of Object.entries(quarters)) {
      const anyData = Object.values(plts).some(p => p.imp > 0 || p.eng > 0);
      if (!anyData) continue;
      finalQuarterly[yr][q] = {};
      for (const [plt, slot] of Object.entries(plts)) {
        finalQuarterly[yr][q][plt] = finalize(slot);
      }
    }
  }

  const finalAnnual = {};
  for (const [yr, plts] of Object.entries(annual)) {
    const anyData = Object.values(plts).some(p => p.imp > 0 || p.eng > 0);
    if (!anyData) continue;
    finalAnnual[yr] = {};
    for (const [plt, slot] of Object.entries(plts)) {
      finalAnnual[yr][plt] = finalize(slot);
    }
  }

  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDate(d) {
    return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
  }
  function fmtISO(d) {
    return d.toISOString().slice(0, 10);
  }

  const finalWeekly = Object.values(weeklyMap)
    .sort((a, b) => a.wy !== b.wy ? a.wy - b.wy : a.wn - b.wn)
    .map(w => {
      const start = w.startDate;
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const label = `W${w.wn} ${w.wy} (${fmtDate(start)}\u2013${fmtDate(end)})`;
      const entry = { wy: w.wy, wn: w.wn, start: fmtISO(start), end: fmtISO(end), label };
      for (const plt of [...PLTS, 'all']) {
        entry[plt] = finalize(w[plt]);
      }
      return entry;
    });

  const lastDate = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : '';
  let lastDateFormatted = '';
  if (lastDate) {
    const [mm, dd, yyyy] = lastDate.split('-');
    const d = new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd));
    lastDateFormatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  return {
    monthly:   finalMonthly,
    quarterly: finalQuarterly,
    annual:    finalAnnual,
    weekly:    finalWeekly,
    meta: {
      builtAt: new Date().toISOString(),
      lastDate: lastDateFormatted,
    }
  };
}

const dataDir  = path.join(__dirname, 'data');
const outFile  = path.join(__dirname, 'docs', 'data.js');

const csvFiles = fs.readdirSync(dataDir)
  .filter(f => f.toLowerCase().endsWith('.csv'))
  .sort();

if (csvFiles.length === 0) {
  console.error('No CSV files found in ./data/');
  process.exit(1);
}

console.log(`Found ${csvFiles.length} CSV file(s):`);
let allRows = [];
for (const f of csvFiles) {
  const filepath = path.join(dataDir, f);
  const rows = parseCSV(filepath);
  console.log(`  ${f}  (${rows.length} rows)`);
  allRows = allRows.concat(rows);
}

console.log(`Total rows: ${allRows.length}`);
console.log('Building data structure...');

const data = buildData(allRows);

const years = Object.keys(data.annual).sort();
console.log(`Years with data: ${years.join(', ')}`);
console.log(`Weekly buckets: ${data.weekly.length}`);
console.log(`Last date in data: ${data.meta.lastDate}`);

const output = `// Auto-generated by build.js — do not edit manually.
// Built: ${data.meta.builtAt}
// Last data date: ${data.meta.lastDate}
window.DASHBOARD_DATA = ${JSON.stringify(data)};
`;

fs.writeFileSync(outFile, output, 'utf8');
console.log(`\n✓ Written to ${outFile}`);
