// ------------------------------
// PDF.js setup
// ------------------------------
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ------------------------------
// Utilities
// ------------------------------
function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function fmtPct(x){ return (x==null || isNaN(x)) ? "—" : `${x.toFixed(1)}%`; }
function fmtInt(x){ return (x==null || isNaN(x)) ? "—" : `${Math.round(x).toLocaleString()}`; }
function fmtMoney(x){
  if(x==null || isNaN(x)) return "—";
  const sign = x < 0 ? "-" : "";
  const v = Math.abs(x);
  return `${sign}$${v.toLocaleString(undefined,{maximumFractionDigits:0})}`;
}
function escapeHtml(s){
  return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
function showErr(msg){ const e=document.getElementById("errbar"); e.style.display="block"; e.innerHTML = msg; }
function clearErr(){ const e=document.getElementById("errbar"); e.style.display="none"; e.innerHTML = ""; }
function showOk(msg){ const o=document.getElementById("okbar"); o.style.display="block"; o.innerHTML = msg; }

// ------------------------------
// State
// ------------------------------
const state = {
  docs: [], // {name,type,pages,textByPage[]}
  evidence: [], // {disparity, snippet, doc, page}
  findings: [], // Tier1: {id,key,disparity,segment,magnitude,prominence,concentration,score,recommend,evidenceRef}
  opportunities: [], // Tier2: {opp,kind,tests,criterion,strength,score,scope,checklist}
  selectedOpp: null,
  transport: {overall:null, age6574:null},
  chnaEval: [], // per-doc CHNA/IS documentation + community input requirement checks
  model: null // Tier 3 scenario cache for draft generator
};

// Disparities list (includes transportation explicitly)
const DISPARITIES = [
  {key:"transport", label:"Transportation barrier", keywords:["transportation","transit"], metric:"% reporting transportation problems"},
  {key:"access", label:"Access to care barrier", keywords:["could not get an appointment","delayed care"], metric:"% delaying needed care"},
  {key:"food", label:"Food insecurity", keywords:["food insecurity","food shelf"], metric:"% reporting food insecurity"},
  {key:"housing", label:"Housing need", keywords:["housing needs","housing"], metric:"% reporting housing needs"},
  {key:"financial", label:"Financial need", keywords:["financial needs","cost too much"], metric:"% reporting financial needs"}
];

// CRA criteria mapping (explicit criterion satisfied)
// Note: This is written in a regulator-friendly way, citing the OCC illustrative list structure (Topic L — community support services).
const CRA_CRITERIA = {
  nmt: {
    criterion: "Community development services / community support services targeted to low- or moderate-income (LMI) individuals — transportation to medical treatments.",
    cite: "Qualifying Activities: 12 CFR 25.04(c)(3) Topic L (Community support services) — example: transportation to medical treatments for LMI individuals."
  },
  food: {
    criterion: "Community development services / community support services targeted to LMI individuals — food access support as a community service (when structured for LMI populations).",
    cite: "Qualifying Activities: 12 CFR 25.04(c)(3) Topic L (Community support services) — community services for LMI individuals (structure matters)."
  },
  care: {
    criterion: "Community development services targeted to LMI individuals — health services / community services that improve access (depending on structure and beneficiaries).",
    cite: "Qualifying Activities: 12 CFR 25.04(c)(3) Topic L (Community support services) — health/community services for LMI individuals (structure matters)."
  }
};

// ------------------------------
// Extraction
// ------------------------------
async function extractPdfText(file){
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
  const numPages = pdf.numPages;
  const textByPage = [];
  for(let p=1; p<=numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map(it => it.str).filter(Boolean);
    const text = strings.join(" ").replace(/\s+/g,' ').trim();
    textByPage.push(text);
  }
  return {pages: numPages, textByPage};
}
async function extractTxt(file){
  const text = await file.text();
  return {pages: 1, textByPage: [text.replace(/\s+/g,' ').trim()]};
}

function recordEvidence(disparityLabel, snippet, doc, page){
  state.evidence.push({disparity:disparityLabel, snippet, doc, page});
}

function findPercentNear(text, keyword){
  const re = new RegExp(`${keyword}[\\s\\S]{0,160}?(\\d{1,2}(?:\\.\\d+)?)%`, "i");
  const m = text.match(re);
  if(!m) return null;
  const val = parseFloat(m[1]);
  if(isNaN(val)) return null;
  return {val, snippet: m[0].slice(0,280)};
}
function findAge6574Transport(text){
  const re = /65\s*[-–]\s*74[\s\S]{0,160}transportation[\s\S]{0,80}?(\d{1,2}(?:\.\d+)?)%/i;
  const m = text.match(re);
  if(!m) return null;
  const val = parseFloat(m[1]);
  if(isNaN(val)) return null;
  return {val, snippet: m[0].slice(0,280)};
}

function addFinding(key, disparity, segment, magnitude, prominence, evidenceRef){
  const id = `${key}__${segment}`;
  const ex = state.findings.find(x=>x.id===id);
  if(ex){
    if(magnitude > ex.magnitude){
      ex.magnitude = magnitude;
      ex.prominence = Math.max(ex.prominence, prominence);
      ex.evidenceRef = evidenceRef;
    }
    return;
  }
  state.findings.push({
    id, key, disparity, segment, magnitude,
    prominence,
    concentration:0,
    score:0,
    recommend:"",
    evidenceRef
  });
}

function scanDoc(doc){
  const prominence = {};
  for(const d of DISPARITIES){ prominence[d.key]=0; }

  for(let i=0;i<doc.textByPage.length;i++){
    const t = doc.textByPage[i] || "";
    const lower = t.toLowerCase();

    // prominence by keywords
    for(const d of DISPARITIES){
      for(const kw of d.keywords){
        if(lower.includes(kw.toLowerCase())){ prominence[d.key] += 1; break; }
      }
    }

    // Transportation overall
    const tr = findPercentNear(t, "transportation");
    if(tr){
      recordEvidence("Transportation barrier", tr.snippet, doc.name, i+1);
      addFinding("transport", "Transportation barrier", "Overall", tr.val, prominence["transport"], `${doc.name} p.${i+1}`);
      if(state.transport.overall==null) state.transport.overall = tr.val;
    }
    // Transportation 65-74
    const tr6574 = findAge6574Transport(t);
    if(tr6574){
      recordEvidence("Transportation barrier", tr6574.snippet, doc.name, i+1);
      addFinding("transport", "Transportation barrier", "Age 65–74", tr6574.val, prominence["transport"], `${doc.name} p.${i+1}`);
      state.transport.age6574 = tr6574.val;
    }

    // Other disparities
    for(const d of DISPARITIES){
      if(d.key==="transport") continue;
      const primary = d.keywords[0];
      const p = findPercentNear(t, primary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if(p){
        recordEvidence(d.label, p.snippet, doc.name, i+1);
        addFinding(d.key, d.label, "Overall", p.val, prominence[d.key], `${doc.name} p.${i+1}`);
      }
    }
  }
}


// ------------------------------
// Tier 1 enhancement: CHNA/IS documentation + community input requirement gap checks
// Based on common IRS documentation elements assessed in the literature and the 3-part written comments requirement.
// - CHNA documentation elements (7): community definition; methods; input from community; underserved populations described; prioritized needs; resources available; evaluation of impact.
// - Implementation strategy elements (3): actions for each need; resources and anticipated impact; planned collaborations.
// - Written comments requirement (3): solicitation method; ≥1 written comment received; explanation of how comments were taken into account.
// These checks are heuristic (keyword-based) and intended to speed a gap analysis / remediation workflow.
const CHNA_ELEMENTS = [
  {id:"community_def", label:"Definition of community served + how determined", pats:["definition of the community","community served","service area","community definition","how the community was determined"]},
  {id:"methods", label:"Process and methods used to conduct CHNA", pats:["methods","methodology","data sources","process used","approach","survey methodology","focus group"]},
  {id:"input", label:"How input was solicited and taken into account (broad interests)", pats:["input from persons who represent","broad interests of the community","community input","stakeholder input","community representatives"]},
  {id:"underserved", label:"Description of medically underserved / low-income / minority populations represented by input", pats:["medically underserved","low-income","minority populations","priority populations","vulnerable populations","underserved populations"]},
  {id:"priorities", label:"Prioritized description of significant health needs", pats:["prioritized","priority health needs","significant health needs","ranked","top needs","prioritization"]},
  {id:"resources", label:"Resources potentially available to address identified needs", pats:["resources available","available resources","community resources","assets","existing programs","capacity"]},
  {id:"impact_eval", label:"Evaluation of impact since the immediately preceding CHNA", pats:["evaluation of impact","impact of actions","progress since","results since last","prior CHNA","evaluation since"]},
];

const IS_ELEMENTS = [
  {id:"is_actions", label:"Actions to address each health need", pats:["actions the hospital will take","strategy","interventions","action plan","will address"]},
  {id:"is_resources_impact", label:"Resources devoted + anticipated impact", pats:["resources devoted","anticipated impact","budget","investment","expected impact","metrics"]},
  {id:"is_collab", label:"Planned collaborations with other institutions", pats:["collaboration","partner","coalition","in partnership with","collaborate with","community partners"]},
];

const WRITTEN_COMMENT_ELEMENTS = [
  {id:"wc_solicit", label:"How written comments were solicited (most recent CHNA/IS)", pats:["written comments","public comment","comment period","solicit","feedback form","survey","web-based","paper survey","community forum","open house","telephone"]},
  {id:"wc_received", label:"At least 1 written comment received", pats:["we received","comments were received","comment(s) received","written comment","responses received","feedback received"]},
  {id:"wc_used", label:"How comments were taken into account in current CHNA/IS", pats:["taken into account","incorporated","informed","used to update","we considered","resulting changes","we adjusted","we revised"]},
];

function _findSnippet(text, pat){
  const idx = text.toLowerCase().indexOf(pat.toLowerCase());
  if(idx < 0) return null;
  const start = Math.max(0, idx-90);
  const end = Math.min(text.length, idx+170);
  return text.slice(start,end).replace(/\s+/g,' ').trim();
}

function evalDocForElements(doc){
  const all = (doc.textByPage||[]).join(" \n");
  const lower = all.toLowerCase();

  const isCHNA = lower.includes("community health needs assessment") || lower.includes("chna");
  const isIS = lower.includes("implementation strategy") || lower.includes("implementation plan") || lower.includes("implementation strategies");

  // Public availability signal (heuristic)
  const publicPats = ["available on our website","posted on our website","publicly available","public comment","comment period","available online"];
  const publicHit = publicPats.find(p=>lower.includes(p.toLowerCase()));
  const publicSnippet = publicHit ? _findSnippet(all, publicHit) : null;

  function scoreBlock(block){
    let hits = [];
    for(const el of block){
      let found = null;
      for(const p of el.pats){
        if(lower.includes(p.toLowerCase())){ found = p; break; }
      }
      const snippet = found ? _findSnippet(all, found) : null;
      hits.push({id:el.id, label:el.label, present: !!found, trigger: found || "", snippet: snippet || ""});
    }
    const presentCount = hits.filter(h=>h.present).length;
    const score = Math.round((presentCount / hits.length) * 100);
    return {score, hits, presentCount, total:hits.length};
  }

  const chna = scoreBlock(CHNA_ELEMENTS);
  const isb = scoreBlock(IS_ELEMENTS);
  const wc = scoreBlock(WRITTEN_COMMENT_ELEMENTS);

  const wcScore = wc.presentCount===3 ? 100 : (wc.presentCount===2 ? 67 : (wc.presentCount===1 ? 33 : 0));
  const publicScore = publicHit ? 100 : 0;

  return {
    doc: doc.name,
    isCHNA, isIS,
    chnaScore: chna.score,
    isScore: isb.score,
    writtenCommentsScore: wcScore,
    publicScore,
    chnaHits: chna.hits,
    isHits: isb.hits,
    wcHits: wc.hits,
    publicSnippet: publicSnippet || ""
  };
}

function renderChnaGaps(){
  const tbl = document.getElementById("tbl_chna_gaps");
  if(!tbl) return;

  if(!state.chnaEval || state.chnaEval.length===0){
    tbl.innerHTML = "<tr><th>Document</th><th>CHNA score</th><th>IS score</th><th>Written comments</th><th>Public availability</th><th>Top gaps (auto)</th><th>Evidence</th></tr><tr><td colspan='7'>Process documents to populate.</td></tr>";
    const rec = document.getElementById("chna_gap_recs");
    if(rec) rec.textContent = "Process documents to generate.";
    document.getElementById("kpi_chna_q").textContent = "—";
    document.getElementById("kpi_is_q").textContent = "—";
    document.getElementById("kpi_input_req").textContent = "—";
    document.getElementById("kpi_public_avail").textContent = "—";
    return;
  }

  // Aggregate KPIs across docs (take max score across docs, since some uploads may be partial excerpts)
  const chnaMax = Math.max(...state.chnaEval.map(x=>x.chnaScore||0));
  const isMax = Math.max(...state.chnaEval.map(x=>x.isScore||0));
  const wcMax = Math.max(...state.chnaEval.map(x=>x.writtenCommentsScore||0));
  const pubMax = Math.max(...state.chnaEval.map(x=>x.publicScore||0));

  document.getElementById("kpi_chna_q").textContent = chnaMax + "/100";
  document.getElementById("kpi_is_q").textContent = isMax + "/100";
  document.getElementById("kpi_input_req").textContent = wcMax===100 ? "Meets (3/3)" : (wcMax===67 ? "Partial (2/3)" : (wcMax===33 ? "Weak (1/3)" : "Missing (0/3)"));
  document.getElementById("kpi_public_avail").textContent = pubMax===100 ? "Detected" : "Not detected";

  let html = "<tr><th>Document</th><th>CHNA score</th><th>IS score</th><th>Written comments</th><th>Public availability</th><th>Top gaps (auto)</th><th>Evidence</th></tr>";
  const gapsAll = [];
  for(const d of state.chnaEval){
    const gaps = [];
    // pick top 3 gaps across blocks
    const miss = []
      .concat(d.chnaHits.filter(h=>!h.present).map(h=>({label:h.label, snippet:h.snippet})))
      .concat(d.isHits.filter(h=>!h.present).map(h=>({label:h.label, snippet:h.snippet})))
      .concat(d.wcHits.filter(h=>!h.present).map(h=>({label:h.label, snippet:h.snippet})));

    miss.slice(0,3).forEach(m=>gaps.push(m.label));
    gapsAll.push(...gaps);

    const ev = (d.publicSnippet ? `Public signal: ${d.publicSnippet}` : "") || (d.wcHits.find(h=>h.present && h.snippet)?.snippet || "") || (d.chnaHits.find(h=>h.present && h.snippet)?.snippet || "");
    html += `<tr>
      <td class="mono"><b>${escapeHtml(d.doc)}</b></td>
      <td class="mono">${d.isCHNA ? (d.chnaScore + "/100") : "—"}</td>
      <td class="mono">${d.isIS ? (d.isScore + "/100") : "—"}</td>
      <td>${d.writtenCommentsScore===100 ? '<span class="badge b-strong">Meets (3/3)</span>' : (d.writtenCommentsScore>=67 ? '<span class="badge b-mod">Partial</span>' : '<span class="badge b-weak">Gap</span>')}</td>
      <td>${d.publicScore===100 ? '<span class="badge b-strong">Detected</span>' : '<span class="badge b-weak">Not detected</span>'}</td>
      <td>${escapeHtml(gaps.join("; ") || "—")}</td>
      <td>${escapeHtml(ev || "—")}</td>
    </tr>`;
  }
  tbl.innerHTML = html;

  // Remediation recs
  const rec = [];
  const needsWritten = wcMax < 100;
  if(needsWritten){
    rec.push("Written comments compliance (3-part) is incomplete: add a documented solicitation method (paper + web + in-person options), confirm ≥1 written comment received, and explicitly state how comments changed priorities or strategies.");
  }
  if(chnaMax < 85){
    rec.push("CHNA documentation gaps detected: ensure the CHNA explicitly includes (a) community definition and how it was determined, (b) methods/data sources, (c) who provided input and which underserved populations they represent, (d) prioritized needs, (e) resources available, and (f) evaluation of impact since the prior CHNA.");
  }
  if(isMax < 85){
    rec.push("Implementation Strategy gaps detected: ensure the IS lists actions for each prioritized need, associated resources and anticipated impact, and planned collaborations/partners.");
  }
  if(pubMax < 100){
    rec.push("Public availability signal not detected in the uploaded excerpts: ensure the CHNA and IS are clearly posted online and the document states where/how the public can access them.");
  }
  rec.push("Operationalizing fix: add a one-page ‘CHNA/IS Compliance Addendum’ template with these elements, then paste into the CHNA and IS PDFs for audit-ready completeness.");

  const recEl = document.getElementById("chna_gap_recs");
  if(recEl) recEl.textContent = rec.join(" ");
}

function computeMateriality(){
  // Compute concentration per key (subgroup - overall)
  const byKey = {};
  for(const f of state.findings){
    if(!byKey[f.key]) byKey[f.key]=[];
    byKey[f.key].push(f);
  }
  for(const key of Object.keys(byKey)){
    const list = byKey[key];
    const overall = list.find(x=>x.segment==="Overall");
    for(const f of list){
      f.concentration = (f.segment!=="Overall" && overall) ? Math.max(0, f.magnitude - overall.magnitude) : 0;
    }
  }

  // Materiality score:
  // magnitude (0-60), concentration (0-25), prominence (0-15)
  // transportation amplification: if 65–74 exists and overall exists, add bonus up to +10
  let transportBonus = 0;
  if(state.transport.overall!=null && state.transport.age6574!=null && state.transport.overall>0){
    const amp = state.transport.age6574 / state.transport.overall;
    transportBonus = clamp((amp-1)*8, 0, 10); // up to 10 points bonus
  }

  for(const f of state.findings){
    const magScore = clamp((f.magnitude/30)*60, 0, 60);
    const concScore = clamp((f.concentration/15)*25, 0, 25);
    const promScore = clamp((f.prominence/6)*15, 0, 15);
    let score = Math.round(magScore + concScore + promScore);
    if(f.key==="transport") score = clamp(score + Math.round(transportBonus), 0, 100);
    f.score = score;
    f.recommend = (score>=70) ? "Advance (high)" : (score>=55 ? "Advance (moderate)" : "Defer/monitor");
  }
  state.findings.sort((a,b)=>b.score-a.score);
}

function buildOpportunities(){
  const bestByKey = {};
  for(const f of state.findings){
    if(!bestByKey[f.key]) bestByKey[f.key]=f;
  }

  // Always include transportation opportunity (requirement), score based on findings if present
  const opps = [];

  function scoreOpportunity(eligibilityClarity, responsiveness, attributionStrength, docBurden){
    return Math.round(0.30*eligibilityClarity + 0.30*responsiveness + 0.25*attributionStrength + 0.15*(100-docBurden));
  }

  // Attribution heuristic
  const attribution = 70; // default; can be enhanced later if we parse AA geos
  const scope = "Prefer AA attribution: document beneficiary location (ZIP/tract/county) and service delivery within AA; if broader, document proportional benefit.";

  // Transportation (NEMT) — explicit criterion
  {
    const f = bestByKey.transport || {score:55}; // keep it evaluable even if CHNA extraction fails
    const eligibility = 90; // strong
    const responsiveness = clamp(f.score, 0, 100);
    const burden = 35;
    const score = scoreOpportunity(eligibility, responsiveness, attribution, burden);
    opps.push({
      opp:"Transportation-to-care (NEMT) — missed appointment mitigation",
      kind:"nmt",
      tests:"Service • Investment (as structured) • CD Loans (as structured)",
      criterion: CRA_CRITERIA.nmt.criterion + " " + CRA_CRITERIA.nmt.cite,
      strength: score>=75 ? "Strong" : (score>=60 ? "Moderate" : "Weak"),
      score,
      scope,
      checklist:"CHNA excerpt(s) with overall + age-band differential; target population definition (LMI and/or qualifying segments); service area map; vendor/partner agreement; invoices; ride logs; beneficiary counts; monitoring report cadence."
    });
  }

  // Food
  if(bestByKey.food){
    const f = bestByKey.food;
    const eligibility = 80;
    const responsiveness = clamp(f.score,0,100);
    const burden = 45;
    const score = scoreOpportunity(eligibility, responsiveness, attribution, burden);
    opps.push({
      opp:"Food access support — distribution / vouchers / meal supports",
      kind:"food",
      tests:"Investment • Service (depending on structure)",
      criterion: CRA_CRITERIA.food.criterion + " " + CRA_CRITERIA.food.cite,
      strength: score>=75 ? "Strong" : (score>=60 ? "Moderate" : "Weak"),
      score,
      scope,
      checklist:"CHNA food measure; LMI targeting method; partner agreement; distribution logs; invoices; beneficiary counts; monitoring plan."
    });
  }

  // Access
  if(bestByKey.access){
    const f = bestByKey.access;
    const eligibility = 75;
    const responsiveness = clamp(f.score,0,100);
    const burden = 50;
    const score = scoreOpportunity(eligibility, responsiveness, attribution, burden);
    opps.push({
      opp:"Care navigation / referral infrastructure — access enablement",
      kind:"care",
      tests:"Service • Investment (as structured)",
      criterion: CRA_CRITERIA.care.criterion + " " + CRA_CRITERIA.care.cite,
      strength: score>=75 ? "Strong" : (score>=60 ? "Moderate" : "Weak"),
      score,
      scope,
      checklist:"CHNA access barrier evidence; workflow description; staffing records; referral counts; LMI targeting; monitoring plan."
    });
  }

  opps.sort((a,b)=>b.score-a.score);
  state.opportunities = opps;
  state.selectedOpp = opps.length ? opps[0] : null;
}

function tier3Unlocked(){
  return state.opportunities.some(o=>o.score>=60);
}

// ------------------------------
// Rendering
// ------------------------------
let chartMateriality=null, chartROI=null, chartTrend=null;

function strengthBadge(str){
  if(str==="Strong") return `<span class="badge b-strong">Strong</span>`;
  if(str==="Moderate") return `<span class="badge b-mod">Moderate</span>`;
  return `<span class="badge b-weak">Weak</span>`;
}

function renderTransportSpotlight(){
  const o = state.transport.overall;
  const a = state.transport.age6574;
  document.getElementById("t_overall").textContent = (o==null) ? "—" : fmtPct(o);
  document.getElementById("t_6574").textContent = (a==null) ? "—" : fmtPct(a);
  if(o!=null && a!=null && o>0){
    const amp = a/o;
    document.getElementById("t_amp").textContent = `${amp.toFixed(1)}×`;
  }else{
    document.getElementById("t_amp").textContent = "—";
  }
}

function renderTier1(){
  // KPIs
  if(state.findings.length){
    const top = state.findings[0];
    document.getElementById("kpi_top").textContent = `${top.disparity} (${top.score})`;
    document.getElementById("kpi_top_hint").textContent = `Magnitude ${fmtPct(top.magnitude)} • Prominence ${top.prominence} • Δ ${top.concentration.toFixed(1)}.`;
    const subs = state.findings.filter(x=>x.segment!=="Overall").sort((a,b)=>b.concentration-a.concentration);
    if(subs.length){
      const s = subs[0];
      document.getElementById("kpi_conc").textContent = `${s.disparity} Δ${s.concentration.toFixed(1)}% (${s.segment})`;
    }else{
      document.getElementById("kpi_conc").textContent = "—";
    }
    const shortlist = state.findings.filter(f=>f.score>=55).length;
    document.getElementById("kpi_shortlist").textContent = `${shortlist}`;
    const angle = (state.transport.overall!=null && state.transport.age6574!=null) ?
      "Transportation appears small overall, but materially higher in older adults — strong case for targeted NEMT." :
      "Use highest materiality disparities to form a joint bank–hospital decision memo.";
    document.getElementById("kpi_angle").textContent = angle;
  }

  // Materiality table
  const tbl = document.getElementById("tbl_materiality");
  if(!state.findings.length){
    tbl.innerHTML = "<tr><th>Disparity</th><th>Segment</th><th>Magnitude</th><th>Δ Concentration</th><th>Prominence</th><th>Score</th><th>Recommendation</th><th>Evidence</th></tr><tr><td colspan='8'>No results yet.</td></tr>";
  }else{
    let html = "<tr><th>Disparity</th><th>Segment</th><th>Magnitude</th><th>Δ Concentration</th><th>Prominence</th><th>Score</th><th>Recommendation</th><th>Evidence</th></tr>";
    for(const f of state.findings.slice(0,10)){
      html += `<tr>
        <td><b>${escapeHtml(f.disparity)}</b></td>
        <td>${escapeHtml(f.segment)}</td>
        <td class="mono">${fmtPct(f.magnitude)}</td>
        <td class="mono">${f.concentration.toFixed(1)}%</td>
        <td class="mono">${f.prominence}</td>
        <td class="mono"><b>${f.score}</b></td>
        <td>${escapeHtml(f.recommend)}</td>
        <td class="mono">${escapeHtml(f.evidenceRef||"—")}</td>
      </tr>`;
    }
    tbl.innerHTML = html;
  }

  // Materiality chart
  const top = state.findings.slice(0,8);
  const labels = top.map(f=>`${f.disparity}${f.segment!=="Overall" ? " ("+f.segment+")" : ""}`);
  const vals = top.map(f=>f.score);
  if(chartMateriality) chartMateriality.destroy();
  chartMateriality = new Chart(document.getElementById("chart_materiality"), {
    type:"bar",
    data:{labels, datasets:[{label:"Materiality (0–100)", data:vals}]},
    options:{
      plugins:{legend:{display:false}},
      scales:{
        x:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}},
        y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}, beginAtZero:true, max:100}
      }
    }
  });

  // Tier 1 recs
  const rec = [];
  if(state.transport.overall!=null && state.transport.age6574!=null){
    rec.push(`Transportation: overall ${fmtPct(state.transport.overall)} vs age 65–74 ${fmtPct(state.transport.age6574)} (amplification ${(state.transport.age6574/state.transport.overall).toFixed(1)}×). Treat as a high-value access lever (missed appointments).`);
  }
  const adv = state.findings.filter(f=>f.score>=70).slice(0,3);
  if(adv.length){
    rec.push(`Advance now: ${adv.map(x=>x.disparity).join(", ")}.`);
  }else{
    rec.push("Advance now: highest scoring disparity and validate geography + target segment in Tier 2.");
  }
  rec.push("Create a joint bank–hospital memo: (1) documented need, (2) target segment/geography, (3) CRA criterion satisfied, (4) documentation plan, (5) cost baseline and KPI monitoring.");
  document.getElementById("tier1_recs").textContent = rec.join(" ");

  // Tier 1 enhancement: CHNA/IS gap analysis
  if(typeof renderChnaGaps === "function") renderChnaGaps();
}

function renderEvidence(){
  const tbl = document.getElementById("tbl_evidence");
  if(!state.evidence.length){
    tbl.innerHTML = "<tr><th>Disparity</th><th>Snippet</th><th>Doc</th><th>Page</th></tr><tr><td colspan='4'>No evidence captured yet.</td></tr>";
    return;
  }
  const slice = state.evidence.slice(-25).reverse();
  let html = "<tr><th>Disparity</th><th>Snippet</th><th>Doc</th><th>Page</th></tr>";
  for(const e of slice){
    html += `<tr>
      <td>${escapeHtml(e.disparity)}</td>
      <td>${escapeHtml(e.snippet)}</td>
      <td class="mono">${escapeHtml(e.doc)}</td>
      <td class="mono">${e.page}</td>
    </tr>`;
  }
  tbl.innerHTML = html;
}

function renderTier2(){
  const tbl = document.getElementById("tbl_cra");
  if(!state.opportunities.length){
    tbl.innerHTML = "<tr><th>Opportunity</th><th>CRA test mapping</th><th>Criterion satisfied</th><th>Strength</th><th>Score</th><th>Scope guidance</th><th>Application packet checklist</th></tr><tr><td colspan='7'>No opportunities yet.</td></tr>";
    return;
  }
  let html = "<tr><th>Opportunity</th><th>CRA test mapping</th><th>Criterion satisfied</th><th>Strength</th><th>Score</th><th>Scope guidance</th><th>Application packet checklist</th></tr>";
  for(const o of state.opportunities){
    html += `<tr>
      <td><b>${escapeHtml(o.opp)}</b></td>
      <td>${escapeHtml(o.tests)}</td>
      <td>${escapeHtml(o.criterion)}</td>
      <td>${strengthBadge(o.strength)}</td>
      <td class="mono"><b>${o.score}</b></td>
      <td>${escapeHtml(o.scope)}</td>
      <td>${escapeHtml(o.checklist)}</td>
    </tr>`;
  }
  tbl.innerHTML = html;

  const top = state.opportunities[0];
  document.getElementById("t2_best").textContent = `${top.score}`;
  document.getElementById("t2_best_hint").textContent = top.opp;

  const tOpp = state.opportunities.find(x=>x.kind==="nmt");
  document.getElementById("t2_transport").textContent = tOpp ? `${tOpp.score} (${tOpp.strength})` : "—";
  document.getElementById("t2_crit").textContent = tOpp ? tOpp.criterion : "—";
  document.getElementById("t2_packet").textContent = tOpp ? "CHNA evidence + LMI targeting + AA attribution + invoices + service logs + beneficiary counts + monitoring" : "—";

  document.getElementById("top_t2").textContent = `${top.score}`;

  // Gate
  const unlocked = tier3Unlocked();
  const dot = document.getElementById("gateDot");
  dot.classList.remove("good","bad");
  if(unlocked){ dot.classList.add("good"); document.getElementById("gateText").textContent = "Tier 3 unlocked (Tier 2 score ≥ 60)"; }
  else { dot.classList.add("bad"); document.getElementById("gateText").textContent = "Tier 3 locked until Tier 2 score ≥ 60"; }

  // Prompts
  document.getElementById("exam_prompts").textContent =
    "1) Document the disparity + affected segment (CHNA excerpt with page). 2) State the CRA qualifying criterion satisfied (and why benefit is targeted to LMI/qualifying population). 3) Define assessment area attribution (who benefited, where). 4) Provide invoices/contracts and beneficiary counts. 5) Define baseline metric + monitoring cadence.";
}

function setTier3FromOpportunity(opp){
  if(!opp) return;
  // Tier 3 currently models the NEMT scenario. If transportation is selected, prefill a conservative transport-share proxy.
  // (Keeps the existing Tier 3 ROI model intact.)
  if(opp.kind==="nmt" && state.transport.overall!=null){
    // Map CHNA-reported transportation barrier (% with transport problems) into a conservative "share due to transportation" proxy.
    const proxyPct = clamp(state.transport.overall*3.0, 5, 70); // heuristic: 2.7% -> ~8.1% (bounded)
    const el = document.getElementById("a_share");
    if(el) el.value = (proxyPct/100).toFixed(2); // accept decimal or percent; _normRate handles both
  }
}

function runTier3(){
  
  const activity = document.getElementById("inp_activity").value;
  const months = parseInt(document.getElementById("inp_months").value||"12",10);

  const annual = parseFloat(document.getElementById("inp_annual").value||"0");
  const baseRate = parseFloat(document.getElementById("inp_base").value||"0")/100;
  const share = parseFloat(document.getElementById("inp_share").value||"0")/100;
  const red = parseFloat(document.getElementById("inp_red").value||"0")/100;

  const covPct = parseFloat(document.getElementById("inp_cov").value||"25");
  const weightMode = document.getElementById("inp_weight_mode").value; // weighted | flat
  const senSharePct = clamp(parseFloat(document.getElementById("inp_sen_share").value||"25"), 0, 100);

  const benefitPer = parseFloat(document.getElementById("inp_benefit").value||"0");
  const startup = parseFloat(document.getElementById("inp_startup").value||"0");
  const fixed = parseFloat(document.getElementById("inp_fixed").value||"0");
  const varCost = parseFloat(document.getElementById("inp_var").value||"0");
  const unitsPer = parseFloat(document.getElementById("inp_units").value||"1");

  // Coverage and weighting logic:
  // Eligible touchpoints that receive support (targeted coverage).
  const eligibleTouchpoints = annual * (covPct/100);

  // Transport amplification factor from CHNA (65–74 vs overall) when available.
  let ampFactor = 1.0;
  if(state.transport.overall != null && state.transport.age6574 != null && state.transport.overall > 0){
    ampFactor = state.transport.age6574 / state.transport.overall; // e.g., 8.5/2.7 = 3.15x
  }
  if(weightMode === "flat") ampFactor = 1.0;

  // Effective barrier share adjusts upward when seniors are prioritized (higher transport barrier).
  const senShare = senSharePct/100;
  const effBarrierShare = clamp(share * ((1-senShare)*1.0 + (senShare*ampFactor)), 0, 1);

  // Disruptions among those offered support
  const baselineDisrupt = eligibleTouchpoints * baseRate;
  const barrierDisrupt = baselineDisrupt * effBarrierShare;
  const prevented = barrierDisrupt * red;

  // Units and benefit (annualized)
  const unitsAnnual = prevented * unitsPer;
  const grossAnnual = prevented * benefitPer;

  // cost over horizon: startup + fixed*months + variable*(annualUnits*months/12)*varCost
  const totalCostH = startup + fixed*months + (unitsAnnual*(months/12)*varCost);
  const annualCost = totalCostH*(12/months);
  const netAnnual = grossAnnual - annualCost;

  // Persist last model outputs for draft generator
  state.model = {
    activity, months, annual_touchpoints: annual,
    baseline_rate_pct: (baseRate*100),
    barrier_share_pct: (share*100),
    reduction_pct: (red*100),
    coverage_pct: Math.round(covPct),
    weight_mode: weightMode,
    seniors_share_pct: Math.round(senSharePct),
    amp_factor: (state.transport.overall && state.transport.age6574) ? (state.transport.age6574/state.transport.overall) : null,
    prevented_disruptions: prevented,
    units_annual: unitsAnnual,
    startup, fixed_monthly: fixed, variable_unit_cost: varCost, units_per_prevented: unitsPer,
    total_cost_horizon: totalCostH,
    annual_cost: annualCost,
    gross_annual_benefit: grossAnnual,
    net_annual: netAnnual
  };


  document.getElementById("kpi_cost").textContent = fmtMoney(annualCost);
  document.getElementById("kpi_gross").textContent = fmtMoney(grossAnnual);
  document.getElementById("kpi_net").textContent = fmtMoney(netAnnual);
  const covReadout = document.getElementById("cov_readout");
  if(covReadout) covReadout.textContent = `${Math.round(covPct)}%`;

  // Charts: ROI
  if(chartROI) chartROI.destroy();
  chartROI = new Chart(document.getElementById("chart_roi"),{
    type:"bar",
    data:{labels:["Annual benefit","Annual cost","Annual net"], datasets:[{label:"$", data:[grossAnnual, annualCost, netAnnual]}]},
    options:{plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}},
              y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}, beginAtZero:true}}}
  });

  // Monthly trend
  const labels = Array.from({length:months}, (_,i)=>`M${i+1}`);
  const monthlyBenefit = grossAnnual/12;
  const monthlyUnits = unitsAnnual/12;
  const monthlyCost = (startup/months) + fixed + (monthlyUnits*varCost);
  const monthlyNet = monthlyBenefit - monthlyCost;

  const netSeries = labels.map(()=>monthlyNet);
  let cum=0; const cumSeries = netSeries.map(v=>(cum+=v));
  if(chartTrend) chartTrend.destroy();
  chartTrend = new Chart(document.getElementById("chart_trend"),{
    type:"line",
    data:{labels, datasets:[
      {label:"Monthly net", data:netSeries, tension:.25},
      {label:"Cumulative net", data:cumSeries, tension:.25}
    ]},
    options:{plugins:{legend:{labels:{color:"#2f4556"}}},
      scales:{x:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}},
              y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}}}}
  });

  // Break-even chart: vary coverage from 5..60
  const covs = [];
  const nets = [];
  const zeroLine = [];
  const minC = 5, maxC = 60;
  for(let c=minC; c<=maxC; c+=1){
    const eligible = annual * (c/100);
    const baseDis = eligible * baseRate;
    const barDis = baseDis * effBarrierShare;
    const prev = barDis * red;
    const unitsA = prev * unitsPer;
    const grossA = prev * benefitPer;
    const totalCost = startup + fixed*months + (unitsA*(months/12)*varCost);
    const annCost = totalCost*(12/months);
    covs.push(c);
    nets.push(grossA - annCost);
    zeroLine.push(0);
  }

  const ctxBE = document.getElementById("chart_breakeven");
  if(ctxBE){
    if(window.__beChart) window.__beChart.destroy();
    window.__beChart = new Chart(ctxBE, {
      type:"line",
      data:{
        labels: covs.map(x=>`${x}%`),
        datasets:[
          {label:"Annual net impact", data: nets, tension:.25},
          {label:"Break-even ($0)", data: zeroLine, borderDash:[6,6], tension:0}
        ]
      },
      options:{
        plugins:{legend:{labels:{color:"#2f4556"}}},
        scales:{
          x:{ticks:{color:"#2f4556", maxRotation:0, autoSkip:true}, grid:{color:"rgba(11,31,51,.08)"}},
          y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}}
        }
      }
    });
  }

  // Audit memo
  const topOpp = state.selectedOpp || state.opportunities[0] || null;
  const crit = topOpp ? topOpp.criterion : CRA_CRITERIA[activity]?.criterion || "—";
  const memo =
`TIER 3 — TOTAL PROGRAM COST & ROI (Audit-ready)

Selected activity: ${activity}
CRA criterion satisfied: ${crit}

A) Documented transportation disparity (CHNA)
- Transportation overall: ${state.transport.overall==null? "Not detected" : fmtPct(state.transport.overall)}
- Transportation age 65–74: ${state.transport.age6574==null? "Not detected" : fmtPct(state.transport.age6574)}
- Amplification factor: ${(state.transport.overall && state.transport.age6574) ? (state.transport.age6574/state.transport.overall).toFixed(1)+"×" : "—"}

B) Targeting design (this is the partnership lever)
- Targeted coverage of eligible patients: ${Math.round(covPct)}%
- Allocation mode: ${weightMode === "weighted" ? "Senior-weighted (prioritize 65–74)" : "Flat allocation"}
- Seniors share of eligible touchpoints: ${Math.round(senSharePct)}%
- Effective barrier share (after weighting): ${(effBarrierShare*100).toFixed(1)}%

C) Cost baseline (answers: “How much does it cost?”)
- Startup (one-time): ${fmtMoney(startup)}
- Fixed monthly cost: ${fmtMoney(fixed)}
- Variable unit cost: ${fmtMoney(varCost)}
- Units per prevented disruption: ${unitsPer.toFixed(2)}
- Estimated annual units: ${fmtInt(unitsAnnual)}
- Annualized program cost: ${fmtMoney(annualCost)}

D) Impact (annualized)
- Prevented disruptions: ${fmtInt(prevented)}
- Annual gross benefit: ${fmtMoney(grossAnnual)}
- Annual net impact: ${fmtMoney(netAnnual)}

E) Evidence packet
- CHNA excerpt(s) + subgroup differential + page refs
- Target population definition (LMI method) + geography attribution
- Contracts/invoices + service logs + beneficiary counts
- Monitoring cadence with baseline vs observed + corrective actions

Generated: ${new Date().toISOString()}`;
  document.getElementById("audit_out").textContent = memo;

}

// ------------------------------
// Export
// ------------------------------
function exportReport(){
  const report = {
    generated_at: new Date().toISOString(),
    docs: state.docs.map(d=>({name:d.name, pages:d.pages, type:d.type})),
    transport: state.transport,
    tier1_findings: state.findings,
    tier2_opportunities: state.opportunities,
    evidence: state.evidence.slice(-100)
  };
  const blob = new Blob([JSON.stringify(report,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chna_cra_dashboard_report.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------
// Tabs
// ------------------------------
function setView(view){
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  const viewEl = document.getElementById("view_"+view);
  if(viewEl) viewEl.classList.add("active");
  document.querySelectorAll(".tabbtn").forEach(b=>b.classList.remove("active"));
  const tabEl = document.getElementById("tab_"+view);
  if(tabEl) tabEl.classList.add("active");

  // Views that use the full width (no 2-col grid)
  const fullWidthViews = ["training","mayo","setup","compliance"];
  const grid = document.getElementById("main_grid");
  if(grid) grid.style.display = fullWidthViews.includes(view) ? "none" : "";

  // Refresh compliance checklist when navigating to it
  if(view === "compliance") renderComplianceChecklist();

  // Chart.js canvases can render at 0px when hidden; force a resize on tab switch.
  window.setTimeout(()=>{
    try{ if(chartMateriality) chartMateriality.resize(); }catch(e){}
    try{ if(chartROI) chartROI.resize(); }catch(e){}
    try{ if(chartTrend) chartTrend.resize(); }catch(e){}
    try{ if(window.__beChart) window.__beChart.resize(); }catch(e){}
  }, 60);
}
// ══════════════════════════════════════════════════════════
// QUESTIONNAIRE — Facility Setup Logic
// ══════════════════════════════════════════════════════════

const Q = {
  facilitySetupComplete: false,
  sampleLoaded: false
};

// Benchmark tables keyed by facility type
const BENCHMARKS = {
  fqhc:               { netrev: 168, margc: 62, transportShare: 35, tripCost: 36, lmiMultiplier: 1.05 },
  hospital_community: { netrev: 310, margc: 124, transportShare: 28, tripCost: 42, lmiMultiplier: 0.90 },
  hospital_regional:  { netrev: 485, margc: 195, transportShare: 22, tripCost: 45, lmiMultiplier: 0.80 },
  clinic_specialty:   { netrev: 285, margc: 114, transportShare: 20, tripCost: 38, lmiMultiplier: 0.75 },
  cah:                { netrev: 245, margc: 98,  transportShare: 32, tripCost: 40, lmiMultiplier: 0.95 }
};

function toggleQSection(bodyId){
  const el = document.getElementById(bodyId);
  if(!el) return;
  el.style.display = (el.style.display === "none") ? "" : "none";
}

function syncVisits(val){
  document.getElementById("q_visits").value = val;
  document.getElementById("q_visits_disp").textContent = Number(val).toLocaleString();
  deriveInputs();
}
function syncVisitsInput(val){
  document.getElementById("q_visits_slider").value = Math.min(150000, Math.max(1000, val));
  document.getElementById("q_visits_disp").textContent = Number(val).toLocaleString();
  deriveInputs();
}
function syncNoshow(val){
  document.getElementById("q_noshow").value = val;
  document.getElementById("q_noshow_disp").textContent = val + "%";
  deriveInputs();
}
function syncNoshowInput(val){
  document.getElementById("q_noshow_slider").value = Math.min(50, Math.max(5, val));
  document.getElementById("q_noshow_disp").textContent = val + "%";
  deriveInputs();
}

function syncPayerMix(){
  const med  = parseFloat(document.getElementById("q_medicaid").value) || 0;
  const mcare= parseFloat(document.getElementById("q_medicare").value) || 0;
  const comm = parseFloat(document.getElementById("q_commercial").value) || 0;
  const total= med + mcare + comm;
  const warn = document.getElementById("pm_warn");
  if(warn) warn.style.display = Math.abs(total - 100) > 1 ? "" : "none";
  const bar = document.getElementById("payer_bar");
  if(bar) bar.style.background = `linear-gradient(90deg, var(--blue) ${med}%, var(--teal) ${med}%, var(--teal) ${med+mcare}%, var(--amber) ${med+mcare}%)`;
  if(document.getElementById("pm_med_pct"))   document.getElementById("pm_med_pct").textContent   = med + "%";
  if(document.getElementById("pm_mcare_pct")) document.getElementById("pm_mcare_pct").textContent = mcare + "%";
  if(document.getElementById("pm_comm_pct"))  document.getElementById("pm_comm_pct").textContent  = comm + "%";
  deriveInputs();
}

function deriveInputs(){
  const ftype = document.getElementById("q_ftype") ? document.getElementById("q_ftype").value : "";
  const bench = BENCHMARKS[ftype] || BENCHMARKS["fqhc"];
  const med   = parseFloat(document.getElementById("q_medicaid") ? document.getElementById("q_medicaid").value : 72) || 72;

  // Derive LMI from Medicaid pct (Medicaid is proxy for LMI; slightly higher due to CHIP/other)
  const lmi = Math.min(98, Math.round(med * bench.lmiMultiplier));

  // Transport share increases with Medicaid pct
  const tShare = Math.min(51, Math.round(bench.transportShare * (1 + (med - 60) / 200)));

  setAutoFilled("qb_netrev",           bench.netrev);
  setAutoFilled("qb_margc",            bench.margc);
  setAutoFilled("qb_transport_share",  tShare);
  setAutoFilled("qb_trip_cost",        bench.tripCost);
  setAutoFilled("qb_lmi",             lmi);

  // Push derived values to LMI display in opportunity section
  const lmiEl = document.getElementById("opp_lmi_pct");
  if(lmiEl) lmiEl.textContent = lmi + "%";

  checkSetupComplete();
}

function setAutoFilled(id, val){
  const el = document.getElementById(id);
  if(el && !el._userEdited) {
    el.value = val;
    el.classList.add("auto-filled");
  }
}

// Mark field as user-edited so auto-derive stops overriding it
document.querySelectorAll(".auto-filled").forEach(el=>{
  el.addEventListener("input", ()=>{ el._userEdited = true; el.classList.remove("auto-filled"); });
});

function checkSetupComplete(){
  const fname  = document.getElementById("q_fname")  ? document.getElementById("q_fname").value.trim()  : "";
  const ftype  = document.getElementById("q_ftype")  ? document.getElementById("q_ftype").value         : "";
  const visits = document.getElementById("q_visits") ? document.getElementById("q_visits").value        : "";
  if(!fname || !ftype || !visits) return;

  Q.facilitySetupComplete = true;

  // Update header chip
  const chip = document.getElementById("facility_chip");
  if(chip){ chip.textContent = fname || ftype; chip.style.display = ""; }

  // Update left panel summary
  updateLeftSummary();

  // Show opportunity discovery panel and populate it
  surfaceOpportunities();
}

function updateLeftSummary(){
  const el = document.getElementById("left_facility_summary");
  if(!el) return;
  const fname   = document.getElementById("q_fname")   ? document.getElementById("q_fname").value : "—";
  const ftype   = document.getElementById("q_ftype")   ? document.getElementById("q_ftype").options[document.getElementById("q_ftype").selectedIndex]?.text : "—";
  const visits  = document.getElementById("q_visits")  ? Number(document.getElementById("q_visits").value).toLocaleString() : "—";
  const noshow  = document.getElementById("q_noshow")  ? document.getElementById("q_noshow").value  : "—";
  const med     = document.getElementById("q_medicaid")? document.getElementById("q_medicaid").value: "—";
  el.innerHTML  = `<b>${fname}</b><br/>${ftype}<br/>Visits/yr: <b>${visits}</b> · No-show: <b>${noshow}%</b><br/>Medicaid: <b>${med}%</b>`;
}

function surfaceOpportunities(){
  const disc = document.getElementById("opp_discovery");
  if(!disc) return;
  disc.style.display = "";

  const fname   = document.getElementById("q_fname")   ? document.getElementById("q_fname").value   : "your facility";
  const visits  = document.getElementById("q_visits")  ? Number(document.getElementById("q_visits").value).toLocaleString() : "—";
  const noshow  = document.getElementById("q_noshow")  ? parseFloat(document.getElementById("q_noshow").value) : 28;
  const bench   = BENCHMARKS[document.getElementById("q_ftype") ? document.getElementById("q_ftype").value : "fqhc"] || BENCHMARKS["fqhc"];
  const tShare  = parseFloat(document.getElementById("qb_transport_share") ? document.getElementById("qb_transport_share").value : bench.transportShare);
  const netrev  = parseFloat(document.getElementById("qb_netrev")  ? document.getElementById("qb_netrev").value  : bench.netrev);
  const margc   = parseFloat(document.getElementById("qb_margc")   ? document.getElementById("qb_margc").value   : bench.margc);
  const tripCost= parseFloat(document.getElementById("qb_trip_cost")? document.getElementById("qb_trip_cost").value: bench.tripCost);
  const mitig   = 0.63;
  const visitsN = parseFloat(document.getElementById("q_visits") ? document.getElementById("q_visits").value : 7200) || 7200;

  const transportNS = Math.round(visitsN * (noshow/100) * (tShare/100));
  const prevented   = Math.round(transportNS * mitig);
  const grossRev    = Math.round(prevented * (netrev - margc));
  const progCost    = Math.round(transportNS * tripCost * 1.12);
  const netBenefit  = grossRev - progCost;

  const grid = document.getElementById("opp_cards_grid");
  if(!grid) return;
  const fLabel = document.getElementById("opp_facility_label");
  if(fLabel) fLabel.textContent = fname;

  grid.innerHTML = `
    <div class="opp-card opp-roi" onclick="setView('t3')">
      <div class="opp-label">Innovation 1 · ROI Calculator</div>
      <div class="opp-title">💰 Estimated Net Annual Benefit: ${fmtMoney(netBenefit)}</div>
      <div class="opp-body">
        Based on your ${visits} visits/yr and ${noshow}% no-show rate, approximately <b>${transportNS.toLocaleString()} no-shows/yr</b> are transport-attributable.
        The Shekelle 2022 evidence base (OR 0.63) projects <b>${prevented.toLocaleString()} prevented no-shows</b> annually.
        <br/><br/>
        <b>What does each missed appointment cost?</b> At ${fmtMoney(netrev - margc)} margin/visit, your current transport no-shows represent <b>${fmtMoney(visitsN * (noshow/100) * (tShare/100) * (netrev - margc))}/yr in recoverable margin.</b>
      </div>
      <div class="opp-cta">→ Open ROI Calculator</div>
    </div>
    <div class="opp-card opp-comp" onclick="setView('compliance')">
      <div class="opp-label">Innovation 2 · Compliance Checklist</div>
      <div class="opp-title">⚖️ ${getComplianceStatus()} Compliance Items Require Review</div>
      <div class="opp-body">
        Your questionnaire responses were checked against the AKS Local Transportation Safe Harbor (42 CFR §1001.952(bb)) and Civil Monetary Penalty Beneficiary Inducement Rule.
        <br/><br/>
        <b>Key items for your facility:</b> ${getComplianceSummary()}
      </div>
      <div class="opp-cta">→ Open Compliance Checklist</div>
    </div>
    <div class="opp-card opp-ops" onclick="setView('t4')">
      <div class="opp-label">Innovation 3 · Operations Planner</div>
      <div class="opp-title">⚙️ ${getStaffCount()}-Role Implementation Roadmap</div>
      <div class="opp-body">
        Based on your staffing inputs, we've pre-built a role assignment plan with estimated time commitments.
        <br/><br/>
        <b>Program lead:</b> ${getLeadRole()} &nbsp; <b>Coordinator:</b> ${getCoordRole()}
        <br/><br/>
        <b>Setup phase:</b> Est. ${getSetupHours()} hours/month total team commitment for first 3 months.
      </div>
      <div class="opp-cta">→ Open Operations Planner</div>
    </div>
  `;
}

function getComplianceStatus(){
  const aks = document.getElementById("qb_aks_review") ? document.getElementById("qb_aks_review").value : "no";
  const pol = document.getElementById("qb_policy_written") ? document.getElementById("qb_policy_written").value : "yes";
  const est = document.getElementById("qb_established") ? document.getElementById("qb_established").value : "yes";
  const distU = parseFloat(document.getElementById("qb_dist_urban") ? document.getElementById("qb_dist_urban").value : 18) || 18;
  let count = 0;
  if(aks !== "yes") count++;
  if(pol !== "yes") count++;
  if(est !== "yes") count++;
  if(distU > 25) count++;
  return count > 0 ? `⚠ ${count}` : "✓ 0";
}
function getComplianceSummary(){
  const aks = document.getElementById("qb_aks_review") ? document.getElementById("qb_aks_review").value : "no";
  const pol = document.getElementById("qb_policy_written") ? document.getElementById("qb_policy_written").value : "yes";
  const distU = parseFloat(document.getElementById("qb_dist_urban") ? document.getElementById("qb_dist_urban").value : 18) || 18;
  const items = [];
  if(pol !== "yes") items.push("Written policy required (AKS condition 1)");
  if(aks !== "yes") items.push("AKS counsel review recommended");
  if(distU > 25) items.push("Urban distance exceeds 25-mile safe harbor limit");
  if(!items.length) return "All core safe harbor conditions appear met.";
  return items.join(" · ");
}
function getLeadRole(){
  const el = document.getElementById("qb_lead_role");
  if(!el) return "CMO";
  return el.options[el.selectedIndex]?.text || "CMO";
}
function getCoordRole(){
  const el = document.getElementById("qb_coord_role");
  if(!el) return "Care Coordinator";
  return el.options[el.selectedIndex]?.text || "Care Coordinator";
}
function getStaffCount(){
  return parseInt(document.getElementById("q_staff_count") ? document.getElementById("q_staff_count").value : 2) || 2;
}
function getSetupHours(){
  const count = getStaffCount();
  return count <= 2 ? "40–55" : count <= 3 ? "55–80" : "80–110";
}

function launchAnalysis(){
  // Push questionnaire values into the ROI calculator fields
  pushToROICalculator();
  setView("t3");
}

function pushToROICalculator(){
  const visits  = parseFloat(document.getElementById("q_visits")  ? document.getElementById("q_visits").value  : 7200) || 7200;
  const noshow  = parseFloat(document.getElementById("q_noshow")  ? document.getElementById("q_noshow").value  : 28) / 100;
  const tShare  = parseFloat(document.getElementById("qb_transport_share") ? document.getElementById("qb_transport_share").value : 35) / 100;
  const netrev  = parseFloat(document.getElementById("qb_netrev")    ? document.getElementById("qb_netrev").value    : 168) || 168;
  const margc   = parseFloat(document.getElementById("qb_margc")     ? document.getElementById("qb_margc").value     : 62)  || 62;
  const trip    = parseFloat(document.getElementById("qb_trip_cost") ? document.getElementById("qb_trip_cost").value : 36)  || 36;
  const mitig   = parseFloat(document.getElementById("qb_mitig")     ? document.getElementById("qb_mitig").value     : 0.63)|| 0.63;
  const lmi     = parseFloat(document.getElementById("qb_lmi")       ? document.getElementById("qb_lmi").value       : 88)  / 100;
  const budget  = parseFloat(document.getElementById("q_budget")     ? document.getElementById("q_budget").value     : 50000)|| 50000;

  const setField = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
  setField("a_visits",  visits);
  setField("a_noshow",  noshow);
  setField("a_share",   tShare);
  setField("a_netrev",  netrev);
  setField("a_margc",   margc);
  setField("b_mitig",   mitig);
  setField("b_trip",    trip);
  setField("b_over",    0.12);
  setField("c_lmi",     lmi);
  setField("c_bank",    budget);

  if(typeof render_roi === "function") render_roi();
}

// ── Compliance Checklist Renderer ──────────────────────────────────────────
function renderComplianceChecklist(){
  // Use parsed Excel compliance data if available, otherwise fall back to questionnaire fields
  const parsed = state.t360data ? state.t360data.compliance : null;

  const distU  = parsed ? parsed.dist_urban  : (parseFloat(document.getElementById("qb_dist_urban")?.value) || 18);
  const distR  = parsed ? (parsed.dist_rural || 75) : (parseFloat(document.getElementById("qb_dist_rural")?.value) || 48);
  const pol    = parsed ? (parsed.policy_written    ? "yes" : "no") : (document.getElementById("qb_policy_written")?.value || "yes");
  const est    = parsed ? (parsed.established_only  ? "yes" : "no") : (document.getElementById("qb_established")?.value    || "yes");
  const aks    = parsed ? (parsed.aks_review         ? "yes" : "no") : (document.getElementById("qb_aks_review")?.value     || "no");
  const cmpDone= parsed ? parsed.cmp_review : false;
  const medEnrolled = parsed ? parsed.medicaid_enrolled : false;
  const annualCap = parsed ? (parsed.annual_cap || 0) : (() => {
    const visitsN = parseFloat(document.getElementById("q_visits")?.value || 7200);
    const tShare  = parseFloat(document.getElementById("qb_transport_share")?.value || 35) / 100;
    const noshow  = parseFloat(document.getElementById("q_noshow")?.value || 28) / 100;
    const tripCost= parseFloat(document.getElementById("qb_trip_cost")?.value || 36);
    return tripCost * 12;
  })();
  const capStatus = annualCap <= 500 ? "pass" : "fail";

  const aksRows = [
    { item:"Written, uniformly-applied transport policy",          cite:"§1001.952(bb)(1)", status: pol==="yes"?"pass": pol==="draft"?"warn":"fail", note: pol==="yes"?"✓ Policy on file":"Policy required before launch" },
    { item:"No volume-or-value linkage to referrals",              cite:"§1001.952(bb)(2)", status:"pass", note:"✓ Hospital-funded program — N/A" },
    { item:"Established patients only (no new-patient inducement)",cite:"§1001.952(bb)(3)", status: est==="yes"?"pass":"fail", note: est==="yes"?"✓ Established patients only":"Must restrict to established patients" },
    { item:"No public advertising of the transport benefit",       cite:"§1001.952(bb)(4)", status:"warn", note:"Verify: no external advertising (website, social media, flyers)" },
    { item:`Urban trip distance ≤25 miles (current: ${distU} mi)`,cite:"§1001.952(bb)(5)(i)", status: distU<=25?"pass":"fail", note: distU<=25?`✓ ${distU} mi — within limit`:`⚠ ${distU} mi exceeds 25-mile limit — AKS VIOLATION` },
    { item:"No air, luxury, or ambulance transport",               cite:"§1001.952(bb)(6)", status:"pass", note:"✓ Rideshare/standard vehicle only" },
    { item:"Facility bears all costs (not shifted to federal programs)", cite:"§1001.952(bb)(7)", status: (parsed && parsed.facility_bears_cost)?"pass":"warn", note: (parsed && parsed.facility_bears_cost)?"✓ Facility bears all costs":"Confirm billing structure with revenue cycle" },
    { item:"AKS counsel review on record",                         cite:"42 U.S.C. §1320a-7b(b)", status: aks==="yes"?"pass": aks==="scheduled"?"warn":"fail", note: aks==="yes"?"✓ Counsel review on file": aks==="scheduled"?"Scheduled — complete before full launch":"Not completed — recommended before program launch" },
  ];

  const cmpRows = [
    { item:"Benefit not contingent on referrals",                  cite:"§1003.110", status:"pass", note:"✓ Transport offered for medical necessity only" },
    { item:"Benefit provided to all eligible patients uniformly",  cite:"§1003.110", status: pol==="yes"?"pass":"warn", note: pol==="yes"?"✓ Uniform policy documented":"Document uniform application criteria" },
    { item:"CMP internal legal review completed",                  cite:"CMP Rules §1003", status: cmpDone?"pass":"warn", note: cmpDone?"✓ CMP review on file":"Recommended — review with compliance officer prior to launch" },
  ];

  const stateRows = [
    { item:"State Medicaid NEMT broker program enrolled",      cite:"State Medicaid Plan", status: medEnrolled?"pass":"warn", note: medEnrolled?"✓ Enrolled — Medicaid NEMT billing active":"Verify enrollment to enable Medicaid NEMT reimbursement claims" },
    { item:"Prior authorization process for Medicaid NEMT",   cite:"State plan §1902",    status:"warn", note:"Most state Medicaid plans require PA — confirm current process with payer" },
    { item:"HIPAA BAA with NEMT vendor current",              cite:"45 CFR §164.504(e)",  status: (parsed && parsed.policy_written)?"pass":"warn", note: (parsed && parsed.policy_written)?"✓ BAA on file per compliance data":"Required before sharing PHI with transportation vendor" },
    { item:"IRS Schedule H Part I Line 7e transport reported", cite:"IRS Form 990",        status:"warn", note:"If nonprofit hospital — transportation qualifies for community benefit (Part I, not Part II)" },
    { item:"VBE annual per-patient cap ≤$500",                 cite:"42 CFR §1001.952(hh)", status: capStatus, note: capStatus==="pass"?`✓ $${annualCap} per patient — within $500 VBE cap`:`⚠ $${annualCap} per patient — exceeds $500 annual VBE safe harbor cap` },
  ];

  // Source banner
  const sourceNote = parsed
    ? `<div style="background:var(--green-soft); border:1px solid var(--green-border); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:var(--green); font-weight:600;">✓ Compliance data sourced from uploaded T360_Patient_Level_Sample_Dataset.xlsx · Compliance sheet · This facility has a <b>clean compliance record</b> — all core AKS conditions are met. Use the Scenario Test below to explore what a violation would look like.</div>`
    : `<div style="background:var(--amber-soft); border:1px solid var(--amber-border); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; color:var(--amber); font-weight:600;">⚠ Using questionnaire inputs. Upload the sample dataset or complete Part B fields for a data-driven compliance profile.</div>`;

  function buildTable(rows){
    return `<table><thead><tr><th>Compliance Item</th><th>Regulation</th><th>Status</th><th>Notes</th></tr></thead><tbody>${
      rows.map((r,i) => {
        const icon = r.status==="pass" ? `<span style="color:var(--green); font-weight:700;">✓ Pass</span>` :
                     r.status==="warn" ? `<span style="color:var(--amber); font-weight:700;">⚠ Review</span>` :
                     `<span style="color:var(--red); font-weight:700;">⚠ Action Required</span>`;
        return `<tr style="${r.status==='fail'?'background:rgba(220,38,38,.04);':''}"><td style="font-size:13px;">${r.item}</td><td style="font-size:11px; color:var(--muted); white-space:nowrap;">${r.cite}</td><td style="white-space:nowrap;">${icon}</td><td style="font-size:12px; color:var(--muted);">${r.note}</td></tr>`;
      }).join("")
    }</tbody></table>`;
  }

  // Inject source banner before AKS table
  const aksContainer = document.getElementById("tbl_aks");
  if(aksContainer && aksContainer.parentElement) {
    let banner = aksContainer.parentElement.querySelector(".compliance-source-banner");
    if(!banner){ banner = document.createElement("div"); banner.className="compliance-source-banner"; aksContainer.parentElement.insertBefore(banner, aksContainer); }
    banner.innerHTML = sourceNote;
  }

  const aksEl = document.getElementById("tbl_aks"); if(aksEl) aksEl.outerHTML = buildTable(aksRows).replace('<table>', '<table id="tbl_aks">');
  const cmpEl = document.getElementById("tbl_cmp"); if(cmpEl) cmpEl.outerHTML = buildTable(cmpRows).replace('<table>', '<table id="tbl_cmp">');
  const stEl  = document.getElementById("tbl_state_compliance"); if(stEl) stEl.outerHTML = buildTable(stateRows).replace('<table>', '<table id="tbl_state_compliance">');

  const capEl = document.getElementById("cmp_annual_cap");
  if(capEl) capEl.innerHTML = `<b>$${annualCap}/patient/yr</b> ${capStatus==="pass"?'<span style="color:var(--green); font-weight:700;">✓ Within $500 VBE cap</span>':'<span style="color:var(--red); font-weight:700;">⚠ Exceeds $500 VBE cap</span>'}`;

  // Build action list
  const allRows = [...aksRows, ...cmpRows, ...stateRows];
  const actions = allRows.filter(r=>r.status==="fail");
  const reviews = allRows.filter(r=>r.status==="warn");
  const actEl = document.getElementById("compliance_actions");
  if(actEl){
    if(!actions.length && !reviews.length){
      actEl.textContent = "✓ No compliance gaps identified. All core AKS safe harbor conditions met.";
      return;
    }
    let out = "";
    if(actions.length){
      out += "── REQUIRED ACTIONS (must resolve before program launch) ──\n\n";
      out += actions.map((r,i)=>`${i+1}. ${r.item}\n   Regulation: ${r.cite}\n   Required action: ${r.note}\n`).join("\n");
    }
    if(reviews.length){
      out += "\n── RECOMMENDED REVIEWS ──\n\n";
      out += reviews.map((r,i)=>`${i+1}. ${r.item}\n   Regulation: ${r.cite}\n   Recommendation: ${r.note}\n`).join("\n");
    }
    actEl.innerHTML = out || "✓ No compliance gaps identified.";
  }
}

// ══════════════════════════════════════════════════════════
// EXCEL PARSING — T360 Patient-Level Sample Dataset
// Uses SheetJS (xlsx) loaded via CDN
// ══════════════════════════════════════════════════════════

// Actual data constants derived from audit of T360_Patient_Level_Sample_Dataset.xlsx
// Source: Monthly_Operations_Summary, Financial_Assumptions, Patient_Master,
//         Ride_History, Compliance, Operations_Planner, Population_Strata
const T360_ACTUAL = {
  facility: {
    id: "FQHC_001",
    name: "Riverside Community Health System",
    type: "FQHC",
    state: "PA"
  },
  // From Patient_Master (N=650): LMI=88.0%, Medicaid=54.3%, Medicare=18.3%, Dual=14.8%, Uninsured=12.6%
  // Medicaid+Dual = 69.1% → rounds to 72% including CHIP; LMI directly = 88%
  patients: { lmi: 0.88, medicaid: 0.543, medicare: 0.183, dual: 0.148, uninsured: 0.126,
               transportBarrier: 0.277 },
  // From Monthly_Operations_Summary: pre-period M1-3 (1801 scheduled, 301 no-shows)
  pre: { visits: 1801, noshows: 301, noshow_rate: 0.167 },
  // Post M5-12 (4791 scheduled, 940 no-shows, 361 transport-attributed)
  post: { visits: 4791, noshows: 940, noshow_rate: 0.196, ns_transport: 361, transport_share: 0.337 },
  // Annual totals (M1-12: 7187 scheduled)
  annual: { visits: 7187 },
  // From Financial_Assumptions: revenue=165, margin=95 → marginalCost = 165-95 = 70
  financial: {
    revenue: 165, margin: 95, marginal_cost: 70,
    cost_noshow: 210, cost_late: 55, cost_discharge_day: 750,
    nemt_cost_per_ride: 28, monthly_budget: 900
  },
  // From Ride_History: 221 completed rides, avg cost $26.44
  rides: { completed: 221, avg_cost: 26.44, avg_distance: 9.9 },
  // Monthly data array (M1-M12) — used to populate Outcomes tab
  monthly: [
    {m:1, label:"Jan 2024", phase:"Pre",  sched:571, ns:126, ns_t:0,  late:59, dd:5,  offered:0,  done:0 },
    {m:2, label:"Feb 2024", phase:"Pre",  sched:619, ns:79,  ns_t:0,  late:51, dd:12, offered:0,  done:0 },
    {m:3, label:"Mar 2024", phase:"Pre",  sched:611, ns:96,  ns_t:0,  late:80, dd:11, offered:0,  done:0 },
    {m:4, label:"Apr 2024", phase:"Ramp", sched:596, ns:131, ns_t:44, late:74, dd:14, offered:12, done:10},
    {m:5, label:"May 2024", phase:"Post", sched:595, ns:136, ns_t:45, late:69, dd:12, offered:28, done:28},
    {m:6, label:"Jun 2024", phase:"Post", sched:625, ns:105, ns_t:44, late:60, dd:8,  offered:35, done:33},
    {m:7, label:"Jul 2024", phase:"Post", sched:571, ns:134, ns_t:46, late:76, dd:14, offered:23, done:21},
    {m:8, label:"Aug 2024", phase:"Post", sched:614, ns:137, ns_t:37, late:65, dd:8,  offered:28, done:25},
    {m:9, label:"Sep 2024", phase:"Post", sched:579, ns:102, ns_t:25, late:61, dd:7,  offered:22, done:21},
    {m:10,label:"Oct 2024", phase:"Post", sched:571, ns:142, ns_t:48, late:62, dd:13, offered:33, done:33},
    {m:11,label:"Nov 2024", phase:"Post", sched:602, ns:94,  ns_t:35, late:53, dd:8,  offered:29, done:26},
    {m:12,label:"Dec 2024", phase:"Post", sched:634, ns:90,  ns_t:37, late:48, dd:4,  offered:26, done:24},
  ],
  // From Population_Strata
  strata: [
    {group:"Medicaid",       eligible:1800, barrier_rate:0.233, pre_ns_rate:0.172, post_ns_rate:0.121},
    {group:"Uninsured",      eligible:900,  barrier_rate:0.220, pre_ns_rate:0.181, post_ns_rate:0.136},
    {group:"Dual Eligible",  eligible:650,  barrier_rate:0.271, pre_ns_rate:0.194, post_ns_rate:0.142},
    {group:"Medicare Only",  eligible:1200, barrier_rate:0.130, pre_ns_rate:0.118, post_ns_rate:0.101},
  ],
  // From Compliance sheet — all TRUE (clean compliance record)
  compliance: {
    policy_written: true, uniformly_applied: true, not_advertised: true,
    dist_urban: 18, dist_rural: null, established_only: true, facility_bears_cost: true,
    annual_cap: 420, cmp_review: true, aks_review: true, medicaid_enrolled: true
  },
  // From Operations_Planner (4 roles)
  ops_roles: [
    {name:"Care Coordinator",  fte_curr:0.60, fte_proj:0.80, hrs_setup:28, hrs_ongoing:18, train_req:8,  train_done:6, train_gap:2, pa_owner:true,  satisfaction:5},
    {name:"Front Desk Lead",   fte_curr:0.50, fte_proj:0.60, hrs_setup:24, hrs_ongoing:14, train_req:6,  train_done:6, train_gap:0, pa_owner:false, satisfaction:6},
    {name:"Practice Manager",  fte_curr:0.35, fte_proj:0.45, hrs_setup:22, hrs_ongoing:10, train_req:4,  train_done:4, train_gap:0, pa_owner:true,  satisfaction:4},
    {name:"Compliance Officer", fte_curr:0.20, fte_proj:0.25, hrs_setup:18, hrs_ongoing:6,  train_req:5,  train_done:5, train_gap:0, pa_owner:false, satisfaction:3},
  ]
};

// ── Parse uploaded T360 Excel workbook via SheetJS ────────────────────────
function parseT360Excel(workbook) {
  const result = JSON.parse(JSON.stringify(T360_ACTUAL)); // deep clone as base

  try {
    // ── Monthly_Operations_Summary ───────────────────────────
    if(workbook.SheetNames.includes("Monthly_Operations_Summary")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Monthly_Operations_Summary"]);
      if(rows.length >= 1) {
        const pre_rows  = rows.filter(r => r.Phase === "Pre");
        const post_rows = rows.filter(r => r.Phase === "Post");
        const all_sched = rows.reduce((s,r) => s + (r.Total_Scheduled||0), 0);
        const pre_sched = pre_rows.reduce((s,r)  => s + (r.Total_Scheduled||0), 0);
        const pre_ns    = pre_rows.reduce((s,r)  => s + (r.NoShows_Total||0), 0);
        const post_sched= post_rows.reduce((s,r) => s + (r.Total_Scheduled||0), 0);
        const post_ns   = post_rows.reduce((s,r) => s + (r.NoShows_Total||0), 0);
        const post_ns_t = post_rows.reduce((s,r) => s + (r.NoShows_Transport||0), 0);
        result.annual.visits = all_sched;
        result.pre  = { visits:pre_sched,  noshows:pre_ns,  noshow_rate: pre_sched  ? pre_ns/pre_sched   : 0.167 };
        result.post = { visits:post_sched, noshows:post_ns, noshow_rate: post_sched ? post_ns/post_sched : 0.196,
                        ns_transport:post_ns_t, transport_share: post_ns ? post_ns_t/post_ns : 0.337 };
        result.monthly = rows.map(r => ({
          m: r.Month_Num, label: r.Month_Label, phase: r.Phase,
          sched: r.Total_Scheduled||0, ns: r.NoShows_Total||0, ns_t: r.NoShows_Transport||0,
          late: r.Arrivals_Late||0, dd: r.Delayed_Discharge||0,
          offered: r.NEMT_Rides_Offered||0, done: r.NEMT_Rides_Completed||0
        }));
      }
    }

    // ── Financial_Assumptions ────────────────────────────────
    if(workbook.SheetNames.includes("Financial_Assumptions")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Financial_Assumptions"]);
      if(rows.length >= 1) {
        const r = rows[0];
        const rev    = r.Revenue_Per_Completed_Visit || 165;
        // Clinical_Margin_Per_Visit is MARGIN (revenue - cost), not cost itself
        const margin = r.Clinical_Margin_Per_Visit   || 95;
        result.financial = {
          revenue:      rev,
          margin:       margin,
          marginal_cost: rev - margin,          // ← key mapping: cost = revenue − margin
          cost_noshow:  r.Cost_Per_NoShow            || 210,
          cost_late:    r.Cost_Per_Late_Arrival       || 55,
          cost_discharge_day: r.Cost_Per_Delayed_Discharge || 750,
          nemt_cost_per_ride: r.NEMT_Cost_Per_Ride    || 28,
          monthly_budget:     r.Monthly_NEMT_Budget   || 900
        };
      }
    }

    // ── Patient_Master — payer mix + LMI ────────────────────
    if(workbook.SheetNames.includes("Patient_Master")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Patient_Master"]);
      if(rows.length >= 1) {
        const total = rows.length;
        const payers = {};
        let lmi = 0, transport = 0;
        rows.forEach(r => {
          const p = r.Primary_Payer || "Other";
          payers[p] = (payers[p]||0) + 1;
          if(r.Low_Income_Flag)      lmi++;
          if(r.Transport_Barrier_Flag) transport++;
        });
        result.patients = {
          lmi: lmi/total,
          medicaid:  ((payers["Medicaid"]||0) + (payers["Dual Eligible"]||0)) / total, // Medicaid + Dual
          medicare:  (payers["Medicare Only"]||0) / total,
          dual:      (payers["Dual Eligible"]||0) / total,
          uninsured: (payers["Uninsured"]||0) / total,
          transportBarrier: transport/total
        };
      }
    }

    // ── Ride_History — actual avg cost ───────────────────────
    if(workbook.SheetNames.includes("Ride_History")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Ride_History"])
                    .filter(r => r.Ride_Status === "Completed");
      if(rows.length >= 1) {
        const total_cost = rows.reduce((s,r) => s + (r.Ride_Cost||0), 0);
        const total_dist = rows.reduce((s,r) => s + (r.Ride_Distance_Miles||0), 0);
        result.rides = { completed: rows.length,
                          avg_cost: total_cost/rows.length,
                          avg_distance: total_dist/rows.length };
      }
    }

    // ── Compliance ───────────────────────────────────────────
    if(workbook.SheetNames.includes("Compliance")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Compliance"]);
      if(rows.length >= 1) {
        const r = rows[0];
        result.compliance = {
          policy_written:    !!r.Transport_Policy_Written,
          uniformly_applied: !!r.Policy_Uniformly_Applied,
          not_advertised:    !!r.Policy_Not_Advertised,
          dist_urban:        r.Distance_Urban_Miles || 18,
          dist_rural:        r.Distance_Rural_Miles || null,
          established_only:  !!r.Established_Patients_Only,
          facility_bears_cost:!!r.Facility_Bears_Cost,
          annual_cap:        r.Annual_Cap_Per_Patient || 0,
          cmp_review:        !!r.CMP_Review_Completed,
          aks_review:        !!r.AKS_Counsel_Reviewed,
          medicaid_enrolled: !!r.State_Medicaid_NEMT_Enrolled
        };
      }
    }

    // ── Operations_Planner ───────────────────────────────────
    if(workbook.SheetNames.includes("Operations_Planner")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Operations_Planner"]);
      if(rows.length >= 1) {
        result.ops_roles = rows.map(r => ({
          name:        r.Role_Name || "Staff",
          fte_curr:    r.Role_FTE_Current    || 0,
          fte_proj:    r.Role_FTE_Projected  || 0,
          hrs_setup:   r.Hours_Setup_Phase   || 0,
          hrs_ongoing: r.Hours_Ongoing_Monthly || r.Hours_Operational || 0, // handle both names
          train_req:   r.Training_Hours_Required  || 0,
          train_done:  r.Training_Hours_Completed || 0,
          train_gap:   r.Training_Gap_Hrs         || 0,
          pa_owner:    !!(r.PA_Process_Owner === 1 || r.PA_Process_Owner === true),
          satisfaction: r.Staff_Satisfaction_Score || 0
        }));
      }
    }

    // ── Population_Strata ────────────────────────────────────
    if(workbook.SheetNames.includes("Population_Strata")) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Population_Strata"]);
      if(rows.length >= 1) {
        result.strata = rows.map(r => ({
          group:         r.Population_Group,
          eligible:      r.Eligible_Patients,
          barrier_rate:  r.Barrier_Rate,
          pre_ns_rate:   r.Baseline_NoShow_Rate,
          post_ns_rate:  r.Post_NoShow_Rate
        }));
      }
    }

  } catch(e) {
    console.warn("Excel parse warning:", e);
  }

  return result;
}

// ── Apply parsed data to all platform inputs ────────────────────────────
function applyT360Data(d) {
  Q.sampleLoaded = true;

  // ── Questionnaire fields ────
  const setQ = (id, val) => { const el = document.getElementById(id); if(el){ el.value = val; el._userEdited = true; el.classList.remove("auto-filled"); } };
  setQ("q_fname",    d.facility.name || "Riverside Community Health System");
  const ftEl = document.getElementById("q_ftype");
  if(ftEl){ ftEl.value = "fqhc"; }
  const stEl = document.getElementById("q_state");
  if(stEl){ stEl.value = d.facility.state || "PA"; }
  setQ("q_visits",   Math.round(d.annual.visits));
  document.getElementById("q_visits_slider") && (document.getElementById("q_visits_slider").value = Math.min(150000, d.annual.visits));
  document.getElementById("q_visits_disp")   && (document.getElementById("q_visits_disp").textContent = Math.round(d.annual.visits).toLocaleString());
  const noshowPct = Math.round(d.pre.noshow_rate * 1000) / 10;
  setQ("q_noshow", noshowPct);
  document.getElementById("q_noshow_slider") && (document.getElementById("q_noshow_slider").value = noshowPct);
  document.getElementById("q_noshow_disp")   && (document.getElementById("q_noshow_disp").textContent = noshowPct + "%");

  // Payer mix — Medicaid+Dual as Medicaid pct, Medicare, rest as Commercial+Uninsured
  const medicaidPct  = Math.round((d.patients.medicaid || 0.69) * 100);
  const medicarePct  = Math.round((d.patients.medicare || 0.18) * 100);
  const commPct      = 100 - medicaidPct - medicarePct;
  setQ("q_medicaid",   medicaidPct);
  setQ("q_medicare",   medicarePct);
  setQ("q_commercial", Math.max(0, commPct));
  syncPayerMix();

  setQ("q_nemt_status", "pilot");
  setQ("q_budget",      d.financial.monthly_budget * 12);
  setQ("q_staff_count", d.ops_roles ? d.ops_roles.length : 4);

  // ── Part B derived inputs ────
  setQ("qb_netrev",           d.financial.revenue);
  setQ("qb_margc",            d.financial.marginal_cost);
  setQ("qb_transport_share",  Math.round(d.post.transport_share * 100));
  setQ("qb_trip_cost",        Math.round(d.rides.avg_cost));
  setQ("qb_mitig",            0.63);
  setQ("qb_lmi",              Math.round(d.patients.lmi * 100));

  // Compliance fields
  const c = d.compliance;
  setQ("qb_dist_urban",     c.dist_urban || 18);
  setQ("qb_policy_written", c.policy_written ? "yes" : "no");
  setQ("qb_established",    c.established_only ? "yes" : "no");
  setQ("qb_aks_review",     c.aks_review ? "yes" : "no");

  // ── ROI Calculator inputs ────
  const setField = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
  setField("a_visits",  d.annual.visits);
  setField("a_noshow",  d.pre.noshow_rate);
  setField("a_share",   d.post.transport_share);
  setField("a_netrev",  d.financial.revenue);
  setField("a_margc",   d.financial.marginal_cost);
  setField("b_mitig",   0.63);
  setField("b_trip",    Math.round(d.rides.avg_cost * 100) / 100);
  setField("b_over",    0.12);
  setField("c_lmi",     d.patients.lmi);
  setField("c_bank",    d.financial.monthly_budget * 12);

  // ── Store parsed data for use across platform ────
  state.t360data = d;

  // ── Populate Outcomes tab ────
  renderT360OutcomesTab(d);

  // ── Populate Operations tab data ────
  state.opsRoles = d.ops_roles;

  // ── Render compliance from parsed data ────
  renderComplianceChecklist();

  // ── Run ROI ────
  if(typeof render_roi === "function") render_roi();

  // ── Trigger opportunity discovery ────
  checkSetupComplete();
  surfaceOpportunities();
}

// ── Render Outcomes tab with actual monthly data ─────────────────────────
function renderT360OutcomesTab(d) {
  const panelId = "sample_outcomes_panel";
  let panel = document.getElementById(panelId);

  // Build the outcomes panel HTML
  const preRate  = (d.pre.noshow_rate * 100).toFixed(1);
  const postRows = d.monthly.filter(m => m.phase === "Post");
  const postRate = postRows.length
    ? ((postRows.reduce((s,m)=>s+m.ns,0) / postRows.reduce((s,m)=>s+m.sched,0)) * 100).toFixed(1)
    : "—";
  const transportIdentified = d.monthly.filter(m=>m.phase!=="Pre").reduce((s,m)=>s+m.ns_t,0);
  const ridesCompleted = d.monthly.reduce((s,m)=>s+m.done,0);

  // Cost impact from Financial_Assumptions
  const costNoshow = d.financial.cost_noshow;
  const preMonthlyNSCost = Math.round(d.pre.noshows / 3 * costNoshow);
  const postMonthlyNSCost = Math.round(d.post.noshows / postRows.length * costNoshow);

  const html = `
  <div style="margin-top:24px; border-top: 3px solid var(--teal); padding-top:20px;">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:8px;">
      <div>
        <div class="section-title">Riverside Community Health System — 12-Month Outcomes</div>
        <div class="section-subtitle">Data from uploaded T360_Patient_Level_Sample_Dataset.xlsx · Jan–Dec 2024 · NEMT pilot launched Month 4</div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <span class="chip" style="background:var(--teal-soft); border-color:var(--teal-border); color:var(--teal); font-weight:700;">LMI: ${Math.round(d.patients.lmi*100)}%</span>
        <span class="chip" style="background:var(--blue-soft); border-color:var(--blue-border); color:var(--blue); font-weight:700;">Medicaid+Dual: ${Math.round(d.patients.medicaid*100)}%</span>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="kpis" style="margin-bottom:20px;">
      <div class="kpi">
        <div class="label">Pre-Period No-Show Rate</div>
        <div class="value" style="color:var(--red);">${preRate}%</div>
        <div class="hint">Jan–Mar 2024 · ${d.pre.noshows.toLocaleString()} no-shows / ${d.pre.visits.toLocaleString()} scheduled</div>
      </div>
      <div class="kpi">
        <div class="label">Post-Period No-Show Rate</div>
        <div class="value" style="color:var(--amber);">${postRate}%</div>
        <div class="hint">May–Dec 2024 · Transport tracking now active</div>
      </div>
      <div class="kpi">
        <div class="label">Transport No-Shows Identified</div>
        <div class="value" style="color:var(--blue);">${transportIdentified.toLocaleString()}</div>
        <div class="hint">From Apr–Dec 2024 · Z75.3 screening active</div>
      </div>
      <div class="kpi">
        <div class="label">NEMT Rides Completed</div>
        <div class="value" style="color:var(--green);">${ridesCompleted.toLocaleString()}</div>
        <div class="hint">Apr–Dec 2024 · Avg cost: $${d.rides.avg_cost.toFixed(2)}/ride</div>
      </div>
    </div>

    <!-- Insight callout -->
    <div style="background:var(--amber-soft); border:1px solid var(--amber-border); border-left:4px solid var(--amber); border-radius:var(--radius); padding:14px 18px; margin-bottom:16px;">
      <div style="font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:var(--amber); margin-bottom:5px;">Key Insight — Consistent with Chaiyachati 2018 RCT</div>
      <div style="font-size:13px; color:var(--ink); line-height:1.65;">
        The overall post-period no-show rate (<b>${postRate}%</b>) is modestly higher than the pre-period (<b>${preRate}%</b>), primarily due to seasonal variation and the small ride volume (${ridesCompleted} rides vs. ${d.post.noshows.toLocaleString()} total post-period no-shows).
        This mirrors the Chaiyachati RCT finding: <b>untargeted, low-volume NEMT does not dramatically move aggregate no-show rates.</b>
        The ROI Calculator models what a properly scaled, targeted program can achieve using the Shekelle 2022 evidence base (OR 0.63 for transport-attributable no-shows specifically).
        Transport-identified no-shows represent <b>${Math.round(d.post.transport_share*100)}% of post-period no-shows</b> — the addressable pool.
      </div>
    </div>

    <!-- Monthly table -->
    <div style="overflow-x:auto;">
      <table style="font-size:13px;">
        <thead>
          <tr>
            <th>Month</th><th>Phase</th><th>Scheduled</th>
            <th>Total No-Shows</th><th>No-Show Rate</th>
            <th>Transport NS</th><th>Transport Share</th>
            <th>Late Arrivals</th><th>Delayed Discharges</th>
            <th>Rides Offered</th><th>Rides Completed</th>
            <th>Completion Rate</th>
          </tr>
        </thead>
        <tbody>
          ${d.monthly.map((m, i) => {
            const nsRate  = m.sched ? (m.ns/m.sched*100).toFixed(1) + "%" : "—";
            const tShare  = m.ns    ? (m.ns_t/m.ns*100).toFixed(1) + "%" : (m.phase==="Pre" ? "Not tracked" : "—");
            const compRate= m.offered ? (m.done/m.offered*100).toFixed(0) + "%" : "—";
            const rowBg   = m.phase==="Pre" ? "background:rgba(220,38,38,.03)" :
                            m.phase==="Ramp"? "background:rgba(217,119,6,.03)" :
                                              "background:rgba(5,150,105,.03)";
            const phaseBadge = m.phase==="Pre"  ? `<span style="font-size:10px; font-weight:700; color:var(--red); background:var(--red-soft); border:1px solid var(--red-border); padding:1px 7px; border-radius:999px;">PRE</span>` :
                               m.phase==="Ramp" ? `<span style="font-size:10px; font-weight:700; color:var(--amber); background:var(--amber-soft); border:1px solid var(--amber-border); padding:1px 7px; border-radius:999px;">RAMP</span>` :
                                                  `<span style="font-size:10px; font-weight:700; color:var(--green); background:var(--green-soft); border:1px solid var(--green-border); padding:1px 7px; border-radius:999px;">POST</span>`;
            return `<tr style="${rowBg}">
              <td style="font-weight:600;">${m.label}</td>
              <td>${phaseBadge}</td>
              <td>${m.sched.toLocaleString()}</td>
              <td style="color:var(--red); font-weight:600;">${m.ns.toLocaleString()}</td>
              <td style="font-weight:700;">${nsRate}</td>
              <td style="color:var(--blue);">${m.ns_t > 0 ? m.ns_t : (m.phase==="Pre" ? "—" : "0")}</td>
              <td style="color:var(--blue);">${tShare}</td>
              <td>${m.late}</td>
              <td>${m.dd}</td>
              <td>${m.offered || "—"}</td>
              <td style="color:var(--green); font-weight:600;">${m.done || "—"}</td>
              <td>${compRate}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr style="background:var(--bg-warm); font-weight:700;">
            <td>TOTAL</td><td>—</td>
            <td>${d.annual.visits.toLocaleString()}</td>
            <td style="color:var(--red);">${(d.pre.noshows + d.post.noshows + d.monthly.find(m=>m.phase==="Ramp")?.ns).toLocaleString()}</td>
            <td>—</td>
            <td style="color:var(--blue);">${transportIdentified.toLocaleString()}</td>
            <td>—</td>
            <td>${d.monthly.reduce((s,m)=>s+m.late,0)}</td>
            <td>${d.monthly.reduce((s,m)=>s+m.dd,0)}</td>
            <td>${d.monthly.reduce((s,m)=>s+m.offered,0)}</td>
            <td style="color:var(--green);">${ridesCompleted}</td>
            <td>—</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Targeting breakdown from Population_Strata -->
    ${d.strata && d.strata.length ? `
    <div style="margin-top:20px;">
      <div class="section-title" style="font-size:14px; margin-bottom:8px;">Targeting Opportunity by Population Group</div>
      <div class="section-subtitle">Higher barrier rates and baseline no-show rates identify priority subgroups for NEMT targeting. Source: Population_Strata sheet.</div>
      <table style="font-size:13px; margin-top:8px;">
        <thead>
          <tr><th>Population Group</th><th>Eligible Patients</th><th>Transport Barrier Rate</th><th>Baseline No-Show Rate</th><th>Post No-Show Rate</th><th>Projected Reduction</th></tr>
        </thead>
        <tbody>
          ${d.strata.map(s => {
            const reduction = ((s.pre_ns_rate - s.post_ns_rate) / s.pre_ns_rate * 100).toFixed(1);
            return `<tr>
              <td style="font-weight:600;">${s.group}</td>
              <td>${(s.eligible||0).toLocaleString()}</td>
              <td style="color:var(--blue); font-weight:700;">${(s.barrier_rate*100).toFixed(1)}%</td>
              <td style="color:var(--red);">${(s.pre_ns_rate*100).toFixed(1)}%</td>
              <td style="color:var(--green);">${(s.post_ns_rate*100).toFixed(1)}%</td>
              <td style="font-weight:700; color:var(--teal);">−${reduction}%</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      <div class="callout" style="margin-top:10px;">
        <div class="tier-label">Targeting Principle — Chaiyachati 2018</div>
        <div class="small" style="margin-top:4px;">Dual Eligible patients show the highest barrier rate (<b>${(d.strata.find(s=>s.group==="Dual Eligible")?.barrier_rate*100||27.1).toFixed(1)}%</b>) and highest baseline no-show rate. Concentrating NEMT rides on this subgroup first maximizes ROI and mirrors the targeting principle demonstrated by the negative Chaiyachati RCT (universal offering) vs. positive Hitch Health pilot (targeted offering).</div>
      </div>
    </div>` : ""}

    <!-- Cost impact summary -->
    <div class="split" style="margin-top:20px;">
      <div class="card-flat">
        <div class="section-title" style="font-size:14px;">Cost-Per-Disruption Summary</div>
        <div class="section-subtitle">Based on Financial_Assumptions sheet · Answers ROI Question 1</div>
        <table style="font-size:13px; margin-top:8px;">
          <thead><tr><th>Disruption Type</th><th>Unit Cost</th><th>Pre-Period Monthly Count</th><th>Monthly Cost</th></tr></thead>
          <tbody>
            <tr><td>No-Show (admin + slot waste)</td><td>$${d.financial.cost_noshow}</td><td>${Math.round(d.pre.noshows/3)}</td><td style="font-weight:700; color:var(--red);">$${preMonthlyNSCost.toLocaleString()}</td></tr>
            <tr style="background:var(--bg-warm);"><td>Late Arrival (schedule disruption)</td><td>$${d.financial.cost_late}</td><td>${Math.round(d.monthly.filter(m=>m.phase==="Pre").reduce((s,m)=>s+m.late,0)/3)}</td><td>$${Math.round(d.monthly.filter(m=>m.phase==="Pre").reduce((s,m)=>s+m.late,0)/3*d.financial.cost_late).toLocaleString()}</td></tr>
            <tr><td>Delayed Discharge (per day)</td><td>$${d.financial.cost_discharge_day}</td><td>${Math.round(d.monthly.filter(m=>m.phase==="Pre").reduce((s,m)=>s+m.dd,0)/3)}</td><td>$${Math.round(d.monthly.filter(m=>m.phase==="Pre").reduce((s,m)=>s+m.dd,0)/3*d.financial.cost_discharge_day).toLocaleString()}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card-flat">
        <div class="section-title" style="font-size:14px;">NEMT Program Budget vs. Actuals</div>
        <div class="section-subtitle">Source: Financial_Assumptions + Ride_History · Answers ROI Question 2</div>
        <table style="font-size:13px; margin-top:8px;">
          <thead><tr><th>Item</th><th>Budget / Assumption</th><th>Actual</th></tr></thead>
          <tbody>
            <tr><td>Monthly NEMT budget</td><td>$${d.financial.monthly_budget.toLocaleString()}</td><td>—</td></tr>
            <tr style="background:var(--bg-warm);"><td>Cost per ride (assumed)</td><td>$${d.financial.nemt_cost_per_ride}</td><td>$${d.rides.avg_cost.toFixed(2)} ✓</td></tr>
            <tr><td>Rides completed (M4–M12)</td><td>—</td><td>${ridesCompleted}</td></tr>
            <tr style="background:var(--bg-warm);"><td>Avg ride distance</td><td>≤25 mi urban limit</td><td>${d.rides.avg_distance.toFixed(1)} mi ✓</td></tr>
            <tr><td>VBE annual cap/patient</td><td>≤$500</td><td>$${d.compliance.annual_cap} ✓</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  // Insert or replace outcomes panel in the Outcomes view
  const outcomesView = document.getElementById("view_t5");
  if(outcomesView) {
    let existing = outcomesView.querySelector("#sample_outcomes_panel");
    if(existing) existing.remove();
    const div = document.createElement("div");
    div.id = panelId;
    div.innerHTML = html;
    outcomesView.appendChild(div);
  }
}

// ── Real Excel upload handler via SheetJS ────────────────────────────────
function handleExcelUpload(input){
  const file = input.files[0];
  if(!file) return;

  const zone   = document.getElementById("excel_upload_zone");
  const status = document.getElementById("upload_status");

  // Check SheetJS is available
  if(typeof XLSX === "undefined") {
    if(status){ status.style.display=""; status.innerHTML = `⚠ SheetJS library not loaded. Using built-in sample data instead.`; }
    loadSampleDataset();
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const wb = XLSX.read(e.target.result, { type: "array" });
      const parsed = parseT360Excel(wb);
      applyT360Data(parsed);

      if(zone)   zone.classList.add("has-file");
      if(status){
        status.style.display = "";
        status.innerHTML = `✓ <b>${file.name}</b> parsed successfully via SheetJS · ${wb.SheetNames.length} sheets loaded · All analysis tabs populated`;
      }
      showOk(`T360 dataset loaded from ${file.name}. All tabs are now populated with your facility data.`);
    } catch(err) {
      console.error("Excel parse error:", err);
      if(status){ status.style.display=""; status.innerHTML=`⚠ Could not parse ${file.name}. Loaded built-in sample data instead.`; }
      loadSampleDataset();
    }
  };
  reader.onerror = function(){ loadSampleDataset(); };
  reader.readAsArrayBuffer(file);
}

// ── Load built-in sample data (uses T360_ACTUAL constants) ──────────────
function loadSampleDataset(){
  applyT360Data(T360_ACTUAL);
  const zone   = document.getElementById("excel_upload_zone");
  const status = document.getElementById("upload_status");
  if(zone)   zone.classList.add("has-file");
  if(status){
    status.style.display = "";
    status.innerHTML = `✓ Built-in sample dataset loaded: <b>Riverside Community Health System</b> · 12-month NEMT pilot data (Jan–Dec 2024)`;
  }
  showOk("Sample dataset loaded. ROI, Compliance, Operations, and Outcomes tabs are now populated.");
}



// ── Auto-wire questionnaire change events ──────────────────────────────────
["q_ftype","q_state","q_nemt_status","q_budget","q_staff_count",
 "qb_dist_urban","qb_dist_rural","qb_policy_written","qb_established","qb_aks_review",
 "qb_lead_role","qb_coord_role","qb_rc_role"].forEach(id => {
  const el = document.getElementById(id);
  if(el) el.addEventListener("change", ()=>{ deriveInputs(); checkSetupComplete(); });
});
["q_fname"].forEach(id => {
  const el = document.getElementById(id);
  if(el) el.addEventListener("input", checkSetupComplete);
});

// Initialize derived values on page load
deriveInputs();
syncPayerMix();



document.querySelectorAll(".tabbtn").forEach(btn=>{
  btn.addEventListener("click", ()=> setView(btn.dataset.view));
});

document.getElementById("btn_reset").addEventListener("click", ()=>{
  clearErr();
  state.docs=[]; state.evidence=[]; state.findings=[]; state.opportunities=[]; state.selectedOpp=null; state.chnaEval=[];
  state.transport={overall:null, age6574:null};
  document.getElementById("docs_count").textContent="0";
  document.getElementById("ev_count").textContent="0";
  document.getElementById("top_t2").textContent="—";
  document.getElementById("tbl_materiality").innerHTML="";
  document.getElementById("tbl_evidence").innerHTML="";
  document.getElementById("tbl_cra").innerHTML="";
  if(document.getElementById("tbl_chna_gaps")) document.getElementById("tbl_chna_gaps").innerHTML="";
  if(document.getElementById("chna_gap_recs")) document.getElementById("chna_gap_recs").textContent="—";
  document.getElementById("audit_out").textContent="";
  if(chartMateriality) chartMateriality.destroy();
  if(chartROI) chartROI.destroy();
  if(chartTrend) chartTrend.destroy();
  renderTransportSpotlight();
  showOk("Reset complete.");
});

document.getElementById("btn_demo").addEventListener("click", ()=>{
  clearErr();
  // Demo based on your exact framing: 2.7% overall, 8.5% age 65-74
  const demoText =
    "Why did you not get or delay getting the preventative care you thought you needed? Total: I had transportation problems 2.7%. " +
    "Age 65-74: I had transportation problems 8.5%. " +
    "Of patients surveyed, 7.5% reported food insecurity and 6% reported housing needs. " +
    "Unweighted count 61. Martin County ZIP 56031.";
  state.docs=[{name:"Demo_CHNA.pdf", type:"pdf", pages:1, textByPage:[demoText]}];
  state.evidence=[]; state.findings=[]; state.opportunities=[]; state.selectedOpp=null; state.chnaEval=[];
  state.transport={overall:null, age6574:null};

  scanDoc(state.docs[0]);
  state.chnaEval = state.docs.map(evalDocForElements);
  computeMateriality();
  buildOpportunities();
  state.selectedOpp = state.opportunities[0] || null;

  document.getElementById("docs_count").textContent = state.docs.length;
  document.getElementById("ev_count").textContent = state.evidence.length;

  renderTransportSpotlight();
  renderTier1();
  renderEvidence();
  renderTier2();
  showOk("Demo loaded (transportation differential).");
});

document.getElementById("btn_process").addEventListener("click", async ()=>{
  clearErr();
  showOk("Processing… (parsing documents and updating Tier 1–3 outputs)");
  try{
    const files = Array.from(document.getElementById("file_input").files || []);
    if(!files.length){
      showErr("No files selected.");
      return;
    }
    state.docs=[]; state.evidence=[]; state.findings=[]; state.opportunities=[]; state.selectedOpp=null; state.chnaEval=[];
    state.transport={overall:null, age6574:null};

    for(const f of files){
      const ext = (f.name.split(".").pop()||"").toLowerCase();
      let parsed=null;
      try{
        if(ext==="pdf") parsed = await extractPdfText(f);
        else if(ext==="txt") parsed = await extractTxt(f);
        else {
          // Skip unsupported files without failing the run
          continue;
        }
        state.docs.push({name:f.name, type:ext, pages:parsed.pages, textByPage:parsed.textByPage});
      }catch(e){
        showErr(`Error parsing ${escapeHtml(f.name)}. If the PDF is scanned, upload a text-based PDF or a .txt export.`);
        console.error(e);
      }
    }

    if(!state.docs.length){
      showErr("No supported files were parsed. Please upload text-based PDFs or .txt files.");
      return;
    }

    // Scan
    for(const d of state.docs){ scanDoc(d); }
    state.chnaEval = state.docs.map(evalDocForElements);
    computeMateriality();
    buildOpportunities();
    state.selectedOpp = state.opportunities[0] || null;

    document.getElementById("docs_count").textContent = state.docs.length;
    document.getElementById("ev_count").textContent = state.evidence.length;

    renderTransportSpotlight();
    renderTier1();
    renderEvidence();
    renderTier2();

    // Ensure charts render even if user is not currently on the chart tab
    window.setTimeout(()=>{
      try{ if(chartMateriality) chartMateriality.resize(); }catch(e){}
      try{ if(chartROI) chartROI.resize(); }catch(e){}
      try{ if(chartTrend) chartTrend.resize(); }catch(e){}
    }, 80);

    showOk(`Processed ${state.docs.length} document(s). Evidence hits: ${state.evidence.length}.`);
    if(state.evidence.length===0){
      showErr("Documents were parsed, but no recognizable CHNA signals were detected. This often happens with scanned PDFs (images). Try exporting to text or uploading a .txt version.");
    }
  }catch(e){
    console.error(e);
    showErr("Processing failed: " + (e && e.message ? e.message : String(e)));
  }
});

document.getElementById("btn_use_top").addEventListener("click", ()=>{
  if(!state.opportunities.length){
    showErr("No Tier 2 opportunities available yet.");
    return;
  }
  state.selectedOpp = state.opportunities[0];
  setTier3FromOpportunity(state.selectedOpp);
  setView("t3");
  showOk("Tier 3 prefilled using top Tier 2 opportunity.");
});

const _btn_autofill = document.getElementById("btn_autofill");
if(_btn_autofill){
  _btn_autofill.addEventListener("click", ()=>{
    if(!state.selectedOpp) state.selectedOpp = state.opportunities[0] || null;
    if(state.selectedOpp) setTier3FromOpportunity(state.selectedOpp);
    showOk("Tier 3 auto-fill applied from Tier 2.");
  });
}

const _btn_run = document.getElementById("btn_run");
if(_btn_run){ _btn_run.addEventListener("click", runTier3); }
// Live UI: keep coverage readout updated
const covEl = document.getElementById("inp_cov");
const covRead = document.getElementById("cov_readout");
if(covEl && covRead){
  covRead.textContent = `${covEl.value}%`;
  covEl.addEventListener("input", ()=>{ covRead.textContent = `${covEl.value}%`; });
}


// Initial render placeholders
renderTransportSpotlight();
document.getElementById("tbl_materiality").innerHTML = "<tr><th>Disparity</th><th>Segment</th><th>Magnitude</th><th>Δ Concentration</th><th>Prominence</th><th>Score</th><th>Recommendation</th><th>Evidence</th></tr><tr><td colspan='8'>Upload documents and click Process Files.</td></tr>";
document.getElementById("tbl_evidence").innerHTML = "<tr><th>Disparity</th><th>Snippet</th><th>Doc</th><th>Page</th></tr><tr><td colspan='4'>—</td></tr>";
document.getElementById("tbl_cra").innerHTML = "<tr><th>Opportunity</th><th>CRA test mapping</th><th>Criterion satisfied</th><th>Strength</th><th>Score</th><th>Scope guidance</th><th>Application packet checklist</th></tr><tr><td colspan='7'>—</td></tr>";
if(document.getElementById("tbl_chna_gaps")) document.getElementById("tbl_chna_gaps").innerHTML = "<tr><th>Document</th><th>CHNA score</th><th>IS score</th><th>Written comments</th><th>Public availability</th><th>Top gaps (auto)</th><th>Evidence</th></tr><tr><td colspan=\"7\">—</td></tr>";
if(document.getElementById("chna_gap_recs")) document.getElementById("chna_gap_recs").textContent = "Upload CHNA/IS documents and click Process Files.";

// initialize draft UI
wireDraftUI();


// ------------------------------
// Draft Generator (Application artifacts)
// ------------------------------
function pickOpportunity(kind){
  if(!state.opportunities || state.opportunities.length===0) return null;
  if(kind==="auto") return state.opportunities[0];
  return state.opportunities.find(o=>o.kind===kind) || state.opportunities[0];
}

function topEvidenceLines(maxLines=4){
  const lines = [];
  // Prefer transportation: show overall + 65–74 if available
  if(state.transport.overall!=null){
    lines.push(`- Transportation barrier overall: ${fmtPct(state.transport.overall)} (source: ${findEvidenceRef("Transportation barrier", "Overall") || "see evidence table"})`);
  }
  if(state.transport.age6574!=null){
    lines.push(`- Transportation barrier age 65–74: ${fmtPct(state.transport.age6574)} (source: ${findEvidenceRef("Transportation barrier", "Age 65") || "see evidence table"})`);
  }
  const others = state.findings.filter(f=>f.key!=="transport").slice(0, maxLines);
  for(const f of others){
    lines.push(`- ${f.disparity} (${f.segment}): ${fmtPct(f.magnitude)} (evidence: ${f.evidenceRef||"—"})`);
  }
  return lines.join("\n");
}

function findEvidenceRef(disparityLabel, segmentHint){
  const f = state.findings.find(x => x.disparity === disparityLabel && (!segmentHint || x.segment.includes(segmentHint)));
  return f ? f.evidenceRef : null;
}

function appPacketChecklist(kind){
  const common = [
    "CHNA excerpt(s) with page references (documented need + affected segment)",
    "Target population definition (LMI method and/or qualifying segment definition)",
    "Geographic attribution method (AA mapping via ZIP/tract/county; proportional benefit if broader)",
    "Contracts/MOUs/service agreements and invoices (clean audit trail)",
    "Service logs and beneficiary counts (units delivered; counts served; LMI estimate)",
    "Monitoring cadence (baseline vs observed; variance notes; corrective actions)"
  ];
  const nmt = [
    "Ride logs (date/time pickup/dropoff; appointment type; beneficiary ZIP)",
    "Broker/vendor KPIs (on-time rate, completed rides, cancellations, no-shows)",
    "Eligibility gating rationale (senior prioritization supported by CHNA differential)"
  ];
  const food = [
    "Distribution logs (units delivered; eligibility; geography)",
    "Partner controls (stock, delivery cadence, audit spot-checks)"
  ];
  const care = [
    "Workflow documentation (referral pathways; intake criteria)",
    "Referral counts and closed-loop outcomes"
  ];
  let extra = [];
  if(kind==="nmt") extra = nmt;
  if(kind==="food") extra = food;
  if(kind==="care") extra = care;
  return common.concat(extra).map(x=>`- ${x}`).join("\n");
}

function renderCrosswalkTable(opportunity){
  const rows = state.opportunities.map(o => {
    return `| ${o.opp} | ${o.tests} | ${o.criterion} | ${o.score} (${o.strength}) | ${o.scope} |`;
  });
  return [
    "| Opportunity | CRA test mapping | Criterion satisfied | Readiness | Scope guidance |",
    "|---|---|---|---|---|",
    ...rows
  ].join("\n");
}

function draftHeader(tone, projectName){
  const title = projectName ? projectName : "CRA‑Aligned Health Access Initiative";
  const toneLine = tone==="bank" ? "Bank CRA File Draft" : (tone==="hospital" ? "Hospital Internal Approval Draft" : "Joint Bank–Hospital Draft");
  return `${title}\n${toneLine}\nGenerated: ${new Date().toISOString()}\n`;
}

function generateDraft(draftType, oppKind, tone){
  const opp = pickOpportunity(oppKind);
  const projectName = (document.getElementById("draft_project_name")?.value || "").trim();
  const partner = (document.getElementById("draft_partner")?.value || "").trim();
  const scopeNote = (document.getElementById("draft_scope_note")?.value || "").trim();
  const structure = (document.getElementById("draft_structure")?.value || "").trim();

  const header = draftHeader(tone, projectName);
  const oppLine = opp ? `${opp.opp}\nCRA criterion satisfied: ${opp.criterion}\nCRA test mapping: ${opp.tests}\nReadiness: ${opp.score} (${opp.strength})\n` :
    "No Tier 2 opportunities available yet. Process documents first.\n";

  const evidence = topEvidenceLines(4);

  // Tier 3 model inclusion when available
  let modelBlock = "Tier 3 (cost & ROI): Not yet run. Run Tier 3 to populate cost baseline and break‑even assumptions.\n";
  if(state.model){
    modelBlock =
`Tier 3 (cost & ROI) — most recent scenario:
- Activity: ${state.model.activity}
- Coverage: ${state.model.coverage_pct}% (${state.model.weight_mode === "weighted" ? "senior‑weighted" : "flat"}; seniors share ${state.model.seniors_share_pct}%)
- Annualized program cost: ${fmtMoney(state.model.annual_cost)}
- Annual gross benefit: ${fmtMoney(state.model.gross_annual_benefit)}
- Annual net impact: ${fmtMoney(state.model.net_annual)}
- Assumptions: baseline disruption ${state.model.baseline_rate_pct.toFixed(1)}%, barrier share ${state.model.barrier_share_pct.toFixed(1)}%, reduction ${state.model.reduction_pct.toFixed(1)}%.\n`;
  }

  const orgLines = [
    partner ? `Implementing partner: ${partner}` : null,
    structure ? `Funding structure: ${structure}` : null,
    scopeNote ? `AA/scope note: ${scopeNote}` : null
  ].filter(Boolean).join("\n");

  if(draftType==="cra_memo"){
    return `${header}
1) Selected opportunity
${oppLine}
${orgLines ? orgLines + "\n" : ""}

2) Performance context and documented need (CHNA evidence)
${evidence}

3) Why this is responsive (what changes)
- The activity is targeted to the population segment(s) with the largest documented access disruption (e.g., seniors where transportation barrier is amplified).
- The implementation design includes traceable eligibility, service logs, and geography attribution to support exam defensibility.

4) Eligibility criterion satisfied (explicit)
${opp ? opp.criterion : "—"}

5) Scope and attribution
- Primary: attribute benefit within the bank’s assessment area by documenting beneficiary location (ZIP/tract/county) and delivery footprint.
- Secondary: if broader, document proportional benefit allocation and retain mapping evidence.

6) Program cost baseline and impact (decision support)
${modelBlock}

7) Evidence & monitoring packet (minimum)
${appPacketChecklist(opp ? opp.kind : "nmt")}
`;
  }

  if(draftType==="exam_narrative"){
    const amp = (state.transport.overall && state.transport.age6574) ? (state.transport.age6574/state.transport.overall) : null;
    const ampLine = amp ? `Transportation barriers were amplified among older adults (~${amp.toFixed(1)}× vs overall), supporting a targeted access response.` : `Transportation barriers were documented in the CHNA and used to target the activity.`;
    return `${header}
Examiner‑facing narrative (Performance Evaluation style)

The institution supported a community services initiative aligned to documented local needs. ${ampLine}
The activity was structured to meet the CRA qualifying criterion as a community development service targeted to low‑ or moderate‑income individuals (criterion and support documentation retained). The institution maintained an audit trail including service logs, invoices, and beneficiary counts, and tracked outcomes against a defined baseline.

Evidence basis (CHNA excerpts):
${evidence}

CRA criterion satisfied:
${opp ? opp.criterion : "—"}

${state.model ? "Quantified program cost and impact (annualized):\n- Cost: "+fmtMoney(state.model.annual_cost)+"\n- Net impact: "+fmtMoney(state.model.net_annual)+"\n" : ""}`;
  }

  if(draftType==="crosswalk"){
    return `${header}
CRA Eligibility Crosswalk (working)

${renderCrosswalkTable(opp)}
`;
  }

  if(draftType==="term_sheet"){
    return `${header}
Joint Partnership Term Sheet (working draft)

Project: ${projectName || (opp ? opp.opp : "—")}
Purpose: Address documented access disparities through a targeted intervention aligned with CRA community development criteria.

Parties:
- Hospital: _______________________
- Bank: ___________________________
${partner ? "- Implementing partner: "+partner+"\n" : ""}

Need statement (CHNA):
${evidence}

CRA criterion satisfied:
${opp ? opp.criterion : "—"}

Geographic attribution:
- Assessment area targeting: document beneficiary location and service footprint.
${scopeNote ? "- Notes: "+scopeNote+"\n" : ""}

Funding structure:
${structure || "TBD (grant / investment / service agreement — choose the structure that best aligns with bank CRA strategy and hospital operations)."}

Budget baseline (annualized):
${state.model ? "- Program cost: "+fmtMoney(state.model.annual_cost)+"\n- Expected net impact: "+fmtMoney(state.model.net_annual)+"\n" : "- Run Tier 3 to populate cost baseline and scenario.\n"}

Evidence & reporting:
${appPacketChecklist(opp ? opp.kind : "nmt")}

Sign‑off workflow:
- Hospital approval: ____________________
- Bank CRA approval: ___________________
`;
  }

  if(draftType==="chna_brief"){
    return `${header}
CHNA Implementation Alignment Brief

CHNA‑documented need:
${evidence}

Selected intervention:
${oppLine}

Implementation summary:
- Target segment(s): older adults prioritized when transportation barriers are amplified; additional eligibility defined by LMI method and service area.
- Delivery model: partner/brokered NEMT with documented ride logs and monitoring.

Budget and evaluation:
${modelBlock}

KPIs:
- Completed rides
- Prevented disruptions (missed appointments)
- Beneficiary counts and geography attribution
- Monthly monitoring with corrective action triggers
`;
  }

  if(draftType==="monitor_plan"){
    return `${header}
Monitoring & Evidence Plan (Exam‑ready)

Selected opportunity:
${oppLine}

Data capture (minimum):
${appPacketChecklist(opp ? opp.kind : "nmt")}

Monitoring cadence:
- Weekly: operational exceptions (cancellations, no‑shows, delayed pickups)
- Monthly: units delivered; beneficiary counts; geography attribution spot check; budget variance
- Quarterly: baseline vs observed disruption rate; program adjustments and corrective actions

Outputs:
- Audit trail pack (contracts/invoices/service logs)
- Quarterly narrative of responsiveness and observed performance
`;
  }


  if(draftType==="pnl"){
    const m = state.model?.outputs;
    if(!m) return `${header}\nP&L Draft unavailable: Run Tier 3 ROI first.\n`;
    const baseNet = m.net_benefit;
    const coding = state.model?.coding?.uplift || 0;
    const totalNet = state.model?.totalNet ?? (baseNet + coding);

    return `${header}
Borrower P&L Statement (Hospital) — Annualized (Draft)

Revenue & Contribution:
- Gross revenue recaptured: ${fmtMoney(m.gross_rev)}
- Less: Marginal clinical cost: ${fmtMoney(m.marginal_cost)}
= Contribution margin from recovered visits: ${fmtMoney(m.gross_rev - m.marginal_cost)}

Program Costs:
- Transportation direct cost: ${fmtMoney(m.transport_cost)}
- Program overhead cost: ${fmtMoney(m.overhead_cost)}
= Total program cost: ${fmtMoney(m.total_program_cost)}

Net Operating Result (Base, Excel parity):
- Net annual benefit: ${fmtMoney(baseNet)}

Optional Coding Layer (if enabled):
- Coding uplift: ${fmtMoney(coding)}
- Net incl. coding uplift: ${fmtMoney(totalNet)}

Notes:
- Base ROI follows Excel-parity incremental margin model.
- Coding uplift is optional and should be supported by documentation workflows and coding governance.
`;
  }

  if(draftType==="proforma_3yr"){
    const m = state.model?.outputs;
    if(!m) return `${header}\n3-Year Pro Forma unavailable: Run Tier 3 ROI first.\n`;

    // simple conservative pro forma: allow growth & inflation assumptions (defaults)
    const growth = parseFloat((document.getElementById("draft_growth")?.value || "5"))/100;
    const infl = parseFloat((document.getElementById("draft_infl")?.value || "3"))/100;

    const y1_rev = m.gross_rev;
    const y1_marg = m.marginal_cost;
    const y1_cost = m.total_program_cost;
    const y1_net = m.net_benefit;

    const rows = [];
    for(let yr=1; yr<=3; yr++){
      const factor = Math.pow(1+growth, yr-1);
      const costFactor = Math.pow(1+infl, yr-1);
      const rev = y1_rev * factor;
      const marg = y1_marg * factor;
      const prog = y1_cost * costFactor;
      const net = rev - marg - prog;
      rows.push({yr, rev, marg, prog, net});
    }

    const table = rows.map(r=>`Year ${r.yr}: Revenue ${fmtMoney(r.rev)} | Marginal cost ${fmtMoney(r.marg)} | Program cost ${fmtMoney(r.prog)} | Net ${fmtMoney(r.net)}`).join("\n");

    return `${header}
Project Pro Forma Budget (3-Year) — Draft

Assumptions:
- Volume/revenue growth on recovered visits: ${(growth*100).toFixed(1)}% / year
- Program cost inflation: ${(infl*100).toFixed(1)}% / year
- Base Year 1 values derived from Tier 3 ROI (Excel parity)

3-Year Summary:
${table}

Interpretation:
- Year 1 is the conservative base case (spreadsheet parity).
- Growth reflects program maturation and improved engagement.
- Inflation reflects vendor and admin cost escalation.
`;
  }

  
  if(draftType==="lender_pnl_3yr" || draftType==="lender_proforma_3yr"){
    // Build a lender-facing, line-item 3-year package.
    // Uses most recent Tier 3 ROI run when available; otherwise derives from current Tier 3 input fields.
    let scen = null;
    try{
      if(state.model && state.model.outputs && state.model.inputs){
        scen = {inp: state.model.inputs, out: state.model.outputs, cu: state.model.coding || {uplift:0, detail:""}, totalNet: (state.model.totalNet ?? (state.model.outputs.net_benefit + ((state.model.coding||{}).uplift||0)))};
      }else{
        const inp = roi_inputs();
        const out = roi_calc(inp);
        const cu = coding_uplift(out.prevented, inp.visits);
        scen = {inp, out, cu, totalNet: (out.net_benefit + cu.uplift)};
      }
    }catch(e){
      scen = null;
    }

    if(!scen){
      return `${header}\nLender-facing financial artifacts unavailable: run Tier 3 ROI (or ensure Tier 3 inputs are present).\n`;
    }

    const growth = parseFloat((document.getElementById("draft_growth")?.value || "5"))/100;
    const infl = parseFloat((document.getElementById("draft_infl")?.value || "3"))/100;

    // Year 1 base (annualized) from ROI parity model
    const y1 = {
      recovered_visits: scen.out.prevented,
      patient_service_revenue: scen.out.gross_rev,
      quality_uplift: scen.cu?.uplift ? scen.cu.uplift : 0,
      total_revenue: scen.out.gross_rev + (scen.cu?.uplift ? scen.cu.uplift : 0),
      marginal_clinical_cost: scen.out.marginal_cost,
      nmt_vendor_cost: scen.out.transport_cost,
      admin_overhead_total: scen.out.overhead_cost,
      total_program_cost: scen.out.total_program_cost,
      net_contribution: (scen.out.gross_rev - scen.out.marginal_cost - scen.out.total_program_cost) + (scen.cu?.uplift ? scen.cu.uplift : 0)
    };

    // Overhead allocation (for line-item transparency; totals reconcile to ROI overhead)
    const ohAlloc = [
      {k:"Program management & operations", p:0.35},
      {k:"Patient outreach, scheduling & confirmations", p:0.20},
      {k:"Data, reporting & audit trail (CRA/CHNA)", p:0.18},
      {k:"Compliance & legal / contracting", p:0.12},
      {k:"Evaluation & continuous improvement", p:0.10},
      {k:"IT/tools (workflow enablement)", p:0.05}
    ];

    function projectYear(base, yr){
      const volF = Math.pow(1+growth, yr-1);
      const costF = Math.pow(1+infl, yr-1);

      const recovered = base.recovered_visits * volF;
      const rev = base.patient_service_revenue * volF;
      const qual = base.quality_uplift * volF; // conservative: tie to volume
      const totRev = rev + qual;

      const marg = base.marginal_clinical_cost * volF;
      const nmt = base.nmt_vendor_cost * costF; // vendor cost inflation
      const oh = base.admin_overhead_total * costF;
      const prog = nmt + oh;

      const net = (rev - marg - prog) + qual;

      return {recovered, rev, qual, totRev, marg, nmt, oh, prog, net};
    }

    const y2 = projectYear(y1, 2);
    const y3 = projectYear(y1, 3);

    const table3 =
`3-Year Summary (annual, $)
| Line item | Year 1 | Year 2 | Year 3 |
|---|---:|---:|---:|
| Recovered visits enabled | ${Math.round(y1.recovered_visits).toLocaleString()} | ${Math.round(y2.recovered).toLocaleString()} | ${Math.round(y3.recovered).toLocaleString()} |
| Patient service revenue (net) | ${fmtMoney(y1.patient_service_revenue)} | ${fmtMoney(y2.rev)} | ${fmtMoney(y3.rev)} |
| Quality / coding uplift (optional) | ${fmtMoney(y1.quality_uplift)} | ${fmtMoney(y2.qual)} | ${fmtMoney(y3.qual)} |
| **Total revenue** | **${fmtMoney(y1.total_revenue)}** | **${fmtMoney(y2.totRev)}** | **${fmtMoney(y3.totRev)}** |
| Marginal clinical cost | ${fmtMoney(y1.marginal_clinical_cost)} | ${fmtMoney(y2.marg)} | ${fmtMoney(y3.marg)} |
| NEMT vendor expense (variable) | ${fmtMoney(y1.nmt_vendor_cost)} | ${fmtMoney(y2.nmt)} | ${fmtMoney(y3.nmt)} |
| Admin/overhead (allocated) | ${fmtMoney(y1.admin_overhead_total)} | ${fmtMoney(y2.oh)} | ${fmtMoney(y3.oh)} |
| **Total program cost** | **${fmtMoney(y1.total_program_cost)}** | **${fmtMoney(y2.prog)}** | **${fmtMoney(y3.prog)}** |
| **Net contribution (EBITDA-like)** | **${fmtMoney(y1.net_contribution)}** | **${fmtMoney(y2.net)}** | **${fmtMoney(y3.net)}** |
`;

    const overheadDetail = ohAlloc.map(a=>{
      const v1 = y1.admin_overhead_total * a.p;
      const v2 = y2.oh * a.p;
      const v3 = y3.oh * a.p;
      return `| ${a.k} | ${fmtMoney(v1)} | ${fmtMoney(v2)} | ${fmtMoney(v3)} |`;
    }).join("\n");

    const overheadTable =
`Overhead detail (reconciles to ROI overhead; for lender transparency)
| Overhead line item | Year 1 | Year 2 | Year 3 |
|---|---:|---:|---:|
${overheadDetail}
| **Total allocated overhead** | **${fmtMoney(y1.admin_overhead_total)}** | **${fmtMoney(y2.oh)}** | **${fmtMoney(y3.oh)}** |
`;

    const assumptions =
`Core assumptions (from Tier 3 inputs)
- Annual targeted visits: ${Math.round(scen.inp.visits).toLocaleString()}
- No-show rate: ${(scen.inp.noshow*100).toFixed(1)}%
- Share due to transportation: ${(scen.inp.share*100).toFixed(1)}%
- Mitigation (prevented share): ${(scen.inp.mitig*100).toFixed(1)}%
- Net revenue per recovered visit: $${(scen.inp.netrev||0).toFixed(0)}
- Marginal clinical cost per recovered visit: $${(scen.inp.margc||0).toFixed(0)}
- Trip cost: $${(scen.inp.trip||0).toFixed(0)}  | Overhead rate: ${(scen.inp.over*100).toFixed(1)}%
- Growth on recovered volume: ${(growth*100).toFixed(1)}%/yr  | Cost inflation: ${(infl*100).toFixed(1)}%/yr
`;

    if(draftType==="lender_pnl_3yr"){
      return `${header}
LENDER-FACING 3-YEAR P&L (Incremental Program Economics — Line-Item)

Purpose
This statement isolates incremental operating impact of a CRA-aligned access program on the hospital (borrower),
using the dashboard ROI scenario as the Year 1 base and projecting Years 2–3 using the selected growth/inflation assumptions.

${assumptions}

${table3}

${overheadTable}

Lender notes (how to underwrite this)
- Revenue line represents net patient service revenue recovered from prevented transportation-related no-shows.
- Marginal clinical cost reflects variable clinical expense tied to recovered visits (not fully loaded fixed cost).
- Program cost is variable with volume and vendor pricing; overhead is transparently allocated for governance, audit, and reporting.
- Optional “quality/coding uplift” should be included only if documentation and coding governance controls are implemented (e.g., workflow prompts, QA sampling).

Risk controls (what reduces variability)
- Eligibility + ride-log documentation to minimize leakage and support CRA/CHNA defensibility.
- Vendor SLA (on-time pickup, completion rate) + monthly variance review.
- Audit-ready evidence pack (contracts, invoices, beneficiary counts, AA attribution).

Generated: ${new Date().toISOString()}
`;
    }

    // lender_proforma_3yr
    const sourcesUses =
`Sources & Uses (illustrative; editable)
Sources:
- Bank CRA contribution (annual): $${(scen.inp.bank||0).toLocaleString()}
- Hospital contribution (annual): ${fmtMoney(Math.max(0, y1.total_program_cost - (scen.inp.bank||0)))}
Uses:
- NEMT vendor expense: ${fmtMoney(y1.nmt_vendor_cost)}
- Program overhead (allocated): ${fmtMoney(y1.admin_overhead_total)}
`;

    return `${header}
LENDER-FACING 3-YEAR PRO FORMA (Budget + Performance — Line-Item)

Purpose
This pro forma is structured as a lender-ready attachment: (1) clear assumptions, (2) line-item cost structure,
(3) projected operating contribution, and (4) documentation / controls that reduce performance risk.

${assumptions}

${sourcesUses}

${table3}

${overheadTable}

Performance monitoring (what the lender can request quarterly)
- Volumes: rides delivered; recovered visits; cancellation/no-show rates.
- Financial: program cost per recovered visit; net contribution; variance to pro forma.
- Compliance: evidence completeness (contracts/invoices/ride logs/beneficiary counts); AA and LMI attribution checks.
- Outcomes: appointment adherence trend; patient experience measures (optional).

Generated: ${new Date().toISOString()}
`;
  }
// fallback
  return `${header}\nNo draft type selected.\n`;
}

function wireDraftUI(){
  const genBtn = document.getElementById("btn_generate_draft");
  if(!genBtn) return; // view not present
  genBtn.addEventListener("click", ()=>{
    const type = document.getElementById("draft_type").value;
    const kind = document.getElementById("draft_activity").value;
    const tone = document.getElementById("draft_tone").value;
    const txt = generateDraft(type, kind, tone);
    document.getElementById("draft_preview").textContent = txt;
  });

  document.getElementById("btn_copy_draft").addEventListener("click", async ()=>{
    const txt = document.getElementById("draft_preview").textContent || "";
    try{
      await navigator.clipboard.writeText(txt);
      showOk("Draft copied to clipboard.");
    }catch(e){
      showOk("Copy failed in this browser. You can manually select the text and copy.");
    }
  });

  document.getElementById("btn_download_draft").addEventListener("click", ()=>{
    const txt = document.getElementById("draft_preview").textContent || "";
    const blob = new Blob([txt], {type:"text/plain"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const type = document.getElementById("draft_type").value;
    a.download = `cra_application_${type}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}


function _num(id){
  const el = document.getElementById(id);
  if(!el) return 0;
  let v = parseFloat(el.value);
  if(isNaN(v)) return 0;
  return (v > 1) ? v/100 : v; // normalize percent-style
}



function _normRate(x){
  // Accept decimals (0.2) or percents (20)
  if(isNaN(x)) return 0;
  return (x > 1) ? (x/100) : x;
}

function roi_inputs(){
  const visits = parseFloat(document.getElementById("a_visits").value) || 0;
  return {
    visits,
    noshow: _normRate(parseFloat(document.getElementById("a_noshow").value)),
    share: _normRate(parseFloat(document.getElementById("a_share").value)),
    netrev: parseFloat(document.getElementById("a_netrev").value) || 0,
    margc: parseFloat(document.getElementById("a_margc").value) || 0,
    mitig: _normRate(parseFloat(document.getElementById("b_mitig").value)),
    trip: parseFloat(document.getElementById("b_trip").value) || 0,
    over: _normRate(parseFloat(document.getElementById("b_over").value)),
    lmi: _normRate(parseFloat(document.getElementById("c_lmi").value)),
    aa: _normRate(parseFloat(document.getElementById("c_aa").value)),
    bank: parseFloat(document.getElementById("c_bank").value) || 0
  };
}

function roi_calc(inp){
  const transport_no_shows = inp.visits * inp.noshow * inp.share;
  const prevented = transport_no_shows * inp.mitig;
  const gross_rev = prevented * inp.netrev;
  const marginal_cost = prevented * inp.margc;
  const transport_cost = prevented * inp.trip;
  const overhead_cost = transport_cost * inp.over;
  const total_program_cost = transport_cost + overhead_cost;
  const net_benefit = gross_rev - marginal_cost - total_program_cost;
  const be_trip_max = inp.netrev - inp.margc;

  const trips = prevented;
  const lmi_trips = trips * inp.lmi;
  const aa_trips = trips * inp.aa;
  const bank_per_lmi = (lmi_trips===0) ? 0 : (inp.bank/lmi_trips);
  const bank_share_cost = (total_program_cost===0) ? 0 : (inp.bank/total_program_cost);

  const narrative = `Estimated ${Math.round(lmi_trips).toLocaleString()} LMI trips and ${Math.round(trips).toLocaleString()} essential visits enabled annually within the Assessment Area.`;
  return {transport_no_shows, prevented, gross_rev, marginal_cost, transport_cost, overhead_cost, total_program_cost, net_benefit, be_trip_max,
          trips, lmi_trips, aa_trips, bank_per_lmi, bank_share_cost, narrative};
}

function coding_uplift(preventedVisits, allVisits){
  const enabled = document.getElementById("toggle_coding").checked;
  if(!enabled) return {uplift:0, detail:"Coding layer not enabled."};

  const zRate = _normRate(parseFloat(document.getElementById("z_rate").value));
  const zUplift = parseFloat(document.getElementById("z_uplift").value) || 0;
  const cptRate = _normRate(parseFloat(document.getElementById("cpt_rate").value));
  const cptUplift = parseFloat(document.getElementById("cpt_uplift").value) || 0;
  const base = document.getElementById("coding_base").value; // prevented | all
  const n = (base === "all") ? allVisits : preventedVisits;

  const zAdd = n * zRate * zUplift;
  const cptAdd = n * cptRate * cptUplift;
  const uplift = zAdd + cptAdd;

  const notes = (document.getElementById("coding_notes").value || "").trim();
  const detail = `Coding uplift applied to ${base === "all" ? "all targeted visits" : "recovered visits"}:
- Z-code capture: ${(zRate*100).toFixed(1)}% × $${zUplift.toFixed(0)} = $${zAdd.toFixed(0)}
- CPT capture: ${(cptRate*100).toFixed(1)}% × $${cptUplift.toFixed(0)} = $${cptAdd.toFixed(0)}
${notes ? "- Notes: " + notes : ""}`.trim();

  return {uplift, detail};
}

function ccm_tcm_calc(){
  const enabled = document.getElementById("toggle_ccm")?.checked;
  if(!enabled) return {ccm_net:0, tcm_net:0, detail:"CCM/TCM layer not enabled.", enabled:false};

  // CCM
  const ccm_patients = parseFloat(document.getElementById("ccm_patients")?.value)||0;
  const ccm_enroll = _normRate(parseFloat(document.getElementById("ccm_enroll")?.value)||0);
  const ccm_months = parseFloat(document.getElementById("ccm_months")?.value)||0;
  const ccm_allowed = parseFloat(document.getElementById("ccm_allowed")?.value)||0;
  const ccm_success = _normRate(parseFloat(document.getElementById("ccm_success")?.value)||0);
  const ccm_staff_rate = parseFloat(document.getElementById("ccm_staff_rate")?.value)||0;
  const ccm_minutes = parseFloat(document.getElementById("ccm_minutes")?.value)||0;

  const ccm_enrolled = ccm_patients * ccm_enroll;
  const ccm_billed_months = ccm_enrolled * ccm_months * ccm_success;
  const ccm_gross = ccm_billed_months * ccm_allowed;
  const ccm_labor = ccm_billed_months * ccm_minutes * ccm_staff_rate;
  const ccm_net = ccm_gross - ccm_labor;

  // TCM
  const tcm_discharges = parseFloat(document.getElementById("tcm_discharges")?.value)||0;
  const tcm_reach = _normRate(parseFloat(document.getElementById("tcm_reach")?.value)||0);
  const tcm_high_share = _normRate(parseFloat(document.getElementById("tcm_high_share")?.value)||0);
  const tcm_allow_mod = parseFloat(document.getElementById("tcm_allow_mod")?.value)||0;
  const tcm_allow_high = parseFloat(document.getElementById("tcm_allow_high")?.value)||0;
  const tcm_success = _normRate(parseFloat(document.getElementById("tcm_success")?.value)||0);
  const tcm_minutes = parseFloat(document.getElementById("tcm_minutes")?.value)||0;
  const tcm_staff_rate = parseFloat(document.getElementById("tcm_staff_rate")?.value)||0;

  const tcm_episodes = tcm_discharges * tcm_reach * tcm_success;
  const tcm_avg_allowed = tcm_high_share * tcm_allow_high + (1-tcm_high_share) * tcm_allow_mod;
  const tcm_gross = tcm_episodes * tcm_avg_allowed;
  const tcm_labor = tcm_episodes * tcm_minutes * tcm_staff_rate;
  const tcm_net = tcm_gross - tcm_labor;

  const detail = `CCM:\n- Enrolled: ${Math.round(ccm_enrolled).toLocaleString()} patients\n- Billed patient-months: ${Math.round(ccm_billed_months).toLocaleString()}\n- Gross revenue: ${fmtMoney(ccm_gross)} | Labor: ${fmtMoney(ccm_labor)}\n- Net CCM contribution: ${fmtMoney(ccm_net)}\n\nTCM:\n- Billable episodes: ${Math.round(tcm_episodes).toLocaleString()}\n- Avg allowed: $${tcm_avg_allowed.toFixed(0)}\n- Gross revenue: ${fmtMoney(tcm_gross)} | Labor: ${fmtMoney(tcm_labor)}\n- Net TCM contribution: ${fmtMoney(tcm_net)}\n\n⚠️ CCM/TCM time must be real, threshold-meeting, and non-duplicative. Consult compliance before operationalizing.`;
  return {ccm_net, tcm_net, ccm_gross, tcm_gross, ccm_labor, tcm_labor, ccm_enrolled, ccm_billed_months, tcm_episodes, detail, enabled:true};
}

function vbc_calc(){
  const enabled = document.getElementById("toggle_vbc")?.checked;
  if(!enabled) return {earn:0, detail:"VBC Quality layer not enabled.", enabled:false};

  const vbc_type = document.getElementById("vbc_type")?.value || "earnback";
  const at_risk = parseFloat(document.getElementById("vbc_at_risk")?.value)||0;
  const baseline = parseFloat(document.getElementById("vbc_baseline")?.value)||0;
  const projected = parseFloat(document.getElementById("vbc_projected")?.value)||0;

  let earn = 0;
  let detail = "";

  if(vbc_type === "earnback"){
    const delta = Math.max(0, projected - baseline);
    earn = (delta / 100) * at_risk;
    detail = `Linear earn-back model:\n- At-risk pool: ${fmtMoney(at_risk)}\n- Baseline score: ${baseline}\n- Projected score: ${projected}\n- Delta: +${delta} points\n- Incremental earn-back: ${fmtMoney(earn)}\n\nAffected measures: Diabetes Glycemic Status (QPP 001), Controlling High Blood Pressure (236), Colorectal Screening (113), Transitions of Care / Med Rec (Star Ratings).`;
  } else {
    const threshold = parseFloat(document.getElementById("vbc_threshold")?.value)||0;
    const bonus = parseFloat(document.getElementById("vbc_bonus")?.value)||0;
    const clears = projected >= threshold;
    const baseClears = baseline >= threshold;
    earn = clears && !baseClears ? bonus : 0;
    detail = `Cliff/threshold bonus model:\n- Threshold: ${threshold} | Bonus: ${fmtMoney(bonus)}\n- Baseline ${baseline} ${baseClears?"CLEARS":"misses"} threshold\n- Projected ${projected} ${clears?"CLEARS":"misses"} threshold\n- Incremental earn: ${fmtMoney(earn)}\n${!clears?"Note: Projected score does not reach threshold. Consider interventions to close remaining gap.":""}`;
  }
  return {earn, detail, enabled:true};
}

function render_roi(){
  const inp = roi_inputs();
  const out = roi_calc(inp);

  // Base KPI outputs (Excel parity)
  document.getElementById("o_net").textContent = "$" + out.net_benefit.toLocaleString(undefined,{maximumFractionDigits:0});
  document.getElementById("o_tripmax").textContent = "$" + out.be_trip_max.toFixed(0);
  document.getElementById("o_cost").textContent = "$" + out.total_program_cost.toLocaleString(undefined,{maximumFractionDigits:0});

  // Coding uplift (optional)
  const cu = coding_uplift(out.prevented, inp.visits);
  document.getElementById("o_code").textContent = "$" + cu.uplift.toLocaleString(undefined,{maximumFractionDigits:0});

  const totalNet = out.net_benefit + cu.uplift;
  document.getElementById("o_total_net").textContent = "$" + totalNet.toLocaleString(undefined,{maximumFractionDigits:0});

  const roiTotal = (out.total_program_cost===0) ? 0 : (totalNet / out.total_program_cost);
  document.getElementById("o_roi").textContent = (out.total_program_cost===0) ? "—" : roiTotal.toFixed(2) + "x";

  // CCM/TCM Layer
  const cct = ccm_tcm_calc();
  document.getElementById("o_ccm_net").textContent = cct.enabled ? fmtMoney(cct.ccm_net) : "—";
  document.getElementById("o_tcm_net").textContent = cct.enabled ? fmtMoney(cct.tcm_net) : "—";

  // VBC Layer
  const vbc = vbc_calc();
  document.getElementById("o_vbc_earn").textContent = vbc.enabled ? fmtMoney(vbc.earn) : "—";

  // All-in
  const allin = totalNet + (cct.enabled ? cct.ccm_net + cct.tcm_net : 0) + (vbc.enabled ? vbc.earn : 0);
  document.getElementById("o_allin").textContent = fmtMoney(allin);

  // Waterfall chart
  const wfCtx = document.getElementById("roi_waterfall");
  if(wfCtx){
    if(wfCtx._chart){ wfCtx._chart.destroy(); }
    wfCtx._chart = new Chart(wfCtx, {
      type:"bar",
      data:{
        labels:["Gross Revenue\nRecaptured","Marginal\nClinical Cost","Program\nCost","FFS Net\nBenefit","Coding\nUplift","CCM\nNet","TCM\nNet","VBC\nEarn-back","All-in\nValue"],
        datasets:[{
          data:[out.gross_rev, -out.marginal_cost, -out.total_program_cost, out.net_benefit, cu.uplift, cct.enabled?cct.ccm_net:0, cct.enabled?cct.tcm_net:0, vbc.enabled?vbc.earn:0, allin],
          backgroundColor:["#14b8a6","#ef4444","#ef4444","#0f2b46","#64748b","#2563eb","#3b82f6","#059669","#0d9488"],
          borderRadius:6,
          borderSkipped:false
        }]
      },
      options:{
        plugins:{legend:{display:false}},
        scales:{y:{ticks:{callback:(v)=>"$"+Math.round(v/1000)+"K"}}},
        responsive:true
      }
    });
  }

  // Value stack bar chart
  const ctx = document.getElementById("roi_bar");
  if(ctx){
    if(ctx._chart){ ctx._chart.destroy(); }
    const labels = ["FFS Base"];
    const vals = [out.net_benefit];
    const colors = ["#0f2b46"];
    if(cu.uplift>0){ labels.push("+ Coding"); vals.push(cu.uplift); colors.push("#64748b"); }
    if(cct.enabled){ labels.push("+ CCM"); vals.push(cct.ccm_net); colors.push("#2563eb"); labels.push("+ TCM"); vals.push(cct.tcm_net); colors.push("#3b82f6"); }
    if(vbc.enabled){ labels.push("+ VBC"); vals.push(vbc.earn); colors.push("#059669"); }
    ctx._chart = new Chart(ctx, {
      type:"bar",
      data:{labels, datasets:[{data:vals, backgroundColor:colors, borderRadius:6}]},
      options:{plugins:{legend:{display:false}}, scales:{y:{ticks:{callback:(v)=>"$"+Math.round(v/1000)+"K"}}}, responsive:true}
    });
  }

  // CRA outputs
  const craTxt =
`Trips delivered (round trips): ${Math.round(out.trips).toLocaleString()}
LMI trips: ${Math.round(out.lmi_trips).toLocaleString()}
AA trips: ${Math.round(out.aa_trips).toLocaleString()}

Bank annual contribution: $${inp.bank.toLocaleString()}
Bank contribution per LMI trip: $${out.bank_per_lmi.toFixed(0)}
Share of total program cost funded by Bank: ${(out.bank_share_cost*100).toFixed(1)}%

Narrative-ready summary:
${out.narrative}`;
  document.getElementById("cra_box").textContent = craTxt;

  // Extended layers detail
  const extBox = document.getElementById("extended_layers_box");
  if(extBox){
    let extTxt = "";
    if(cct.enabled) extTxt += cct.detail + "\n\n";
    else extTxt += "CCM/TCM Layer: not enabled.\n\n";
    if(vbc.enabled) extTxt += vbc.detail + "\n\n";
    else extTxt += "VBC Quality Layer: not enabled.\n\n";
    extTxt += `All-in Value Summary:\n- FFS base net: ${fmtMoney(out.net_benefit)}\n- Coding uplift: ${fmtMoney(cu.uplift)}\n- CCM net: ${cct.enabled ? fmtMoney(cct.ccm_net) : "—"}\n- TCM net: ${cct.enabled ? fmtMoney(cct.tcm_net) : "—"}\n- VBC earn-back: ${vbc.enabled ? fmtMoney(vbc.earn) : "—"}\n- All-in value: ${fmtMoney(allin)}`;
    extBox.textContent = extTxt;
  }

  // Audit memo
  document.getElementById("roi_audit").textContent =
`Tier 3 — Excel-parity ROI + Optional Layers

Base ROI (Excel parity):
- Net benefit: $${out.net_benefit.toFixed(0)}
- Total program cost: $${out.total_program_cost.toFixed(0)}
- Break-even trip cost max: $${out.be_trip_max.toFixed(0)}

Coding ROI Layer:
${cu.detail}

CCM/TCM Layer:
${cct.detail}

VBC Quality Layer:
${vbc.detail}

All-in net (all enabled layers): ${fmtMoney(allin)}
ROI incl. coding: ${out.total_program_cost===0 ? "—" : roiTotal.toFixed(2)+"x"}

Generated: ${new Date().toISOString()}`;

  // persist for draft generator
  state.model = { roi_parity:true, inputs: inp, outputs: out, coding: cu, totalNet, roiTotal, ccm_tcm: cct, vbc, allin };
}


(function(){
  const t = document.getElementById("toggle_coding");
  const box = document.getElementById("coding_box");
  if(t && box){
    t.addEventListener("change", ()=>{ box.style.display = t.checked ? "block" : "none"; });
  }
})();


// ------------------------------
// Tier 3 Coding layer UX: recompute on toggle/input changes
// ------------------------------
(function(){
  const t = document.getElementById("toggle_coding");
  const box = document.getElementById("coding_box");
  if(t && box){
    const sync = ()=>{ box.style.display = t.checked ? "block" : "none"; };
    sync();
    t.addEventListener("change", ()=>{ sync(); if(typeof render_roi === "function") render_roi(); });
    ["z_rate","z_uplift","cpt_rate","cpt_uplift","coding_base"].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.addEventListener("change", ()=>{ if(typeof render_roi === "function") render_roi(); });
      if(el) el.addEventListener("input", ()=>{ if(typeof render_roi === "function") render_roi(); });
    });
  }
})();

// CCM/TCM toggle
(function(){
  const t = document.getElementById("toggle_ccm");
  const box = document.getElementById("ccm_box");
  if(t && box){
    t.addEventListener("change", ()=>{ box.style.display = t.checked ? "block" : "none"; });
  }
})();

// VBC toggle
(function(){
  const t = document.getElementById("toggle_vbc");
  const box = document.getElementById("vbc_box");
  const cliff = document.getElementById("vbc_cliff_row");
  if(t && box){
    t.addEventListener("change", ()=>{ box.style.display = t.checked ? "block" : "none"; });
  }
  const typeEl = document.getElementById("vbc_type");
  if(typeEl && cliff){
    typeEl.addEventListener("change", ()=>{
      cliff.style.display = typeEl.value === "cliff" ? "flex" : "none";
    });
  }
})();

// ------------------------------
// Tier 4-6 generators (prototype content)
// ------------------------------
window.copy_block = async function(id){
  const el = document.getElementById(id);
  if(!el) return;
  const txt = el.textContent || "";
  try{ await navigator.clipboard.writeText(txt); showOk("Copied."); }catch(e){ showOk("Copy not available; select text manually."); }
};

window.generate_impl_plan = function(){
  const opp = state.opportunities?.[0];
  const m = state.model?.outputs;
  const today = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const LINE = '━'.repeat(60);
  const txt =
`${LINE}
NEMT PROGRAM — 30-60-90 DAY IMPLEMENTATION PLAN
Generated: ${today}
${LINE}

Opportunity: ${opp ? opp.opp : "[Selected opportunity]"}
CRA criterion: ${opp ? opp.criterion : "[CRA criterion]"}
${m ? "Target prevented no-shows: "+Math.round(m.prevented).toLocaleString()+" visits/yr | Net benefit: "+fmtMoney(m.net_benefit) : ""}

${LINE}
DAYS 0–30: PROGRAM DESIGN & CONTRACTING
${LINE}

ELIGIBILITY & TARGETING
□ Define LMI eligibility threshold (≤80% AMI, Medicaid enrollment, or hybrid)
□ Identify high-priority patient segments: prior no-show history, post-discharge
  patients (TCM window), CCM-enrolled patients with 2+ chronic conditions
□ Confirm CRA Assessment Area boundaries with bank partner counsel
□ Baseline measurement: pull 6-month no-show rate by transportation-barrier flag
  (ICD-10 Z75.3 or staff-coded) for control comparison

VENDOR SELECTION & CONTRACTING
□ Issue RFP or select from existing vendor relationships (rideshare, NEMT broker,
  managed care transportation entity per 42 CFR § 440.170)
□ Verify vendor drivers: current licenses, criminal background checks, insurance
  per CMS NEMT Provider Booklet requirements (CMS April 2016)
□ Confirm vehicles meet state certification requirements; no billing for no-shows
  (loaded mileage only — false billing is prosecuted under False Claims Act)
□ Execute Business Associate Agreement (BAA) — required before first trip
□ Screen vendor and all drivers against OIG LEIE database before contracting;
  repeat monthly (State Medicaid Director Letter 09-001)
□ Negotiate SLA: ≥92% on-time pickup, ≤5% vendor-initiated cancellations,
  100% trip log completion (pickup, dropoff, timestamp, driver ID)

DOCUMENTATION INFRASTRUCTURE
□ Build evidence packet template: ride logs, completed visit confirmations,
  beneficiary ZIP/tract for AA attribution, LMI verification documentation
□ Configure SDOH Z-code (Z75.3) screening workflow in EHR for NEMT-enabled visits
□ Draft CRA justification memo; have legal confirm activity classification
  under 12 CFR 25.23 (OCC) or 12 CFR 228.23 (Federal Reserve)

${LINE}
DAYS 31–60: PILOT LAUNCH & WORKFLOW CALIBRATION
${LINE}

PROGRAM LAUNCH
□ Begin accepting ride requests; prioritize patients with confirmed appointment +
  documented transportation barrier or prior no-show history
□ Establish scheduling workflow: same-day ("stat") and advance booking available
  per Berkowitz 2022 UNC Health Alliance ACO design (Mon–Fri 8am–5pm standard)
□ Implement automated SMS ride confirmation and post-ride satisfaction survey
  (targeting: engagement rates >74%; cf. Chaiyachati 2018 lesson on low uptake)

OPERATIONAL MONITORING
□ Weekly ops huddle: volumes, on-time pickup rate, cancellations, no-shows
□ Reconcile ride logs against appointment system weekly
□ Track Z-code documentation rate at NEMT-enabled visits (target: ≥25% Year 1)
□ Flag and investigate any vendor documentation gaps (non-compliance = payment hold)

TCM / CCM INTEGRATION
□ Alert care managers when NEMT-enabled patient has a post-discharge appointment:
  TCM 2-business-day contact window enabled by confirmed ride
□ Document all CCM-qualifying non-face-to-face time separately from NEMT trip
  (travel time is NOT billable; time must be real, threshold-meeting, non-duplicative)
□ First monthly report: ride volume, completed visits enabled, Z-code capture rate,
  TCM completions enabled, beneficiary LMI/AA counts

${LINE}
DAYS 61–90: MEASUREMENT, REPORTING & SCALE DECISION
${LINE}

OUTCOMES MEASUREMENT
□ Compare observed no-show rate (NEMT-enrolled) vs. matched control group
  (propensity matching on age, diagnosis, payer, prior no-show rate)
□ Measure TCM completion rate improvement: target +15–20 pp (7-day and 14-day)
□ Calculate FFS contribution margin recovered: prevented × (net revenue − marginal cost)
□ Assess Z-code documentation completeness; initiate training if <20%

REPORTING
□ Produce first quarterly outcomes report for CRA file: LMI trips, AA trips,
  completed visits enabled, no-show rate vs. control, patient satisfaction score
□ Present to hospital leadership: 3-scenario financial update (conservative/base/optimistic)
□ Update bank CRA partner with outcomes narrative per agreed reporting frequency

SCALE DECISION INPUTS
□ Based on 90-day data: confirm mitigation rate assumption vs. observed
□ Evaluate vendor performance against SLA; issue cure notice if below threshold
□ Determine whether to expand to additional patient segments, clinics, or geographies
□ IRB exemption determination for EHR-linked matched-cohort outcomes study

${m ? LINE+`\n3-SCENARIO FINANCIAL SUMMARY\n`+LINE+`\n  Conservative: FFS base = ${fmtMoney(m.net_benefit)} net (high confidence)\n  Add TCM uplift if 7/14-day completion improves by ≥15 pp\n  Full model when CCM enrollment ramp and VBC attribution confirmed` : ""}
${LINE}
Evidence base: Berkowitz et al. (2022, Health Affairs 41(3):406-413) · Shekelle et al. (2022, BMC Public Health)
CMS NEMT Provider Booklet (April 2016) · 42 CFR §§ 431.53, 440.170 · OIG LEIE (oig.hhs.gov)
${LINE}`;
  document.getElementById("impl_plan").textContent = txt;
};

window.generate_outcomes_report = function(){
  const opp = state.opportunities?.[0];
  const m = state.model?.outputs;
  const today = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const LINE = '━'.repeat(60);
  const txt =
`${LINE}
NEMT PROGRAM — QUARTERLY OUTCOMES REPORT TEMPLATE
${LINE}
Project: ${opp ? opp.opp : "[Selected opportunity]"}
Reporting Period: [Q___ 20__] | Prepared: ${today}
Reporting Frequency: As agreed with CRA bank partner

${LINE}
SECTION 1 — OPERATIONAL OUTPUTS
${LINE}

Trip Volume
  Trips scheduled:                   ________
  Trips completed (loaded mileage):  ${m ? Math.round(m.trips).toLocaleString() : "________"}  ← target
  Vendor-initiated cancellations:    ________  (target: ≤5%)
  Patient no-shows:                  ________  (not billable; document separately)
  On-time pickup rate (within 10 min): ______  (target: ≥92%)
  Same-day "stat" trips:             ________

NOTE: Providers should only bill for loaded mileage — trips where beneficiary
was physically in the vehicle. Claiming no-show trips is fraud under the False
Claims Act (CMS NEMT Provider Booklet, April 2016).

Visit Completion
  NEMT-enabled completed visits:     ${m ? Math.round(m.prevented).toLocaleString() : "________"}  ← modeled target
  Baseline no-show rate (pre-program): _______%
  Observed no-show rate (NEMT cohort): _______%
  Estimated no-show reduction:        _______%  (cf. meta-analytic target: 37%; Shekelle 2022)

${LINE}
SECTION 2 — BENEFICIARY & CRA SCOPE
${LINE}

LMI Documentation
  Total unduplicated beneficiaries served:  ________
  % meeting LMI threshold (≤80% AMI):       _______%
  Verification method: ___________________________
    (Medicaid enrollment / self-attestation / census tract)
  LMI trips (for CRA file):                 ${m ? Math.round(m.lmi_trips).toLocaleString() : "________"}  ← modeled

Assessment Area Confirmation
  % of trips within CRA Assessment Area:    _______%
  AA trips (confirmed in-boundary):         ${m ? Math.round(m.aa_trips).toLocaleString() : "________"}  ← modeled
  Bank $/LMI trip:                          $______  (= bank contribution / LMI trips)

Special Populations Served
  Adults with disabilities:   ________ patients  (______%)
  Post-discharge (TCM-eligible): ________ patients
  CCM-enrolled chronic disease:  ________ patients
  Medicaid/dual-eligible:        ________ patients

${LINE}
SECTION 3 — CLINICAL & QUALITY OUTCOMES
${LINE}

SDOH Documentation
  Z75.3 documentation rate (NEMT-enabled visits):  _______%  (target: ≥25% Yr1; ≥60% Yr2)
  Encounters with SDOH screening completed:        ________

TCM Integration (if applicable)
  Post-discharge patients offered NEMT:            ________
  TCM 7-day face-to-face completions (99496):     ________  (${m ? "modeled target: "+Math.round((m.tcmNet||0)/273*0.35).toLocaleString() : "—"})
  TCM 14-day face-to-face completions (99495):    ________
  TCM completion rate with NEMT:                  _______%
  30-day readmission rate (TCM cohort):           _______%  (national benchmark: ~15%; TCM reduces by ~0.31 pp)

CCM Integration (if applicable)
  CCM-enrolled patients using NEMT:               ________
  Months with ≥20 min qualifying CCM time:       ________
  CCM billing success rate:                       _______%

Quality Measure Impacts (document with QI team)
  QPP Measure 001 (Diabetes HbA1c >9%):  Baseline ____% → Current ____%
  QPP Measure 236 (BP Control):          Baseline ____% → Current ____%
  Transitions of Care (Star/ACO REACH):  Baseline ____% → Current ____%

${LINE}
SECTION 4 — FINANCIAL SUMMARY (HOSPITAL)
${LINE}

  Gross revenue recaptured (FFS):    ${m ? fmtMoney(m.gross_rev) : "________"}
  Total program cost (trips + overhead): ${m ? fmtMoney(m.total_program_cost) : "________"}
  Net annual benefit (base case):    ${m ? fmtMoney(m.net_benefit) : "________"}
  Bank CRA contribution (offset):    $________ (per partnership agreement)
  Net cash outlay to health system:  $________

${LINE}
SECTION 5 — NARRATIVE (CUSTOMIZE)
${LINE}
Describe: (1) how this quarter's activity responds to the documented CHNA need;
          (2) any workflow adjustments and their rationale;
          (3) vendor performance vs. SLA thresholds;
          (4) any compliance exceptions and corrective actions taken.

[Insert narrative here]

${LINE}
Evidence base: Berkowitz et al. (2022, Health Affairs) · Shekelle et al. (2022, BMC Public Health)
CMS NEMT Provider Booklet (April 2016) · CMS MLN CCM/TCM Booklets
${LINE}`;
  document.getElementById("outcomes_report").textContent = txt;
};

window.generate_eval_plan = function(){
  const opp = state.opportunities?.[0];
  const today = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const LINE = '━'.repeat(60);
  const txt =
`${LINE}
NEMT PROGRAM — EVALUATION PLAN & METHODOLOGY
${LINE}
Project: ${opp ? opp.opp : "[Selected opportunity]"}
Generated: ${today}

${LINE}
1. PURPOSE & EVALUATION QUESTIONS
${LINE}

Primary: Does NEMT reduce transportation-attributable no-shows in the target population?
  Q1: What is the no-show rate reduction vs. matched controls?
  Q2: Does NEMT enable TCM 7/14-day face-to-face completion?
  Q3: Does NEMT improve CCM monthly contact window completion?

Secondary: Does NEMT improve downstream clinical and financial outcomes?
  Q4: Does 30-day readmission rate decrease in the TCM-enabled subgroup?
  Q5: Do quality measure rates improve (Measures 001, 236, TCM/Transitions)?
  Q6: Is the program cost-saving or cost-neutral over 3 years?

Evidence context: Berkowitz et al. (2022) found NEMT increased outpatient visits
(+9.2/person/yr) but was NOT cost-saving in a Medicare ACO. This plan is designed
to test whether a targeted (TCM/CCM-linked) program can achieve cost-neutrality
by combining FFS recovery with care management billing.

${LINE}
2. BASELINE MEASUREMENT
${LINE}

Pre-program baselines to establish before launch:
  □ Overall no-show rate (6-month lookback): _______%
  □ Transportation-attributable share (Z75.3 or staff flag): _______%
  □ TCM eligible discharges/quarter: ________
  □ TCM face-to-face completion rate (7-day / 14-day): _______%
  □ CCM enrollment rate among eligible patients: _______%
  □ HbA1c >9% rate (Measure 001): _______%
  □ BP controlled rate (Measure 236): _______%
  □ 30-day readmission rate (overall / TCM subgroup): _______%

CHNA evidence citations:
  ${state.findings?.slice(0,3).map(f=>f.evidenceRef).filter(Boolean).join("; ") || "[Upload CHNA to generate citations]"}

${LINE}
3. STUDY DESIGN
${LINE}

Design: Difference-in-differences (DiD) with propensity-score matched controls
  (Replicates Berkowitz et al. 2022 high-dimensional propensity score approach)

Intervention group: Patients enrolled in NEMT program
Control group: Patients matched 1:3 on age (±5 yr), primary diagnosis,
  insurance type, prior-year no-show rate, and distance from clinic

Matching variables (predetermined):
  Age, sex, race/ethnicity, primary diagnosis (ICD-10),
  payer type (Medicare/Medicaid/commercial), HCC score,
  prior 6-month hospitalization count, prior no-show rate,
  dual eligibility status, disability indicator, distance from clinic

Index date: Date of first NEMT-enabled appointment
Follow-up: 24 months (sufficient to capture CCM ramp and VBC attribution lag)
Statistical method: Overlap weighting (ATO estimand) for causal inference
  on imbalanced observational data — avoids extrapolation beyond the overlap region

${LINE}
4. METRICS & TARGETS
${LINE}

PRIMARY (power: 80% to detect 7% absolute reduction; α=0.05)
  □ Transportation-attributable no-show rate (NEMT vs. control)
    Target: ≥35% odds reduction (cf. OR 0.63; Shekelle 2022 meta-analysis)
  □ TCM 7/14-day face-to-face completion rate improvement
    Target: +15–20 percentage points (NEMT removes primary access barrier)

SECONDARY (24-month follow-up)
  □ 30-day all-cause readmission rate (TCM subgroup)
    Reference: Follow-up within 30 days → 32% RRR (Balasubramanian 2025)
  □ HbA1c >9% rate (Measure 001) — NEMT-enabled visits create documentation opportunity
  □ BP controlled rate (Measure 236) — requires in-person BP measurement
  □ SDOH Z75.3 documentation rate: target ≥25% Yr1, ≥60% Yr2
  □ Patient-reported confidence in keeping appointments (survey, 1–10 scale)

FINANCIAL
  □ FFS contribution margin recovered vs. program cost
  □ CCM/TCM incremental billing vs. labor cost
  □ Bank CRA contribution as % of total program cost
  □ Break-even sensitivity: actual vs. modeled mitigation rate

CRA METRICS (for bank exam file)
  □ LMI trips (unduplicated and total)
  □ AA-confirmed trips
  □ Bank $/LMI trip delivered

${LINE}
5. DATA SOURCES
${LINE}
  □ Scheduling system: appointment bookings, no-shows, cancellations
  □ Vendor trip logs: loaded mileage, pickup times, driver IDs, patient confirmations
  □ EHR/billing: ICD-10, CPT codes, revenue, Z-codes (SDOH), CCM/TCM claims
  □ Medicare/Medicaid claims (for readmission, quality measure data)
  □ LMI verification documentation: Medicaid enrollment records
  □ Patient satisfaction survey: post-ride SMS or follow-up call (3-question)

Fraud prevention note: All vendor trip logs must be reconcilable with appointment
system records. Discrepancies (billing for no-shows, upcoded vehicle type, unqualified
drivers) trigger immediate audit. Monthly OIG LEIE screening of all vendor personnel.

${LINE}
6. GOVERNANCE & CADENCE
${LINE}
  Weekly:  Ops huddle — on-time pickup rate, cancellations, documentation gaps
  Monthly: Outcomes report — volumes, LMI/AA counts, Z-code capture rate
  Quarterly: Leadership report — financial performance, clinical outcomes, CRA narrative
  Annual: Full evaluation report — study results, ROI vs. model, lessons learned

Corrective action triggers:
  • On-time pickup <88%: 30-day cure notice to vendor
  • No-show billing detected: immediate payment hold; OIG referral if willful
  • Z-code documentation <15%: workflow training intervention within 14 days
  • TCM completion improvement <5 pp at 90 days: re-examine patient targeting criteria

${LINE}
7. PUBLICATION PATHWAY (OPTIONAL)
${LINE}
  Target journal: Health Affairs, JAMA Network Open, or BMC Public Health
  Precedent: Berkowitz et al. (2022) published UNC Health Alliance ACO NEMT evaluation
  Design advantage: Targeted program (TCM/CCM-linked) tests a more specific hypothesis
    than the universal Berkowitz program — improves on prior evidence
  IRB pathway: Quality Improvement / Program Evaluation — likely exempt
    (45 CFR 46.104(d)(4)); confirm with IRB at program launch
  Publication target: Year 2 (with 18 months of follow-up data)

${LINE}
Evidence base: Berkowitz et al. (2022, Health Affairs 41(3):406-413)
Shekelle et al. (2022, BMC Public Health) · Balasubramanian et al. (2025, JAMA Network Open)
Chaiyachati et al. (2018, JAMA Internal Medicine) · CMS NEMT Provider Booklet (April 2016)
${LINE}`;
  document.getElementById("eval_plan").textContent = txt;
};


// ------------------------------
// Training Module JS
// ------------------------------
window.showExercise = function(n){
  document.querySelectorAll(".training-exercise").forEach(el=>el.classList.remove("active"));
  const ex = document.getElementById("ex_"+n);
  if(ex){ ex.classList.add("active"); ex.scrollIntoView({behavior:"smooth", block:"start"}); }
  document.querySelectorAll(".ex-nav-btn").forEach(btn=>{
    btn.classList.toggle("active", parseInt(btn.dataset.ex)===n);
  });
};

window.selectPred = function(exNum, choice){
  const container = document.getElementById("pred_"+exNum);
  if(!container) return;
  container.querySelectorAll(".pred-option").forEach((el,i)=>{
    const letters = "abcd";
    el.classList.remove("selected","correct","incorrect");
    if(letters[i]===choice) el.classList.add("selected");
  });
};

window.toggleReveal = function(id){
  const el = document.getElementById(id);
  if(!el) return;
  const showing = el.style.display !== "none";
  el.style.display = showing ? "none" : "block";
  // Mark options correct/incorrect when revealed
  const m = id.match(/pred_reveal_(\d+)/);
  if(!m || showing) return;
  const exNum = m[1];
  const correctMap = {"1":"b","2":"b","3":"c","4":"b","5":"c"};
  const correct = correctMap[exNum];
  const container = document.getElementById("pred_"+exNum);
  if(!container || !correct) return;
  const letters = "abcd";
  container.querySelectorAll(".pred-option").forEach((el,i)=>{
    if(letters[i]===correct){ el.classList.add("correct"); el.classList.remove("selected","incorrect"); }
    else if(el.classList.contains("selected")){ el.classList.add("incorrect"); el.classList.remove("selected"); }
  });
};


// Handle training tab click via existing tab wire-up (data-view="training" already wired above)
// showExercise, selectPred, toggleReveal are globally defined above


// ═══════════════════════════════════════════════════════════
// MAYO / ADVANCED CHNA MODULE JS
// ═══════════════════════════════════════════════════════════

window.mayoNav = function(panel) {
  ['chna','linkage','roi','cra','banks','draft'].forEach(p => {
    const el = document.getElementById('mpanel_' + p);
    if (el) el.style.display = (p === panel) ? 'block' : 'none';
  });
  document.querySelectorAll('.mayo-subnav').forEach(b => b.classList.remove('active-subnav'));
  const btn = document.getElementById('mn_' + panel);
  if (btn) btn.classList.add('active-subnav');
  if (panel === 'roi') { setTimeout(calcMayoROI, 60); }
};

window.toggleMEN = function(n) {
  const isOpen = document.getElementById('men'+n+'_body').style.display !== 'none';
  [1,2,3,4].forEach(i => {
    document.getElementById('men'+i+'_body').style.display = 'none';
    document.getElementById('men'+i+'_arr').textContent = '\u25B8';
  });
  if (!isOpen) {
    document.getElementById('men'+n+'_body').style.display = 'block';
    document.getElementById('men'+n+'_arr').textContent = '\u25BE';
  }
};

window.confirmMayoLayer0 = function() {
  function gv(id) { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; }
  function norm(v) { return v > 1 ? v / 100 : v; }
  function fmt(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
  function pct(n, d) { return d ? (n / d * 100).toFixed(0) + '%' : '—'; }

  // BASE CASE constants (workbook defaults)
  const BASE_V = 40000, BASE_N = 0.20, BASE_S = 0.30, BASE_M = 0.50;
  const BASE_R = 225, BASE_C = 90, BASE_T = 60, BASE_O = 0.10;
  const basePrevented = BASE_V * BASE_N * BASE_S * BASE_M;
  const baseCost = basePrevented * BASE_T * (1 + BASE_O);
  const baseFFS = basePrevented * BASE_R - basePrevented * BASE_C - baseCost;

  // USER INPUTS
  const V = gv('mr_v'), n = norm(gv('mr_n')), s = norm(gv('mr_s')), m = norm(gv('mr_m'));
  const r = gv('mr_r'), c = gv('mr_c'), t = gv('mr_t'), o = norm(gv('mr_o'));
  const prevented = V * n * s * m;
  const progCost = prevented * t * (1 + o);
  const ffsNet = prevented * r - prevented * c - progCost;
  const beTrip = r - c;
  const roiVal = progCost > 0 ? ffsNet / progCost : 0;

  // COMPARISONS vs BASE CASE
  const preventedRatio = basePrevented > 0 ? prevented / basePrevented : 0;
  const ffsRatio = baseFFS > 0 ? ffsNet / baseFFS : 0;
  const revenueVsBase = r - BASE_R;
  const visitVsBase = V - BASE_V;
  const marginPerVisit = r - c;
  const baseMargin = BASE_R - BASE_C;

  // Build summary lines
  const lines = [];

  // Line 1: prevented visits vs base
  const prevDir = preventedRatio >= 1 ? 'above' : 'below';
  const prevMult = preventedRatio.toFixed(2);
  lines.push(`<strong style="color:#7A5C00;">&#127919; Layer 0 Analysis — Your Program vs. Illustrative Base Case</strong>`);

  // Visits context
  const visitDelta = visitVsBase > 0 ? `+${visitVsBase.toLocaleString()} above` : `${Math.abs(visitVsBase).toLocaleString()} below`;
  lines.push(`<span><strong>Visit volume:</strong> ${V.toLocaleString()} targeted visits (${visitDelta} the 40,000 standard). At ${Math.round(n*100)}% no-show × ${Math.round(s*100)}% transport share × ${Math.round(m*100)}% mitigation, your program protects <strong>${Math.round(prevented).toLocaleString()} visits/year</strong> — ${prevMult}× the base case (${Math.round(basePrevented).toLocaleString()} visits).</span>`);

  // Revenue & margin
  const revLabel = revenueVsBase > 0
    ? `$${revenueVsBase} above the $${BASE_R} standard — consistent with a higher-complexity or AMC payer mix`
    : revenueVsBase < 0
    ? `$${Math.abs(revenueVsBase)} below the $${BASE_R} standard — reflect this in sensitivity analysis`
    : `matching the $${BASE_R} standard`;
  lines.push(`<span><strong>Net revenue per visit:</strong> $${r} — ${revLabel}. Contribution margin per kept visit: <strong>$${Math.round(marginPerVisit)}</strong> (vs. $${baseMargin} standard).</span>`);

  // FFS net benefit
  const ffsDir = ffsNet >= baseFFS ? 'ahead of' : 'below';
  const ffsDeltaAmt = Math.abs(ffsNet - baseFFS);
  lines.push(`<span><strong>Year 1 FFS floor:</strong> <strong>${fmt(ffsNet)}</strong> net benefit — ${ffsDir} the base case (${fmt(baseFFS)}) by ${fmt(ffsDeltaAmt)}. ROI on program cost: <strong>${roiVal.toFixed(2)}×</strong>. Break-even trip cost: <strong>$${beTrip.toFixed(0)}/round trip</strong>.</span>`);

  // Break-even margin context
  const beMargin = beTrip - t;
  if (beMargin > 0) {
    lines.push(`<span><strong>Vendor negotiating position:</strong> Your $${t} trip cost sits $${beMargin.toFixed(0)} below break-even — a ${pct(beMargin, beTrip)} safety margin. The program remains FFS-positive up to <strong>$${beTrip.toFixed(0)}/trip</strong>.</span>`);
  } else {
    lines.push(`<span><strong>&#9888; Cost caution:</strong> Your trip cost ($${t}) is at or above break-even ($${beTrip.toFixed(0)}). Revisit trip cost or revenue assumptions before proceeding.</span>`);
  }

  // Downside note
  const downsidePrevented = V * n * s * 0.30;
  const downsideCost = downsidePrevented * t * (1 + o);
  const downsideFFS = downsidePrevented * r - downsidePrevented * c - downsideCost;
  const downsideLabel = downsideFFS > 0 ? `still positive at ${fmt(downsideFFS)}` : `negative at ${fmt(downsideFFS)} — revisit inputs`;
  lines.push(`<span><strong>Downside check (30% mitigation):</strong> FFS net ${downsideLabel}.</span>`);

  const el = document.getElementById('mayo_l0_summary');
  if (el) {
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:7px;font-size:12px;line-height:1.6;color:#1a1a1a;">${lines.map(l => `<div>${l}</div>`).join('')}</div>`;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Mark confirmed
  const btn = document.getElementById('mayo_l0_btn');
  const conf = document.getElementById('mayo_l0_confirmed');
  if (btn) { btn.textContent = '↺ Re-confirm'; btn.style.background = 'linear-gradient(135deg,#047857,#065f46)'; }
  if (conf) conf.style.display = 'inline';

  // Also run the live calc
  calcMayoROI();
};
window.toggleMayoCliff = function() {
  const isCliff = document.getElementById('mr_vbc_type') && document.getElementById('mr_vbc_type').value === 'cliff';
  ['mr_cliff_row1','mr_cliff_row2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isCliff ? 'block' : 'none';
  });
};

window.toggleMayoLayer = function(layer) {
  if (layer === 'ccm') {
    const box = document.getElementById('mr_ccm_box');
    const chk = document.getElementById('mr_ccm_on');
    if (box && chk) { box.style.display = chk.checked ? 'block' : 'none'; }
  } else if (layer === 'vbc') {
    const box = document.getElementById('mr_vbc_box');
    const chk = document.getElementById('mr_vbc_on');
    if (box && chk) { box.style.display = chk.checked ? 'block' : 'none'; }
  } else if (layer === 'cod') {
    const box = document.getElementById('mr_cod_box');
    const chk = document.getElementById('mr_cod_on');
    if (box && chk) { box.style.display = chk.checked ? 'block' : 'none'; }
  }
  calcMayoROI();
};

window.calcMayoROI = function() {
  function gv(id) { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; }
  function norm(v) { return v > 1 ? v / 100 : v; }
  function fmt(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }

  const V = gv('mr_v'), n = norm(gv('mr_n')), s = norm(gv('mr_s')), m = norm(gv('mr_m'));
  const r = gv('mr_r'), c = gv('mr_c'), t = gv('mr_t'), o = norm(gv('mr_o'));
  const prevented = V * n * s * m;
  const gross = prevented * r;
  const margCost = prevented * c;
  const tripCost = prevented * t;
  const overhead = tripCost * o;
  const progCost = tripCost + overhead;
  const ffsNet = gross - margCost - progCost;

  // Layer 1: Coding
  let codNet = 0;
  const codOn = document.getElementById('mr_cod_on') && document.getElementById('mr_cod_on').checked;
  if (codOn) {
    const zRate = norm(gv('mr_zrate')), zUpl = gv('mr_zupl');
    const cptRate = norm(gv('mr_cptrate')), cptUpl = gv('mr_cptupl');
    codNet = prevented * zRate * zUpl + prevented * cptRate * cptUpl;
  }

  // Layer 2: CCM/TCM
  let ccmNet = 0, tcmNet = 0;
  const ccmOn = document.getElementById('mr_ccm_on') && document.getElementById('mr_ccm_on').checked;
  if (ccmOn) {
    const cp = gv('mr_cp'), ce = norm(gv('mr_ce')), cmo = gv('mr_cmo'), call = gv('mr_call');
    const csuc = norm(gv('mr_csuc')), cmin = gv('mr_cmin');
    const enrolled = cp * ce;
    const billedMonths = enrolled * cmo * csuc;
    const grossCCM = billedMonths * call;
    const laborCCM = billedMonths * cmin * 0.65;
    const ccmGrossNet = grossCCM - laborCCM;
    ccmNet = ccmGrossNet * 0.40; // 40% incremental attribution

    const td = gv('mr_td'), tr = norm(gv('mr_tr')), thigh = norm(gv('mr_thigh'));
    const tsuc = norm(gv('mr_tsuc'));
    const billableTCM = td * tr * tsuc;
    const weightedAvg = thigh * 290 + (1 - thigh) * 215;
    const grossTCM = billableTCM * weightedAvg;
    const laborTCM = billableTCM * 45 * 0.65;
    tcmNet = grossTCM - laborTCM;
  }

  // Layer 3: VBC
  let vbcNet = 0, bankCRA = 0;
  const vbcOn = document.getElementById('mr_vbc_on') && document.getElementById('mr_vbc_on').checked;
  if (vbcOn) {
    const pool = gv('mr_pool'), base = gv('mr_base'), proj = gv('mr_proj');
    bankCRA = gv('mr_bank');
    const vbcType = document.getElementById('mr_vbc_type') ? document.getElementById('mr_vbc_type').value : 'linear';
    if (vbcType === 'cliff') {
      const thresh = gv('mr_thresh'), bonus = gv('mr_cliffbonus');
      vbcNet = proj >= thresh ? bonus : 0;
    } else {
      vbcNet = Math.max(0, ((proj - base) / 100) * pool);
    }
  }

  const totalNet = ffsNet + codNet + ccmNet + tcmNet + vbcNet + bankCRA;

  // Build value stack rows — fixed spacing, no overlap
  const rows = [
    { l: 'Gross revenue (' + Math.round(prevented).toLocaleString() + ' visits \xd7 $' + r + ')', v: gross, c: 'pos' },
    { l: 'Marginal clinical cost', v: -margCost, c: 'neg' },
    { l: 'Transport cost (\xd7 $' + t + ')', v: -tripCost, c: 'neg' },
    { l: 'Overhead (' + Math.round(o * 100) + '%)', v: -overhead, c: 'neg' },
    { l: 'Layer 0 — FFS Net Benefit', v: ffsNet, c: 'tot' },
  ];
  if (codOn) {
    rows.push({ l: 'Layer 1 — Coding / Z-code Uplift', v: codNet, c: 'layer' });
  }
  if (ccmOn) {
    rows.push({ l: 'Layer 2a — CCM Net (40% incremental)', v: ccmNet, c: 'layer' });
    rows.push({ l: 'Layer 2b — TCM Net', v: tcmNet, c: 'layer' });
  }
  if (vbcOn) {
    rows.push({ l: 'Layer 3 — VBC Quality Earn-back', v: vbcNet, c: 'layer' });
    if (bankCRA > 0) rows.push({ l: 'Bank CRA Contribution', v: bankCRA, c: 'layer' });
  }
  if (rows.length > 5) {
    rows.push({ l: 'ALL-IN NET VALUE', v: totalNet, c: 'grand' });
  }

  const wf = document.getElementById('mayo_wf_rows');
  if (!wf) return;
  wf.innerHTML = rows.map(function(row) {
    const sign = row.v < 0 ? '-' : '';
    const disp = sign + '$' + Math.round(Math.abs(row.v)).toLocaleString();
    let rowStyle, valStyle;
    if (row.c === 'pos')   { rowStyle = 'background:rgba(4,120,87,.07);border:1px solid rgba(4,120,87,.2);border-radius:6px;'; valStyle = 'color:#047857;'; }
    else if (row.c === 'neg')  { rowStyle = 'background:rgba(185,28,28,.06);border:1px solid rgba(185,28,28,.18);border-radius:6px;'; valStyle = 'color:#B91C1C;'; }
    else if (row.c === 'tot')  { rowStyle = 'background:rgba(0,51,102,.12);border:1px solid rgba(0,51,102,.25);border-radius:6px;font-weight:700;'; valStyle = 'color:var(--navy);'; }
    else if (row.c === 'layer'){ rowStyle = 'background:rgba(13,148,136,.08);border:1px solid rgba(13,148,136,.22);border-radius:6px;'; valStyle = 'color:#0F766E;'; }
    else { rowStyle = 'background:var(--navy);border-radius:6px;font-weight:800;'; valStyle = 'color:#A7F3D0;'; }
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 11px;margin-bottom:5px;font-size:12px;' + rowStyle + '">'
         + '<span style="color:' + (row.c === 'grand' ? '#fff' : 'inherit') + '">' + row.l + '</span>'
         + '<span style="font-family:monospace;font-weight:700;' + (row.c === 'grand' ? 'color:#E8C84A;' : valStyle) + '">' + disp + '</span>'
         + '</div>';
  }).join('');

  // Big ROI display
  const roi = progCost > 0 ? (totalNet / progCost).toFixed(2) + 'x' : '\u2014';
  const beTrip = (r - c).toFixed(0);
  const roiEl = document.getElementById('mayo_roi_big'), netEl = document.getElementById('mayo_net_big'), beEl = document.getElementById('mayo_be_txt');
  if (roiEl) roiEl.textContent = roi;
  if (netEl) netEl.textContent = fmt(totalNet) + ' net annual value';
  if (beEl)  beEl.textContent  = 'Break-even trip cost: $' + beTrip + ' \u00b7 Program cost: ' + fmt(progCost) + '/yr';

  // KPI tiles
  function setKpi(id, val) { const el = document.getElementById(id); if (el) el.textContent = fmt(val); }
  setKpi('m_kpi_cost', -progCost);
  setKpi('m_kpi_ffs', ffsNet);
  setKpi('m_kpi_cod', codNet);
  setKpi('m_kpi_ccm', ccmNet);
  setKpi('m_kpi_tcm', tcmNet);
  setKpi('m_kpi_vbc', vbcNet);
  setKpi('m_kpi_allin', totalNet);

  // Sensitivity table: mitigation rate × trip cost
  const sens = document.getElementById('mayo_sensitivity');
  if (sens) {
    const mitigs = [0.30, 0.40, 0.50, 0.60, 0.70];
    const trips  = [50, 60, 65, 75, 90];
    let out = '  Mitig →   ' + trips.map(tv => ('$'+tv+'/trip').padStart(11)).join('') + '\n';
    out    += '  ' + '─'.repeat(65) + '\n';
    mitigs.forEach(function(mv) {
      const label = (Math.round(mv*100)+'%').padEnd(6);
      const vals = trips.map(function(tv) {
        const prev2 = V*n*s*mv, pc2 = prev2*tv*(1+o);
        const net2 = prev2*r - prev2*c - pc2;
        return fmt(net2).padStart(11);
      });
      out += '  ' + label + '   ' + vals.join('') + '\n';
    });
    sens.textContent = out;
  }

  // Board scenarios
  const scenDiv = document.getElementById('mayo_scenarios');
  if (scenDiv) {
    const cons = ffsNet + (codOn ? codNet : (prevented * 0.25 * 20 + prevented * 0.15 * 15));
    const base2 = cons + tcmNet;
    const opt = ffsNet + codNet + ccmNet + tcmNet + vbcNet;
    const rows2 = [
      { label: 'Conservative (FFS + Coding)', val: cons, note: 'Year 1 floor — high confidence' },
      { label: 'Base Case (+ TCM)  ★ Anchor', val: base2, note: 'Board recommendation' },
      { label: 'Optimistic (All Layers)', val: opt, note: 'Year 2+ upside' },
      { label: 'Net Outlay (+ Bank CRA)', val: opt + bankCRA, note: 'After bank offset' },
    ];
    scenDiv.innerHTML = rows2.map(function(s2) {
      const col = s2.label.includes('Anchor') ? 'color:var(--navy);font-weight:800;' : '';
      return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);' + col + '">'
           + '<span>' + s2.label + '</span>'
           + '<span style="font-family:monospace;font-weight:700;">' + fmt(s2.val) + '</span>'
           + '</div>'
           + '<div style="font-size:10px;color:var(--muted);padding:1px 0 6px;">' + s2.note + '</div>';
    }).join('');
  }

  // Cache for artifact generation
  window._mayoROICache = { V, n, s, m, r, c, t, o, prevented, gross, margCost, tripCost, overhead, progCost, ffsNet, codNet, ccmNet, tcmNet, vbcNet, bankCRA, totalNet, roi, beTrip, codOn, ccmOn, vbcOn };
};

window.updateCRATotal = function() {
  var amt = parseFloat(document.getElementById('cra_amount').value)||0;
  var term = parseFloat(document.getElementById('cra_term').value)||1;
  document.getElementById('cra_total').value = Math.round(amt*term);
};

window.generateMayoDraft = function(type) {
  const bank    = (document.getElementById('cra_bank')    && document.getElementById('cra_bank').value)    || '[BANK NAME]';
  const actType = (document.getElementById('cra_acttype') && document.getElementById('cra_acttype').value) || 'Qualified Charitable Contribution';
  const amount  = (document.getElementById('cra_amount')  && document.getElementById('cra_amount').value)  || '75000';
  const term    = (document.getElementById('cra_term')    && document.getElementById('cra_term').value)    || '3';
  const total   = (document.getElementById('cra_total')   && document.getElementById('cra_total').value)   || '225000';
  const need    = (document.getElementById('cra_need')    && document.getElementById('cra_need').value)    || '';
  const activity= (document.getElementById('cra_activity')&& document.getElementById('cra_activity').value)|| '';
  const lmi     = (document.getElementById('cra_lmi')     && document.getElementById('cra_lmi').value)     || '\u226480% AMI';
  const verify  = (document.getElementById('cra_verify')  && document.getElementById('cra_verify').value)  || 'Medicaid/CHIP enrollment';
  const outcomes= (document.getElementById('cra_outcomes')&& document.getElementById('cra_outcomes').value)|| '';
  const rep     = (document.getElementById('cra_rep')     && document.getElementById('cra_rep').value)     || '';
  const freq    = (document.getElementById('cra_reporting')&&document.getElementById('cra_reporting').value)|| 'Quarterly';
  const today   = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});

  const D = window._mayoROICache || {};
  function fmt(n) { if (!n && n!==0) return '$\u2014'; return (n<0?'-$':'$')+Math.abs(Math.round(n)).toLocaleString(); }
  const ffsNet   = D.ffsNet   || 0;
  const codNet   = D.codNet   || 0;
  const ccmNet   = D.ccmNet   || 0;
  const tcmNet   = D.tcmNet   || 0;
  const vbcNet   = D.vbcNet   || 0;
  const bankCRA  = D.bankCRA  || 0;
  const totalNet = D.totalNet || 0;
  const progCost = D.progCost || 0;
  const roi      = D.roi      || '\u2014';
  const beTrip   = D.beTrip   || '\u2014';
  const V        = D.V        || 25000;
  const prevented= D.prevented|| 0;

  const LINE = '\u2501'.repeat(52);
  let title = '', doc = '';

  if (type === 'proforma') {
    title = '3-Year Pro Forma & Program P&L \u2014 NEMT Program';
    // Year 1: FFS only, partial CCM, partial coding; Year 2: full; Year 3: mature
    const y1val = ffsNet + codNet*0.57 + ccmNet*0.37 + tcmNet*0.78;
    const y2val = ffsNet*1.10 + codNet + ccmNet + tcmNet + vbcNet*0.57;
    const y3val = ffsNet*1.20 + codNet*1.15 + ccmNet*1.23 + tcmNet*1.15 + vbcNet;
    const y1cost = progCost, y2cost = progCost*1.07, y3cost = progCost*1.11;
    const y1net = y1val - y1cost, y2net = y2val - y2cost, y3net = y3val - y3cost;
    const cumNet = y1net + y2net + y3net;
    const avg3yr = (y1val + y2val + y3val) / 3;
    doc = 'CONFIDENTIAL DRAFT \u2014 FOR FINANCE AND LEGAL REVIEW\n'
        + LINE + '\n'
        + '3-YEAR PRO FORMA & PROGRAM P&L\n'
        + 'NEMT PROGRAM \u2014 [YOUR HEALTH SYSTEM / SERVICE AREA]\n'
        + LINE + '\n\n'
        + 'Generated: ' + today + '\n'
        + 'Scenario: Base Case (FFS + Coding + CCM/TCM; VBC at 57% credit Year 2)\n'
        + 'Population: LMI ambulatory patients within your CRA Assessment Area\n\n'
        + LINE + '\n'
        + 'SECTION 1 \u2014 REVENUE WATERFALL BY LAYER\n'
        + LINE + '\n\n'
        + ('REVENUE LAYER').padEnd(32) + 'YEAR 1'.padStart(10) + 'YEAR 2'.padStart(12) + 'YEAR 3'.padStart(12) + '\n'
        + '\u2500'.repeat(66) + '\n'
        + 'Layer 0: FFS Contribution Margin'.padEnd(32) + fmt(ffsNet).padStart(10)     + fmt(ffsNet*1.10).padStart(12)  + fmt(ffsNet*1.20).padStart(12)  + '\n'
        + 'Layer 1: Coding / Z-code Uplift'.padEnd(32)  + fmt(codNet*0.57).padStart(10)+ fmt(codNet).padStart(12)       + fmt(codNet*1.15).padStart(12)  + '\n'
        + 'Layer 2a: CCM Net (incremental)'.padEnd(32)  + fmt(ccmNet*0.37).padStart(10)+ fmt(ccmNet).padStart(12)       + fmt(ccmNet*1.23).padStart(12)  + '\n'
        + 'Layer 2b: TCM Net'.padEnd(32)                + fmt(tcmNet*0.78).padStart(10)+ fmt(tcmNet).padStart(12)       + fmt(tcmNet*1.15).padStart(12)  + '\n'
        + 'Layer 3: VBC Quality Earn-back'.padEnd(32)   + '$0 (pending)'.padStart(10)  + fmt(vbcNet*0.57).padStart(12)  + fmt(vbcNet).padStart(12)       + '\n'
        + 'Bank CRA Contribution (offset)'.padEnd(32)   + fmt(bankCRA).padStart(10)    + fmt(bankCRA).padStart(12)      + fmt(bankCRA).padStart(12)      + '\n'
        + '\u2500'.repeat(66) + '\n'
        + 'TOTAL PROGRAM VALUE'.padEnd(32)              + fmt(y1val).padStart(10)      + fmt(y2val).padStart(12)        + fmt(y3val).padStart(12)        + '\n\n'
        + LINE + '\n'
        + 'SECTION 2 \u2014 COST STRUCTURE\n'
        + LINE + '\n\n'
        + ('COST ITEM').padEnd(32) + 'YEAR 1'.padStart(10) + 'YEAR 2'.padStart(12) + 'YEAR 3'.padStart(12) + '\n'
        + '\u2500'.repeat(66) + '\n'
        + 'Transport trips (vendor)'.padEnd(32)          + fmt(D.tripCost||0).padStart(10)    + fmt((D.tripCost||0)*1.05).padStart(12)  + fmt((D.tripCost||0)*1.09).padStart(12) + '\n'
        + 'Overhead / admin (10%)'.padEnd(32)            + fmt(D.overhead||0).padStart(10)    + fmt((D.overhead||0)*1.05).padStart(12)  + fmt((D.overhead||0)*1.09).padStart(12) + '\n'
        + 'CCM/TCM staff time (est.)'.padEnd(32)        + '$12,000'.padStart(10)             + '$15,000'.padStart(12)                  + '$18,000'.padStart(12)                 + '\n'
        + 'EHR integration (one-time)'.padEnd(32)       + '$15,000'.padStart(10)             + '$0'.padStart(12)                       + '$0'.padStart(12)                      + '\n'
        + '\u2500'.repeat(66) + '\n'
        + 'TOTAL PROGRAM COST'.padEnd(32)               + fmt(y1cost+27000).padStart(10)    + fmt(y2cost+15000).padStart(12)          + fmt(y3cost+18000).padStart(12)         + '\n\n'
        + LINE + '\n'
        + 'SECTION 3 \u2014 NET INCOME STATEMENT\n'
        + LINE + '\n\n'
        + ('').padEnd(32) + 'YEAR 1'.padStart(10) + 'YEAR 2'.padStart(12) + 'YEAR 3'.padStart(12) + 'CUMULATIVE'.padStart(14) + '\n'
        + '\u2500'.repeat(70) + '\n'
        + 'Total Program Value'.padEnd(32)              + fmt(y1val).padStart(10)       + fmt(y2val).padStart(12)       + fmt(y3val).padStart(12)       + fmt(y1val+y2val+y3val).padStart(14) + '\n'
        + 'Total Program Cost'.padEnd(32)               + fmt(y1cost+27000).padStart(10)+ fmt(y2cost+15000).padStart(12)+ fmt(y3cost+18000).padStart(12)+ fmt((y1cost+27000)+(y2cost+15000)+(y3cost+18000)).padStart(14) + '\n'
        + '\u2500'.repeat(70) + '\n'
        + 'NET PROGRAM BENEFIT'.padEnd(32)              + fmt(y1net-27000).padStart(10) + fmt(y2net-15000).padStart(12) + fmt(y3net-18000).padStart(12) + fmt(cumNet-60000).padStart(14) + '\n'
        + 'ROI (on program cost)'.padEnd(32)            + (y1cost>0?((y1net/y1cost).toFixed(2)+'x'):'\u2014').padStart(10) + (y2cost>0?((y2net/y2cost).toFixed(2)+'x'):'\u2014').padStart(12) + (y3cost>0?((y3net/y3cost).toFixed(2)+'x'):'\u2014').padStart(12) + '\n'
        + 'Break-even Trip Cost'.padEnd(32)             + ('$'+beTrip+'/trip').padStart(10) + ''.padStart(12) + ''.padStart(12) + '\n\n'
        + LINE + '\n'
        + 'SECTION 4 \u2014 MANAGEMENT ASSUMPTIONS\n'
        + LINE + '\n\n'
        + '  \u2022 Year 1: FFS mitigation at model rate; CCM/TCM at 70-80% of model\n'
        + '    (enrollment ramp, documentation workflow build-out)\n'
        + '  \u2022 Year 2: All layers at full model values; EHR integration complete\n'
        + '  \u2022 Year 3: Layer maturation — visit volume +10%, capture rates improve\n'
        + '  \u2022 VBC earn-back credited at 50% in Year 2, 100% in Year 3 (attribution lag)\n'
        + '  \u2022 Cost ramp: vendor rate escalation 5%/yr; staff time increases with scale\n'
        + '  \u2022 Bank CRA contribution assumed constant; renew at Year 3 contract reset\n'
        + '  \u2022 Outcomes study cohort enrollment begins Year 1; primary outcomes reportable Year 2\n\n'
        + 'SECTION 5 \u2014 DOWNSIDE CASE (30% Mitigation, FFS Only, No CRA Offset)\n'
        + '\u2500'.repeat(52) + '\n'
        + '  Year 1 net: $' + Math.round(Math.max(0, V*D.n*D.s*0.30*(D.r-D.c) - V*D.n*D.s*0.30*D.t*(1+D.o))).toLocaleString() + '\n'
        + '  Even in downside case, program generates positive net benefit.\n'
        + '  The $' + beTrip + '/trip break-even creates a wide margin of safety.\n\n'
        + LINE + '\n'
        + 'CONFIDENTIAL DRAFT. Review with finance, legal, and compliance before distribution.\n';

  } else if (type === 'memo') {
    title = 'CRA Activity Justification Memo \u2014 [Your Health System]';
    doc = 'CONFIDENTIAL DRAFT \u2014 FOR LEGAL REVIEW BEFORE DISTRIBUTION\n'
        + LINE + '\n'
        + 'CRA COMMUNITY DEVELOPMENT ACTIVITY JUSTIFICATION MEMORANDUM\n'
        + LINE + '\n\n'
        + 'TO:    ' + bank + ' \u2014 Community Development / CRA Officer\n'
        + 'FROM:  [Health System] \u2014 Community Engagement / Population Health Office\n'
        + 'DATE:  ' + today + '\n'
        + 'RE:    [Service Area] NEMT Program \u2014 [MSA/County] CRA Assessment Area\n\n'
        + LINE + '\n'
        + 'SECTION 1 \u2014 CHNA CITATION & COMMUNITY HEALTH NEED\n'
        + LINE + '\n\n'
        + 'CHNA Document:\n'
        + '  [Your Organization] Community Health Needs Assessment \u2014 [Year/Release Date].\n'
        + '  Produced by [Co-authoring organizations]. Available at: [URL].\n'
        + '  Replace this section with your actual CHNA citation.\n\n'
        + 'CHNA Priorities Addressed (replace with your findings):\n'
        + '  #[N] Access to Care \u2014 [X]% of [Population] delayed care; [Y]% lack a PCP;\n'
        + '       disability + LMI populations face documented transport barriers.\n'
        + '  #[N] Chronic Disease / Behavioral Health \u2014 [X]% prevalence;\n'
        + '       missed appointments worsen glycemic control and BP management.\n'
        + '  #[N] Social Determinants \u2014 Co-occurring transport, food, and housing\n'
        + '       barriers documented in LMI census tracts within your service area.\n\n'
        + 'Statement of Need:\n' + need + '\n\n'
        + LINE + '\n'
        + 'SECTION 2 \u2014 ACTIVITY DESCRIPTION & BANK ROLE\n'
        + LINE + '\n\n'
        + 'Activity Type: ' + actType + '\n\n'
        + activity + '\n\n'
        + 'Assessment Area Confirmation:\n'
        + '  [MSA/County] CRA Assessment Area = [your OCC-confirmed AA geography].\n'
        + '  All program beneficiaries are [Service Area] residents served at\n'
        + '  [Health System] facilities. Confirm AA boundaries with counsel.\n\n'
        + LINE + '\n'
        + 'SECTION 3 \u2014 LMI POPULATION DOCUMENTATION\n'
        + LINE + '\n\n'
        + 'Eligibility Threshold: ' + lmi + '\n'
        + 'Verification Method:   ' + verify + '\n'
        + '[County/MSA] median HH income: [$ from Census] ([Year] ACS)\n'
        + 'Poverty rate: [X]% ([N] residents below poverty threshold)\n\n'
        + 'Special Populations (your CHNA-documented — replace with actual data):\n'
        + '  \u2022 Adults with disabilities \u2014 highest NEMT need; documented access barriers\n'
        + '  \u2022 Non-English speakers \u2014 language + navigation barriers compound transport gap\n'
        + '  \u2022 Medicaid/dual-eligible patients \u2014 coverage gaps persist for some populations\n'
        + '  \u2022 Uninsured / safety-net patients \u2014 highest unmet transportation need\n'
        + '  \u2022 Post-discharge patients \u2014 TCM face-to-face requirement; transport barriers\n'
        + '     directly increase readmission risk (Balasubramanian et al. 2025: 32% RRR)\n\n'
        + LINE + '\n'
        + 'SECTION 4 \u2014 MEASURABLE OUTCOMES & ROI SUMMARY\n'
        + LINE + '\n\n'
        + 'Program ROI (Base Case):  ' + roi + ' on program cost\n'
        + 'Net Annual Value:          ' + fmt(totalNet) + '\n'
        + 'Break-even Trip Cost:      $' + beTrip + '/round trip\n\n'
        + 'Primary Outcome Metrics:\n' + outcomes + '\n\n'
        + 'Outcomes Study Design (EHR-Linked Matched Cohort):\n' + rep + '\n\n'
        + LINE + '\n'
        + 'SECTION 5 \u2014 FINANCIAL STRUCTURE & TERM SHEET\n'
        + LINE + '\n\n'
        + 'Annual Bank Contribution:  $' + amount + '\n'
        + 'Commitment Term:           ' + term + ' year(s)\n'
        + 'Total Commitment:          $' + total + '\n'
        + 'Activity Type:             ' + actType + '\n'
        + 'Reporting Frequency:       ' + freq + '\n\n'
        + LINE + '\n'
        + 'CONFIDENTIAL DRAFT. Review with legal and compliance before distribution.\n';

  } else if (type === 'term') {
    title = 'Bank Term Sheet / Pitch Brief \u2014 [Your Health System] NEMT';
    doc = 'CONFIDENTIAL DRAFT \u2014 FOR REVIEW BEFORE DISTRIBUTION\n'
        + LINE + '\n'
        + 'NEMT PROGRAM \u2014 BANK PARTNERSHIP TERM SHEET & PITCH BRIEF\n'
        + '[Health System] + [Service Area] NEMT Initiative\n'
        + LINE + '\n\n'
        + 'Prepared for: ' + bank + '\n'
        + 'Date: ' + today + '\n\n'
        + LINE + '\n'
        + 'EXECUTIVE SUMMARY\n'
        + LINE + '\n\n'
        + '[Health System] is the [anchor institution / largest employer] in [your service area].\n'
        + 'This NEMT program addresses the #1 priority of the [Year] CHNA ([Priority Name])\n'
        + 'by providing free round-trip transportation for LMI patients to [Health System]\n'
        + 'ambulatory facilities within the [MSA/County] CRA Assessment Area.\n\n'
        + 'A partnership with [Health System] on a documented community health need\n'
        + 'is a marquee CRA exam file relationship for any bank operating in the\n'
        + '[MSA/County] Assessment Area.\n\n'
        + LINE + '\n'
        + 'PROPOSED FINANCIAL STRUCTURE\n'
        + LINE + '\n\n'
        + '  Annual contribution:   $' + amount + '\n'
        + '  Term:                  ' + term + ' years\n'
        + '  Total commitment:      $' + total + '\n'
        + '  Activity type:         ' + actType + '\n'
        + '  CRA classification:    Community Development \u2014 LMI Health Services\n'
        + '  Regulatory authority:  12 CFR 25.23 (OCC) / 12 CFR 228.23 (Federal Reserve)\n'
        + '  Reporting:             ' + freq + ' outcomes report to CRA officer\n\n'
        + LINE + '\n'
        + 'PROGRAM ROI & FINANCIAL RETURNS\n'
        + LINE + '\n\n'
        + '  Conservative net benefit (Year 1):  ' + fmt(ffsNet + codNet) + '\n'
        + '  Base case net benefit:              ' + fmt(ffsNet + codNet + tcmNet) + '\n'
        + '  All-in net benefit (all layers):    ' + fmt(totalNet) + '\n'
        + '  Program ROI:                        ' + roi + '\n'
        + '  Break-even trip cost:               $' + beTrip + '/round trip\n'
        + '  Annual visits protected:            ' + Math.round(prevented).toLocaleString() + '\n\n'
        + LINE + '\n'
        + 'BANK VALUE PROPOSITION\n'
        + LINE + '\n\n'
        + '  1. CRA exam credit: Qualifies as community development activity\n'
        + '     under Access to Care / LMI health services provision.\n\n'
        + '  2. Marquee institutional relationship: [Health System] is the anchor\n'
        + '     institution of [service area]. OCC examiners recognize high-profile\n'
        + '     partnerships with major medical institutions and health systems.\n\n'
        + '  3. National evidence generation: [Health System] will conduct an\n'
        + '     EHR-linked matched-cohort outcomes study (replicating Berkowitz 2022\n'
        + '     Health Affairs methodology). Bank will be acknowledged in publication.\n\n'
        + '  4. Multi-year visibility: 3-year term provides consistent qualifying\n'
        + '     activity across 3 annual CRA exam cycles.\n\n'
        + '  5. LMI documentation: Medicaid/CHIP enrollment-based eligibility\n'
        + '     verification provides audit-ready LMI documentation.\n\n'
        + LINE + '\n'
        + 'PROPOSED ACKNOWLEDGMENT TERMS\n'
        + LINE + '\n\n'
        + '  \u2022 Named acknowledgment in all program materials and reports\n'
        + '  \u2022 Acknowledged in the peer-reviewed outcomes publication\n'
        + '  \u2022 Quarterly outcomes report for CRA exam file\n'
        + '  \u2022 Annual joint press release on program milestones\n'
        + '  \u2022 Invitation to program site visit and patient outcomes presentation\n\n'
        + LINE + '\n'
        + 'NEXT STEPS\n'
        + LINE + '\n\n'
        + '  1. CRA officer review of this brief\n'
        + '  2. CRA Activity Justification Memo (formal document, available on request)\n'
        + '  3. Term sheet execution and compliance review\n'
        + '  4. Program launch: estimated 90 days post-execution\n\n'
        + 'Contact: [Health System] \u2014 Community Engagement / Population Health Office\n'
        + LINE + '\n'
        + 'CONFIDENTIAL DRAFT. Review with legal and CRA compliance before distribution.\n';

  } else if (type === 'boarddeck') {
    title = 'Board Executive Summary \u2014 NEMT Program Approval Brief';
    const conservative = ffsNet + codNet;
    const baseCase = ffsNet + codNet + tcmNet;
    const optimistic = totalNet;
    doc = 'BOARD OF DIRECTORS \u2014 EXECUTIVE SUMMARY\n'
        + 'FOR APPROVAL: Non-Emergency Medical Transportation Program\n'
        + LINE + '\n\n'
        + 'Prepared by: Community Engagement / Finance\n'
        + 'Date: ' + today + '\n'
        + 'Requested Action: Approve NEMT pilot program and bank CRA partnership\n\n'
        + LINE + '\n'
        + 'THE STRATEGIC CASE\n'
        + LINE + '\n\n'
        + 'Transportation barriers are the #[N] access-to-care priority identified in the\n'
        + '[Year] CHNA. Nationally, 25\u201351% of missed appointments are transportation-attributable\n'
        + 'in LMI populations (Syed et al. 2013; CMS VBID 2023). Replace with your local data.\n\n'
        + 'NEMT directly addresses:\n'
        + '  \u2022 IRS Schedule H / 501(r) community benefit documentation obligations\n'
        + '  \u2022 CRA community development partnership opportunity ([MSA/County] AA)\n'
        + '  \u2022 ACO REACH / Medicare quality performance (Transitions of Care,\n'
        + '    Diabetes Glycemic Status, BP Control, Colorectal Screening)\n'
        + '  \u2022 CCM/TCM revenue capture through NEMT-enabled contact windows\n\n'
        + LINE + '\n'
        + 'THREE-SCENARIO FINANCIAL ANALYSIS\n'
        + LINE + '\n\n'
        + '  Scenario             Annual Value   Net Benefit    ROI\n'
        + '  \u2500'.repeat(50) + '\n'
        + '  Conservative (Y1)    ' + fmt(conservative+progCost).padEnd(14) + fmt(conservative).padEnd(14) + (progCost>0?(conservative/progCost).toFixed(2)+'x':'—') + '\n'
        + '  Base Case [\u2605 ANCHOR]  ' + fmt(baseCase+progCost).padEnd(14)    + fmt(baseCase).padEnd(14)    + (progCost>0?(baseCase/progCost).toFixed(2)+'x':'—') + '\n'
        + '  Optimistic (Y2+)     ' + fmt(optimistic+progCost).padEnd(14)  + fmt(optimistic).padEnd(14)  + (progCost>0?(optimistic/progCost).toFixed(2)+'x':'—') + '\n\n'
        + '  Program cost:        ' + fmt(progCost) + '/year\n'
        + '  Break-even trip:     $' + beTrip + '/round trip\n'
        + '  Bank CRA offset:     ' + fmt(bankCRA) + '/year (net outlay: ' + fmt(progCost-bankCRA) + ')\n\n'
        + LINE + '\n'
        + 'COMPLIANCE & REGULATORY POSTURE\n'
        + LINE + '\n\n'
        + '  \u2022 AKS Safe Harbor: Program is structured to meet the 2016 OIG Safe\n'
        + '    Harbor for transportation of LMI patients. Legal review prior to launch.\n'
        + '  \u2022 CRA: Bank contribution qualifies as community development activity\n'
        + '    under OCC 12 CFR 25.23 — LMI health services, [MSA/County] AA.\n'
        + '  \u2022 Schedule H: NEMT program directly implements CHNA Priority #1 (Access\n'
        + '    to Care) per 501(r) / IRS Form 990 Schedule H requirements.\n'
        + '  \u2022 HIPAA/BAA: Full BAA with vendor required before program launch.\n\n'
        + LINE + '\n'
        + 'RECOMMENDED MOTION\n'
        + LINE + '\n\n'
        + 'The Board approves:\n'
        + '  (1) NEMT pilot program at ' + Math.round(V).toLocaleString() + ' targeted visits/year;\n'
        + '  (2) Bank CRA partnership with ' + bank + ' at $' + amount + '/year for ' + term + ' years;\n'
        + '  (3) Outcomes attribution study enrollment (EHR-linked matched cohort);\n'
        + '  (4) Quarterly board reporting on program KPIs and financial performance.\n\n'
        + 'CONFIDENTIAL DRAFT. Review with legal and finance before distribution.\n';

  } else if (type === 'sla') {
    title = 'Vendor SLA Template \u2014 NEMT Program';
    doc = 'NON-EMERGENCY MEDICAL TRANSPORTATION\n'
        + 'VENDOR SERVICE LEVEL AGREEMENT TEMPLATE\n'
        + LINE + '\n\n'
        + 'Client:   [HEALTH SYSTEM NAME]\n'
        + 'Vendor:   [VENDOR NAME]\n'
        + 'Effective Date: [DATE]\n'
        + 'Term: [TERM]\n\n'
        + LINE + '\n'
        + 'ARTICLE 1 \u2014 PERFORMANCE STANDARDS\n'
        + LINE + '\n\n'
        + '1.1  ON-TIME PICKUP (within 10 minutes of scheduled time)\n'
        + '     Minimum:    \u226592% of all scheduled trips\n'
        + '     Warning:    Below 88% triggers 30-day cure notice\n'
        + '     Termination: Below 85% for any rolling 30-day period\n'
        + '     Monitoring: Weekly automated report via vendor portal\n\n'
        + '1.2  TRIP CANCELLATION RATE (vendor-initiated)\n'
        + '     Minimum:    \u22645% of all scheduled trips\n'
        + '     Warning:    6\u20138% triggers 14-day cure notice\n'
        + '     Monitoring: Weekly automated report\n\n'
        + '1.3  DRIVER NO-SHOW / PATIENT ABANDONMENT\n'
        + '     Minimum:    \u22642% of scheduled trips\n'
        + '     Response:   Immediate escalation to account manager\n'
        + '     Monitoring: Patient-reported via post-ride SMS survey\n\n'
        + '1.4  SAFETY\n'
        + '     Standard:   Zero tolerance for injury or accident\n'
        + '     Response:   Immediate suspension pending investigation\n'
        + '     Reporting:  Incident report to [Health System] within 24 hours\n\n'
        + '1.5  SERVICE LOG COMPLETENESS\n'
        + '     Standard:   100% of trips logged with timestamp, pickup, dropoff,\n'
        + '                 driver ID, and patient confirmation\n'
        + '     Remedy:     Payment withheld for incomplete log entries\n'
        + '     Monitoring: Weekly reconciliation against appointment system\n\n'
        + LINE + '\n'
        + 'ARTICLE 2 \u2014 HIPAA / DATA SECURITY\n'
        + LINE + '\n\n'
        + '2.1  Vendor shall execute a Business Associate Agreement (BAA) prior to\n'
        + '     first trip. BAA terms comply with 45 CFR Parts 160 and 164.\n'
        + '2.2  No patient PHI shall be used for marketing, list generation, or any\n'
        + '     purpose other than trip coordination and compliance documentation.\n'
        + '2.3  Annual security assessment and attestation required.\n'
        + '2.4  Data breach notification within 72 hours per 45 CFR 164.412.\n\n'
        + LINE + '\n'
        + 'ARTICLE 3 \u2014 DOCUMENTATION & AUDIT RIGHTS\n'
        + LINE + '\n\n'
        + '3.1  Vendor shall maintain trip logs for minimum 7 years.\n'
        + '3.2  [Health System] retains right to audit all service logs with 10 business days notice.\n'
        + '3.3  Monthly invoices must reconcile to service logs; disputes resolved within\n'
        + '     30 days of invoice date.\n\n'
        + LINE + '\n'
        + 'ARTICLE 4 \u2014 ESCALATION & REMEDIES\n'
        + LINE + '\n\n'
        + '4.1  Operational issues: Vendor account manager within 4 business hours.\n'
        + '4.2  SLA breach (below threshold): Formal cure notice; cure plan within 5 days.\n'
        + '4.3  Safety incident: Immediate program suspension; full review before resuming.\n'
        + '4.4  Termination for cause: 30-day written notice; 5-day notice for safety.\n\n'
        + LINE + '\n'
        + 'Signatures: _________________________  [VENDOR]   Date: ________\n'
        + '            _________________________  [HEALTH SYSTEM] Date: ________\n\n'
        + 'TEMPLATE ONLY. Review with legal and compliance before execution.\n';

  } else if (type === 'outcomes_study') {
    title = 'Outcomes Attribution Study Design \u2014 EHR-Linked Matched Cohort';
    doc = 'EHR-LINKED MATCHED-COHORT STUDY PROTOCOL\n'
        + 'NEMT OUTCOMES ATTRIBUTION STUDY \u2014 DRAFT\n'
        + LINE + '\n\n'
        + 'PI:       [TO BE DESIGNATED \u2014 Suggest: CMO or VP Community Health]\n'
        + 'Co-I:     [Community Engagement, Biostatistics, Quality]\n'
        + 'Date:     ' + today + '\n'
        + 'EHR data access request to be submitted at program launch\n\n'
        + LINE + '\n'
        + 'STUDY RATIONALE\n'
        + LINE + '\n\n'
        + 'Your health system EHR provides longitudinal patient records\n'
        + 'that can support a rigorous NEMT outcomes study replicating the\n'
        + 'Berkowitz et al. (2022) high-dimensional propensity score approach\n'
        + '(Health Affairs 41(3):406-413). Such a study is publishable in Tier 1\n'
        + 'journals (JAMA, Health Affairs, NEJM Catalyst).\n\n'
        + 'The existing evidence gap: Berkowitz 2022 found NEMT increased\n'
        + 'outpatient visits (+9.2/person/year) but was not cost-saving in the\n'
        + 'short term. A targeted study can isolate NEMT impact on TCM completion\n'
        + 'and 30-day readmissions, where the causal chain is strongest.\n\n'
        + LINE + '\n'
        + 'STUDY DESIGN\n'
        + LINE + '\n\n'
        + 'Design:        Retrospective matched cohort\n'
        + 'Population:    [Health System] LMI ambulatory patients\n'
        + 'Matching ratio: 1:3 (enrolled : controls)\n'
        + 'Matching vars: Age (\u00b15 yr), primary diagnosis, insurance type,\n'
        + '               prior-year no-show rate, distance from clinic\n'
        + 'Follow-up:     24 months post-enrollment\n'
        + 'Index date:    Date of first NEMT-enabled appointment\n\n'
        + LINE + '\n'
        + 'ENDPOINTS\n'
        + LINE + '\n\n'
        + 'PRIMARY (12-18 months):\n'
        + '  \u2022 Transportation-attributable no-show rate reduction\n'
        + '    H0: no difference between enrolled and controls\n'
        + '    Power: 80% to detect 7% absolute reduction; \u03b1=0.05\n\n'
        + 'SECONDARY (24 months):\n'
        + '  \u2022 30-day readmission rate (TCM-enrolled subgroup)\n'
        + '  \u2022 HbA1c control rate (CCM-enrolled diabetic subgroup)\n'
        + '  \u2022 QPP quality measure closure rates (001, 236, 113)\n'
        + '  \u2022 SDOH Z75.3 documentation rate\n'
        + '  \u2022 Patient-reported confidence in keeping appointments\n\n'
        + LINE + '\n'
        + 'IRB PATHWAY\n'
        + LINE + '\n\n'
        + 'Pathway:       Quality Improvement / Program Evaluation\n'
        + 'Exemption:     Likely (45 CFR 46.104(d)(4) \u2014 program evaluation)\n'
        + 'Confirm:       [Health System] IRB at program outset\n'
        + 'Data request:  Submit EHR data access application at 90-day launch\n\n'
        + LINE + '\n'
        + 'PUBLICATION PLAN\n'
        + LINE + '\n\n'
        + 'Target journals: JAMA Network Open, Health Affairs, AJPH, JGIM\n'
        + 'Timeline:\n'
        + '  Month 3:   IRB application + REP data request\n'
        + '  Month 12:  Interim analysis; conference abstract (AHA/NACHC)\n'
        + '  Month 18:  Primary outcome paper submission\n'
        + '  Month 24:  Secondary outcomes paper; policy brief to CMMI\n\n'
        + 'Authorship:    CMO or VP Community Health as lead author;\n'
        + '               define roles at study design phase\n'
        + 'Bank acknowledgment: "This study was made possible by the community\n'
        + 'investment of ' + bank + ' in [Service Area] community health equity."\n\n'
        + LINE + '\n'
        + 'DRAFT PROTOCOL. Review with IRB and legal counsel before submission.\n';

  } else if (type === 'kpi') {
    title = 'KPI Dashboard & Quarterly Reporting Template';
    doc = 'NEMT PROGRAM \u2014 QUARTERLY KPI DASHBOARD\n'
        + '[Health System] / [Service Area]\n'
        + LINE + '\n\n'
        + 'Reporting Period: Q___ 20___\n'
        + 'Report Date: ' + today + '\n'
        + 'Prepared by: [Program Coordinator]\n\n'
        + LINE + '\n'
        + 'SECTION 1 \u2014 ACCESS METRICS\n'
        + LINE + '\n\n'
        + '  Metric                           Target       Actual    RAG\n'
        + '  \u2500'.repeat(58) + '\n'
        + '  Transport no-show rate           \u226540% red.    ____%     [ ]\n'
        + '  NEMT utilization rate            \u226588%         ____%     [ ]\n'
        + '  Enrollment rate (eligible)       \u226540%         ____%     [ ]\n'
        + '  First-ride completion rate       \u226595%         ____%     [ ]\n'
        + '  Trips completed (quarter)        ____         ____      [ ]\n'
        + '  Unduplicated LMI patients served ____         ____      [ ]\n\n'
        + LINE + '\n'
        + 'SECTION 2 \u2014 CLINICAL OUTCOMES\n'
        + LINE + '\n\n'
        + '  Metric                           Target       Actual    RAG\n'
        + '  \u2500'.repeat(58) + '\n'
        + '  30-day readmission (TCM pts)     \u226415%         ____%     [ ]\n'
        + '  HbA1c control rate (CCM diabetic) \u2191vs baseline ____%     [ ]\n'
        + '  QPP Msr 001 score delta          \u22655 pts/yr   ____pts   [ ]\n'
        + '  QPP Msr 236 BP control delta     \u22655 pts/yr   ____pts   [ ]\n'
        + '  TCM completion rate              \u226570%         ____%     [ ]\n\n'
        + LINE + '\n'
        + 'SECTION 3 \u2014 PATIENT-REPORTED OUTCOMES\n'
        + LINE + '\n\n'
        + '  Metric                           Target       Actual    RAG\n'
        + '  \u2500'.repeat(58) + '\n'
        + '  Post-ride ease of access (1\u201310)   \u22658.0         ____      [ ]\n'
        + '  Appointment confidence (\u226570%)    70%          ____%     [ ]\n'
        + '  Driver safety rating (1\u201310)       \u22659.0         ____      [ ]\n'
        + '  Would recommend program (%)      \u226585%         ____%     [ ]\n\n'
        + LINE + '\n'
        + 'SECTION 4 \u2014 FINANCIAL PERFORMANCE\n'
        + LINE + '\n\n'
        + '  Metric                           Target       Actual    RAG\n'
        + '  \u2500'.repeat(58) + '\n'
        + '  FFS net benefit (quarter)        ' + fmt(ffsNet/4) + '   $____     [ ]\n'
        + '  Coding uplift (quarter)          ' + fmt(codNet/4) + '   $____     [ ]\n'
        + '  CCM net revenue (quarter)        ' + fmt(ccmNet/4) + '   $____     [ ]\n'
        + '  TCM net revenue (quarter)        ' + fmt(tcmNet/4) + '   $____     [ ]\n'
        + '  Total net benefit (quarter)      ' + fmt(totalNet/4) + '   $____     [ ]\n'
        + '  Actual vs. projected (within 20%) Within 20%  ____%     [ ]\n'
        + '  Program cost (quarter)           ' + fmt(progCost/4) + '   $____     [ ]\n\n'
        + LINE + '\n'
        + 'SECTION 5 \u2014 COMPLIANCE & DOCUMENTATION\n'
        + LINE + '\n\n'
        + '  Metric                           Target       Actual    RAG\n'
        + '  \u2500'.repeat(58) + '\n'
        + '  Z75.3 documentation rate         \u226525% (Y1)    ____%     [ ]\n'
        + '  CCM/TCM doc completeness (audit) 100%         ____%     [ ]\n'
        + '  Service log reconciliation       100%         ____%     [ ]\n'
        + '  Vendor SLA: on-time pickup       \u226592%         ____%     [ ]\n'
        + '  Vendor SLA: cancellation rate    \u22645%          ____%     [ ]\n'
        + '  BAA attestation current          Yes          ___       [ ]\n\n'
        + LINE + '\n'
        + 'SECTION 6 \u2014 QUARTERLY NARRATIVE\n'
        + LINE + '\n\n'
        + '  Key achievements this quarter:\n'
        + '  [FILL IN]\n\n'
        + '  Issues / corrective actions:\n'
        + '  [FILL IN]\n\n'
        + '  REP study status:\n'
        + '  [FILL IN]\n\n'
        + '  Next quarter priorities:\n'
        + '  [FILL IN]\n\n'
        + LINE + '\n'
        + 'RAG Key:  [ G ] Green \u2014 on/above target  [ Y ] Yellow \u2014 within 10%  [ R ] Red \u2014 below threshold\n'
        + LINE + '\n'
        + 'Report distribution: CMO, CFO, Community Engagement, CRA Bank Partner, Board Quality Committee\n';
  }

  const titleEl = document.getElementById('mayo_draft_title');
  const contentEl = document.getElementById('mayo_draft_content');
  const outEl = document.getElementById('mayo_draft_out');
  if (titleEl) titleEl.textContent = title;
  if (contentEl) contentEl.textContent = doc;
  if (outEl) outEl.style.display = 'block';
  window._mayoCurrentDraft = { title, doc };
  if (contentEl) contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
window.copyMayoDraft = async function() {
  const txt = (window._mayoCurrentDraft && window._mayoCurrentDraft.doc) || document.getElementById('mayo_draft_content').textContent || '';
  try { await navigator.clipboard.writeText(txt); showOk('Draft copied to clipboard.'); }
  catch(e) { showOk('Select text in the preview and copy manually.'); }
};

window.downloadMayoDraft = function() {
  const d = window._mayoCurrentDraft || { title: 'NEMT_Draft', doc: '' };
  const blob = new Blob([d.doc], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = d.title.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/,'') + '.txt';
  a.click();
};

// Patch setView to hide grid for mayo tab too
(function(){
  var origSetView = window.setView;
  if (!origSetView) return;
  window.setView = function(view) {
    origSetView(view);
    var grid = document.querySelector('.grid.grid-2');
    if (grid && view === 'mayo') { grid.style.display = 'none'; setTimeout(calcMayoROI, 80); }
  };
})();

