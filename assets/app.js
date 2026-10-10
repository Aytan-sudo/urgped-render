/* Dashboard urgences pédiatriques — rendu client.
   Lit web/data/{snapshot,history}.json et trace via Chart.js.
   Aucune donnée patient : uniquement des agrégats. */

const PALETTE = {
  primary: "#2c6e9b",
  primarySoft: "#9fc1dc",
  alert: "#c0392b",
  incomplete: "#d1d5db",
  // bandes de charge (5 niveaux, pastel) : vert -> bleu clair -> bleu -> rouge -> violet
  charge: ["#9bd6a3", "#abd4ed", "#6aa3d8", "#e57373", "#a479c4"],
  chargeNoms: ["Très faible", "Faible", "Normal", "Élevé", "Très élevé"],
  // famille bleu/rouge + neutres, sans vert ni orange criards
  series: ["#2c6e9b", "#c0392b", "#6b9ac4", "#d98880", "#34495e", "#a93226", "#95a5a6"],
};

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.color = "#6b7280";
Chart.defaults.plugins.legend.labels.boxWidth = 12;
// datalabels : enregistré globalement mais désactivé par défaut (activé par dataset)
if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
}

// ----------------------------------------------------------------- helpers ---

async function fetchJSON(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} : ${r.status}`);
  return r.json();
}

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1).replace(".", ",") + " %");
const heures = (x) => (x == null ? "—" : x.toFixed(1).replace(".", ",") + " h");
const num = (x) => (x == null ? "—" : x.toLocaleString("fr-FR"));

function deltaTxt(d) {
  if (d == null) return "";
  const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "→";
  return `${arrow} ${d > 0 ? "+" : ""}${String(d).replace(".", ",")} % vs 30 j préc.`;
}

function kpiTile(label, valueStr, subStr, delta) {
  return `<div class="kpi"><div class="label">${label}</div>
    <div class="value">${valueStr}</div>
    <div class="sub">${subStr || "&nbsp;"}</div>
    <div class="delta">${deltaTxt(delta)}</div></div>`;
}

// moyenne mobile glissante (fenêtre), ignore les valeurs null (jours incomplets)
function movingAvg(values, window) {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let s = 0, n = 0;
    for (let k = i - window + 1; k <= i; k++) {
      if (values[k] != null) { s += values[k]; n++; }
    }
    return n ? s / n : null;
  });
}

function makeChart(id, config) {
  Chart.getChart(id)?.destroy();  // re-render sûr (switch année/saison)
  return new Chart(document.getElementById(id).getContext("2d"), config);
}

const total = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

// étiquette "valeur absolue" en bout de barre
const dataLabelN = (color = "#6b7280") => ({
  display: true, anchor: "end", align: "end", clamp: true, color, font: { size: 9 },
  formatter: (v) => num(Math.round(v)),
});

// créneaux : clés JSON -> libellés affichés
const CRENEAUX_LABELS = { matin: "Matin (8-13h)", apresmidi: "Après-midi (13-19h)",
  N1: "Soirée (19h-minuit)", N2: "Nuit (minuit-8h)" };

// -------------------------------------------------------------- page 30 j ----

let _snap = null, _hist = null;

async function initPage1() {
  try {
    const [snap, hist] = await Promise.all([
      fetchJSON("./data/snapshot.json"),
      fetchJSON("./data/history.json"),
    ]);
    _snap = snap; _hist = hist;
    renderHeader(snap, hist);
    renderReconsult(hist);    // reconsultation J3 : globale (non stratifiée)
    setupStrateToggle();
    renderStrate("Tous");
  } catch (e) {
    showError(e);
  }
}

function setupStrateToggle() {
  const cont = document.getElementById("strate-toggle");
  cont.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    cont.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    renderStrate(b.dataset.strate);
  }));
}

// indicateurs de profil : stratifiés (Tous / Médecine / Chirurgie / Réorienté)
function renderStrate(nom) {
  const b = _snap.strates[nom];
  renderPassages(nom);
  renderKPIs(b.kpi);
  renderCreneaux(b.creneaux);
  renderTri(b.par_tri);
  renderExamens(b.examens);
  renderServices(b.services_hospit, b.kpi.taux_hospit);
  renderReorient(b.reorientation);
  renderAge(b.age);
  renderSurveillance(b.age_surveillance);
}

function renderCreneaux(c) {
  const keys = ["matin", "apresmidi", "N1", "N2"];
  const somme = keys.reduce((s, k) => s + (c[k] || 0), 0);
  makeChart("chart-creneaux", {
    type: "bar",
    data: { labels: keys.map((k) => CRENEAUX_LABELS[k]),
      datasets: [{ data: keys.map((k) => c[k] || 0), backgroundColor: PALETTE.primary, datalabels: dataLabelN() }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${num(ctx.parsed.y)}  (${somme ? (ctx.parsed.y / somme * 100).toFixed(1) : 0} %)` } } },
      scales: { y: { beginAtZero: true, grace: "8%" } } },
  });
}

function renderHeader(snap, hist) {
  const fmt = (d) => new Date(d).toLocaleDateString("fr-FR");
  document.getElementById("period").textContent =
    `Période : ${fmt(snap.meta.start)} → ${fmt(snap.meta.end)} · ${num(snap.meta.n_passages)} passages`;
  renderFooter(hist);
}

// bandeau du bas (deux pages) : génération du tableau + export / mise en ligne
// du dernier CSV CHU + journal dépliable des mises en ligne récentes.
// « En ligne au plus tard » = premier constat de présence par le workflow (le
// CHU n'expose pas l'heure de copie : Last-Modified = heure de génération).
function renderFooter(hist) {
  const fmt = (d) => new Date(d).toLocaleDateString("fr-FR");
  const hm = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const dh = (iso) => `${fmt(iso)} à ${hm(iso)}`;
  const jourFichier = (nom) => nom.slice(0, 10).replace(/_/g, "-");
  const src = hist.meta.export_source;
  let txt = `Tableau généré le ${dh(hist.meta.generated_at)}.`;
  if (src) {
    txt += ` Dernier fichier (activité du ${fmt(jourFichier(src.fichier))})`
      + (src.exporte_le ? ` exporté le ${dh(src.exporte_le)}` : "")
      + (src.detecte_le ? `, mis en ligne au plus tard le ${dh(src.detecte_le)}` : "") + ".";
  }
  txt += ` Historique : ${fmt(hist.meta.coverage.start)} → ${fmt(hist.meta.coverage.end)}.`;
  document.getElementById("generated").textContent = txt;

  const journal = (hist.meta.publication || []).filter((e) => e.detecte_le);
  document.getElementById("publication")?.remove();
  if (!journal.length) return;
  const jour = (iso) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });
  // mise en ligne « dans les temps » = constatée avant 7h (Paris) le lendemain de l'activité
  const aTemps = (e) => {
    const d = new Date(e.detecte_le);
    const lendemain = new Date(jourFichier(e.fichier) + "T00:00:00"); lendemain.setDate(lendemain.getDate() + 1);
    return d.toDateString() === lendemain.toDateString() && d.getHours() < 7;
  };
  const rows = journal.slice(0, 30).map((e) => `<tr><td>${jour(jourFichier(e.fichier) + "T12:00:00")}</td>
    <td>${e.exporte_le ? `${jour(e.exporte_le)} ${hm(e.exporte_le)}` : "—"}</td>
    <td>${jour(e.detecte_le)} ${hm(e.detecte_le)}</td><td>${aTemps(e) ? "✓" : "✗"}</td></tr>`).join("");
  const n = journal.slice(0, 30).filter(aTemps).length;
  document.getElementById("generated").insertAdjacentHTML("afterend",
    `<details id="publication"><summary>Mises en ligne récentes du fichier CHU (${n}/${Math.min(journal.length, 30)} avant 7h)</summary>
     <table><thead><tr><th>Activité du</th><th>Exporté</th><th>En ligne au plus tard</th><th>Avant 7h</th></tr></thead>
     <tbody>${rows}</tbody></table></details>`);
}

function renderKPIs(kpi) {
  const k = (name) => kpi[name] || {};
  const tiles = [
    kpiTile("Passages / jour", num(k("passages_jour_moy").val),
      `${num(k("passages_jour_moy").n)} sur la période`, k("passages_jour_moy").delta_pct),
    kpiTile("Durée séjour médiane", heures(k("ds_med_h").val), "", k("ds_med_h").delta_pct),
    kpiTile("Taux d'hospitalisation", pct(k("taux_hospit").val),
      `${num(k("taux_hospit").n)} hospitalisés`, k("taux_hospit").delta_pct),
    kpiTile("Taux UHCD", pct(k("taux_uhcd").val),
      `${num(k("taux_uhcd").n)} passages UHCD`, k("taux_uhcd").delta_pct),
    kpiTile("Taux de réorientation", pct(k("taux_reorient").val),
      `${num(k("taux_reorient").n)} réorientés`, k("taux_reorient").delta_pct),
    kpiTile("Reconsultation J3", pct(k("taux_reconsult_j3").val),
      `${num(k("taux_reconsult_j3").n)} reconsultations`, k("taux_reconsult_j3").delta_pct),
  ];
  document.getElementById("kpis").innerHTML = tiles.join("");
}

function isWeekend(dateStr) {
  const [y, mo, da] = dateStr.split("-").map(Number);
  const wd = new Date(y, mo - 1, da).getDay();
  return wd === 0 || wd === 6;
}

// indice de bande pour une valeur, généralisé à N seuils (-> N+1 bandes)
function chargeColor(v, seuils) {
  if (!seuils || !seuils.length) return PALETTE.primarySoft;
  let i = 0;
  while (i < seuils.length && v >= seuils[i]) i++;
  return PALETTE.charge[i];
}

function renderChargeLegend(seuils) {
  const el = document.getElementById("legend-passages");
  const sw = (c, t) => `<span class="sw"><i style="background:${c}"></i>${t}</span>`;
  let bandes = "";
  if (seuils && seuils.length) {
    const n = seuils.length;
    const bornes = PALETTE.charge.map((_, i) =>
      i === 0 ? `< ${seuils[0]}` : i === n ? `≥ ${seuils[n - 1]}` : `${seuils[i - 1]}–${seuils[i]}`);
    bandes = PALETTE.charge.map((c, i) => sw(c, `${PALETTE.chargeNoms[i]} (${bornes[i]})`)).join("");
  }
  el.innerHTML = bandes + sw(PALETTE.incomplete, "Incomplet")
    + `<span class="sw note-inline">* = week-end ou férié</span>`;
}

function selByStrate(d, stratum) {
  if (stratum === "Médecine") return d.secteurs?.medecine || 0;
  if (stratum === "Chirurgie") return d.secteurs?.chirurgie || 0;
  if (stratum === "Réorienté") return d.reorient || 0;
  return d.passages;
}

function renderPassages(stratum) {
  const SHOW = 30, PAD = 6;
  const seuils = _hist.meta.charge_seuils || [];
  const tail = _hist.days.slice(-(SHOW + PAD));
  const start = tail.length - SHOW;
  const days = tail.slice(start);
  const labels = days.map((d) => new Date(d.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }));
  const labelsMark = days.map((d, i) => (d.ferie || isWeekend(d.date) ? labels[i] + " *" : labels[i]));
  const tickColor = (ctx) => { const d = days[ctx.index]; return d && d.ferie ? PALETTE.alert : "#6b7280"; };

  const nIncomplets = days.filter((d) => d.incomplete).length;
  document.getElementById("note-passages").textContent = nIncomplets
    ? `${nIncomplets} jour(s) en gris : données incomplètes (fichier source manquant).`
    : "";

  const sw = (c, t) => `<span class="sw"><i style="background:${c}"></i>${t}</span>`;
  let datasets, stacked;

  if (stratum === "Tous") {
    stacked = false;
    const colors = days.map((d) => (d.incomplete ? PALETTE.incomplete : chargeColor(d.passages, seuils)));
    datasets = [
      { type: "bar", label: "Passages", data: days.map((d) => d.passages), backgroundColor: colors,
        categoryPercentage: .9, barPercentage: .72, datalabels: dataLabelN() },
    ];
    renderChargeLegend(seuils);
  } else {
    stacked = true;
    const sel = days.map((d) => (d.incomplete ? null : selByStrate(d, stratum)));
    const reste = days.map((d) => (d.incomplete ? null : d.passages - selByStrate(d, stratum)));
    datasets = [
      { type: "bar", label: stratum, data: sel, backgroundColor: PALETTE.primary, stack: "s",
        datalabels: dataLabelN() },
      { type: "bar", label: "Autres", data: reste, backgroundColor: "#e5e7eb", stack: "s" },
    ];
    document.getElementById("legend-passages").innerHTML =
      sw(PALETTE.primary, stratum) + sw("#e5e7eb", "Autres secteurs")
      + `<span class="sw note-inline">* = week-end ou férié</span>`;
  }

  makeChart("chart-passages", {
    data: { labels: labelsMark, datasets },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { stacked, beginAtZero: true, grace: "8%" },
        x: { stacked, ticks: { color: tickColor } } } },
  });
}

function renderReconsult(hist) {
  const days = hist.days.slice(-30);
  const labels = days.map((d) => new Date(d.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }));
  // taux quotidien (%) lissé 7 j, jours incomplets ignorés
  const taux = days.map((d) => (d.incomplete || !d.passages ? null : d.reconsult_j3 / d.passages * 100));
  const ma = movingAvg(taux, 7);
  makeChart("chart-reconsult-30", {
    type: "line",
    data: { labels, datasets: [
      { label: "Taux quotidien", data: taux, borderColor: PALETTE.primarySoft, backgroundColor: PALETTE.primarySoft,
        borderWidth: 1, pointRadius: 2, spanGaps: false },
      { label: "Moy. mobile 7 j", data: ma, borderColor: PALETTE.alert, borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true },
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 14 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label} : ${c.parsed.y?.toFixed(1).replace(".", ",")} %` } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + " %" } } } },
  });
}

function renderTri(rows) {
  makeChart("chart-tri", {
    data: {
      labels: rows.map((r) => r.tri),
      datasets: [
        { type: "bar", label: "Passages", data: rows.map((r) => r.n),
          backgroundColor: PALETTE.primarySoft, yAxisID: "y", order: 2 },
        { type: "line", label: "Taux d'hospit.", data: rows.map((r) => r.taux_hospit * 100),
          borderColor: PALETTE.alert, backgroundColor: PALETTE.alert, borderWidth: 2,
          pointRadius: 3, yAxisID: "y1", tension: .2, order: 1 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "Passages" } },
        y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false },
          title: { display: true, text: "% hospitalisés" }, ticks: { callback: (v) => v + " %" } },
      } },
  });
}

function renderExamens(rows) {
  makeChart("chart-examens", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.exam),
      datasets: [{ data: rows.map((r) => (r.pct * 100).toFixed(1)), backgroundColor: PALETTE.primary,
        datalabels: { display: true, anchor: "end", align: "end", clamp: true, color: "#6b7280", font: { size: 9 },
          formatter: (v, ctx) => num(rows[ctx.dataIndex].n) } }],
    },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.x} %  (${num(rows[c.dataIndex].n)} passages)` } },
      },
      scales: { x: { beginAtZero: true, grace: "6%", ticks: { callback: (v) => v + " %" } } } },
  });
}

// barres horizontales triées + total dans le titre (remplace le camembert)
// valeur absolue en bout de barre, % au survol
function horizontalBar(id, titleId, rows, labelKey, valueKey) {
  const sorted = [...rows].sort((a, b) => b[valueKey] - a[valueKey]);
  const somme = total(rows, valueKey);
  document.getElementById(titleId).textContent = `· total ${num(somme)}`;
  makeChart(id, {
    type: "bar",
    data: {
      labels: sorted.map((r) => r[labelKey]),
      datasets: [{ data: sorted.map((r) => r[valueKey]), backgroundColor: PALETTE.primary, datalabels: dataLabelN() }],
    },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${num(c.parsed.x)}  (${(c.parsed.x / somme * 100).toFixed(1)} %)` } } },
      scales: { x: { beginAtZero: true, grace: "6%" } } },
  });
}

// titre : total + taux d'hospitalisation + évolution vs 30 j précédents
function renderServices(rows, k) {
  horizontalBar("chart-services", "total-services", rows, "service", "n");
  if (k?.val != null)
    document.getElementById("total-services").textContent =
      `· total ${num(k.n)} · ${pct(k.val)}` + (k.delta_pct != null ? ` · ${deltaTxt(k.delta_pct)}` : "");
}
function renderReorient(rows) { horizontalBar("chart-reorient", "total-reorient", rows, "motif", "n"); }

function renderAge(rows) {
  const somme = total(rows, "n");
  makeChart("chart-age", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.tranche),
      datasets: [{ data: rows.map((r) => r.n), backgroundColor: PALETTE.primary, datalabels: dataLabelN() }],
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${num(c.parsed.y)}  (${(c.parsed.y / somme * 100).toFixed(1)} %)` } } },
      scales: { y: { beginAtZero: true, grace: "8%" }, x: { ticks: { autoSkip: false, maxRotation: 50 } } } },
  });
}

function renderSurveillance(s) {
  const mini = (label, o) => `<div class="mini"><div class="v">${pct(o.pct)}</div>
    <div class="l">${label}<br>${num(o.n)} passages</div></div>`;
  document.getElementById("surveillance").innerHTML =
    [["<1 mois", "< 1 mois"], ["<3 mois", "< 3 mois"], ["<2 ans", "< 2 ans"], [">15 ans", "> 15 ans"]]
      .filter(([k]) => s[k]).map(([k, label]) => mini(label, s[k])).join("");
}

// -------------------------------------------------------------- page année ---

// année civile : axe Jan→Déc ; saison : axe Juil→Juin (pic hivernal centré)
const MOIS_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MOIS_LABELS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Aoû", "Sep", "Oct", "Nov", "Déc"];
const SAISON_STARTS = [1, 32, 63, 93, 124, 154, 185, 216, 244, 275, 305, 336];
const SAISON_LABELS = ["Juil", "Aoû", "Sep", "Oct", "Nov", "Déc", "Jan", "Fév", "Mar", "Avr", "Mai", "Juin"];

let _histDays = null;
let _periodMode = "civile";   // civile | saison
let _cumulVue = "cumul";      // cumul | ecart

// Référence robuste = moyenne tronquée : on retire l'année la plus basse ET la
// plus haute (creux/pic anormaux), puis on moyenne le reste -> vrai mélange de
// plusieurs années (pas une seule), insensible aux extrêmes. Repli sur la
// moyenne simple s'il y a trop peu d'années.
function refValue(vals) {
  if (vals.length >= 5) {
    const s = [...vals].sort((a, b) => a - b).slice(1, -1);  // sans min ni max
    return s.reduce((a, b) => a + b, 0) / s.length;
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function dayOfYear(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

// "saison" : la période démarre le 1er juillet ; un jour de jan-juin appartient
// à la saison commencée l'année précédente.
function periodStart(dateStr, mode) {
  const [y, m] = dateStr.split("-").map(Number);
  return (mode === "saison" && m < 7) ? y - 1 : y;
}
function periodLabel(start, mode) {
  return mode === "saison" ? `${start}-${String((start + 1) % 100).padStart(2, "0")}` : String(start);
}
function dayOfPeriod(dateStr, mode) {
  if (mode !== "saison") return dayOfYear(dateStr);
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = m >= 7 ? y : y - 1;
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(start, 6, 1)) / 86400000) + 1;
}
function byPeriod(days, mode) {
  const g = {};
  for (const d of days) (g[periodStart(d.date, mode)] ||= []).push(d);
  return g;
}
function axisFor(mode) {
  const starts = mode === "saison" ? SAISON_STARTS : MOIS_STARTS;
  const labels = mode === "saison" ? SAISON_LABELS : MOIS_LABELS;
  return { type: "linear", min: 1, max: 366,
    afterBuildTicks: (a) => { a.ticks = starts.map((v) => ({ value: v })); },
    ticks: { callback: (v) => labels[starts.indexOf(v)] ?? "" }, grid: { display: false } };
}

// couleurs catégorielles bien différenciées ; année en cours en rouge (gras)
const YEAR_PALETTE = ["#2c6e9b", "#27ae60", "#e67e22", "#8e44ad", "#16a085",
                      "#d4a017", "#5d6d7e", "#2980b9", "#c0699b"];
function yearColors(keys) {
  const current = Math.max(...keys);
  const map = {};
  keys.filter((k) => k !== current).forEach((k, i) => { map[k] = YEAR_PALETTE[i % YEAR_PALETTE.length]; });
  map[current] = "#c0392b";
  return map;
}

// échelle "racine signée" : compresse les écarts extrêmes en gardant le signe
const sgnSqrt = (y) => Math.sign(y) * Math.sqrt(Math.abs(y));
const invSgnSqrt = (t) => Math.sign(t) * t * t;

// étiquette "numéro d'année" affichée uniquement au dernier point de la courbe
function endLabel(text, color, bold) {
  return {
    display: (ctx) => ctx.dataIndex === ctx.dataset.data.length - 1,
    anchor: "end", align: "right", offset: 4, clamp: true,
    color, font: { size: 10, weight: bold ? "bold" : "normal" },
    formatter: () => text,
  };
}

async function initPage2() {
  try {
    const hist = await fetchJSON("./data/history.json");
    _histDays = hist.days;
    renderHeader2(hist);
    setupModeToggle();
    setupCumulToggle();
    renderPeriod("civile");
  } catch (e) {
    showError(e);
  }
}

function setupModeToggle() {
  const cont = document.getElementById("mode-toggle");
  cont.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    cont.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    renderPeriod(b.dataset.mode);
  }));
}

// switch Cumul absolu / Écart : ne re-trace que la carte cumul (mode courant)
function setupCumulToggle() {
  const cont = document.getElementById("cumul-toggle");
  if (!cont) return;
  cont.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    cont.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    _cumulVue = b.dataset.vue;
    renderCumul(daysForPeriod(_periodMode), _periodMode);
  }));
}

// exclut la 1ʳᵉ période (toujours partielle : données depuis juin 2018) qui
// fausserait les courbes, surtout le cumul.
function daysForPeriod(mode) {
  const minStart = Math.min(..._histDays.map((d) => periodStart(d.date, mode)));
  return _histDays.filter((d) => periodStart(d.date, mode) !== minStart);
}

function renderPeriod(mode) {
  _periodMode = mode;
  const days = daysForPeriod(mode);
  renderYearly(days, mode);
  renderCumul(days, mode);
  const ann = annual(days, mode);
  barAnnuel("chart-reconsult", ann, (a) => +(a.reconsult / a.passages * 100).toFixed(1), " %", mode);
  barAnnuel("chart-hospit", ann, (a) => +(a.hospit / a.passages * 100).toFixed(1), " %", mode);
  renderTableAnnuelle(ann, mode);
}

function renderHeader2(hist) {
  const an = new Date(hist.meta.coverage.end).getFullYear();
  document.getElementById("period").textContent = `Année ${an} vs années précédentes`;
  renderFooter(hist);
}

// date lisible d'un jour de période (année non bissextile de référence)
function dateOfPeriodDay(x, mode) {
  const base = mode === "saison" ? Date.UTC(2022, 6, 1) : Date.UTC(2023, 0, 1);
  return new Date(base + (Math.round(x) - 1) * 86400000)
    .toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
}

const signedPct = (v) => (v == null || !isFinite(v) ? "—"
  : `${v > 0 ? "+" : ""}${v.toFixed(1).replace(".", ",")} %`);
const varSpan = (v) => `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${signedPct(v)}</span>`;

// ---- courbes interactives : surbrillance au survol/clic + choix des courbes ----
// Courbes masquées mémorisées par graphe (clé = libellé de période) : survivent
// aux bascules année/saison et cumul/écart.
const _hidden = { "chart-yearly": new Set(), "chart-cumul": new Set() };
const _pinned = {};   // graphe -> libellé de la courbe épinglée par clic

// style d'une courbe de période ; `_color`/`_base*` servent à restaurer après surbrillance
function periodStyle(color, cur, label) {
  const c = cur ? color : color + "80";   // années passées atténuées
  return { borderColor: c, backgroundColor: c, borderWidth: cur ? 3 : 1, order: cur ? 0 : 1,
    pointRadius: 0, pointHitRadius: 6, _color: color, _group: label, _baseColor: c, _baseWidth: cur ? 3 : 1, _baseOrder: cur ? 0 : 1 };
}

// met en avant le groupe `group` (courbe + éventuelle projection), estompe les autres
function highlight(chart, group) {
  chart.data.datasets.forEach((ds) => {
    if (group == null) {
      ds.borderColor = ds._baseColor; ds.borderWidth = ds._baseWidth; ds.order = ds._baseOrder;
    } else if (ds._group === group) {
      ds.borderColor = ds._color; ds.borderWidth = 3.5; ds.order = -1;
    } else {
      ds.borderColor = ds._color + "26"; ds.borderWidth = 1; ds.order = ds._baseOrder;
    }
  });
  chart.update("none");
}

// Surbrillance seulement quand le curseur est SUR une courbe (pointHitRadius) ;
// l'infobulle, elle, suit la courbe la plus proche partout. Clic sur une courbe =
// épingler (utile au doigt) ; clic dans le vide, Échap ou sortie du cadre = annuler.
function interactiveOptions(id) {
  const groupAt = (chart, els) => (els.length ? chart.data.datasets[els[0].datasetIndex]._group : null);
  return {
    interaction: { mode: "nearest", axis: "xy", intersect: true },
    onHover: (e, els, chart) => {
      if (e.type === "mouseout") _pinned[id] = null;
      chart.canvas.style.cursor = els.length ? "pointer" : "default";
      highlight(chart, groupAt(chart, els) ?? _pinned[id] ?? null);
    },
    onClick: (e, els, chart) => {
      const g = groupAt(chart, els);
      _pinned[id] = (g == null || g === _pinned[id]) ? null : g;
      highlight(chart, _pinned[id]);
    },
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const id of Object.keys(_pinned)) {
    _pinned[id] = null;
    const chart = Chart.getChart(id);
    if (chart) highlight(chart, null);
  }
});

// pastilles cliquables sous le graphe : affiche/masque chaque période, l'axe Y se recale
function renderPicker(chart, id, pickerId) {
  const el = document.getElementById(pickerId);
  const hidden = _hidden[id];
  const groups = [...new Map(chart.data.datasets.map((ds) => [ds._group, ds._color])).entries()];
  el.innerHTML = groups.map(([g, c]) =>
    `<button data-g="${g}" class="${hidden.has(g) ? "off" : ""}" style="--c:${c}"><i></i>${g}</button>`).join("")
    + `<button class="all" data-all="1">Tout afficher</button>`;
  const apply = () => {
    chart.data.datasets.forEach((ds, i) => chart.setDatasetVisibility(i, !hidden.has(ds._group)));
    el.querySelectorAll("button[data-g]").forEach((b) => b.classList.toggle("off", hidden.has(b.dataset.g)));
    chart.update();
  };
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.all) hidden.clear();
      else if (hidden.has(b.dataset.g)) hidden.delete(b.dataset.g);
      else hidden.add(b.dataset.g);
      apply();
    });
    if (b.dataset.g) {
      b.addEventListener("mouseenter", () => highlight(chart, b.dataset.g));
      b.addEventListener("mouseleave", () => highlight(chart, _pinned[id] ?? null));
    }
  });
}

function makeInteractiveChart(id, pickerId, config) {
  config.data.datasets.forEach((ds) => { ds.hidden = _hidden[id].has(ds._group); });
  Object.assign(config.options, interactiveOptions(id));
  _pinned[id] = null;
  const chart = makeChart(id, config);
  renderPicker(chart, id, pickerId);
  return chart;
}

function renderYearly(days, mode) {
  const g = byPeriod(days, mode);
  const keys = Object.keys(g).map(Number).sort((a, b) => a - b);
  const colors = yearColors(keys);
  const current = Math.max(...keys);
  const datasets = keys.map((k) => {
    const label = periodLabel(k, mode);
    const ma = movingAvg(g[k].map((d) => (d.incomplete ? null : d.passages)), 14);
    return {
      label,
      data: g[k].map((d, i) => ({ x: dayOfPeriod(d.date, mode), y: ma[i] }))
        .filter((p) => p.y != null && p.x <= 365),
      tension: .3, ...periodStyle(colors[k], k === current, label),
      datalabels: endLabel(label, colors[k], k === current),
    };
  });
  makeInteractiveChart("chart-yearly", "picker-yearly", {
    type: "line", data: { datasets },
    options: { responsive: true, maintainAspectRatio: false, spanGaps: true,
      layout: { padding: { right: mode === "saison" ? 58 : 40 } },          // place pour les labels de fin
      plugins: { legend: { display: false },     // remplacée par les labels de fin + pastilles
        tooltip: { mode: "nearest", axis: "xy", intersect: false, callbacks: {
          title: (items) => dateOfPeriodDay(items[0].parsed.x, mode),
          label: (c) => `${c.dataset.label} : ${num(Math.round(c.parsed.y))} passages/j` } } },
      scales: { x: axisFor(mode),
        y: { title: { display: true, text: "Passages (moy. mobile 14 j)" } } } },  // axe dézoomé
  });
}

// Projection de fin de période : le cumul actuel est prolongé selon le profil
// saisonnier des périodes passées complètes. part_k(x) = cumul_k(x) / total_k ;
// part de référence = moyenne tronquée (refValue) ; total estimé = cumul / part(x).
function projection(cum, keys, current) {
  const xs = Object.keys(cum[current]).map(Number).filter((x) => x <= 365);
  if (!xs.length) return null;
  const xNow = Math.max(...xs);
  const cumNow = cum[current][xNow];
  const past = keys.filter((k) => k !== current && cum[k][365] != null);
  if (past.length < 2 || xNow >= 365) return null;
  const part = (x) => refValue(past.map((k) => cum[k][x] / cum[k][365]).filter((v) => !isNaN(v)));
  const total = cumNow / part(xNow);
  // fourchette = estimations année par année, sans les extrêmes (comme refValue)
  let est = past.map((k) => cumNow / (cum[k][xNow] / cum[k][365])).sort((a, b) => a - b);
  if (est.length >= 5) est = est.slice(1, -1);
  const pts = [];
  for (let x = xNow; x <= 365; x++) pts.push({ x, y: total * part(x) });
  return { xNow, cumNow, total, lo: est[0], hi: est[est.length - 1], pts };
}

// Bandeau au-dessus du cumul : cumul à date, variations vs dernière période et
// vs moyenne des 3 dernières (au même jour), projection de fin de période.
function renderCumulStats(cum, keys, current, proj, mode) {
  const el = document.getElementById("cumul-stats");
  const xs = Object.keys(cum[current]).map(Number).filter((x) => x <= 365);
  if (!xs.length) { el.innerHTML = ""; return; }
  const xNow = Math.max(...xs), cumNow = cum[current][xNow];
  const prev = keys.filter((k) => k < current && cum[k][xNow] != null);
  const last = prev[prev.length - 1];
  const last3 = prev.slice(-3);
  const moy = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const lbl = (k) => periodLabel(k, mode);
  const v = (a, b) => (b ? (a / b - 1) * 100 : null);
  const span3 = last3.length ? `${lbl(last3[0])} à ${lbl(last3[last3.length - 1])}` : "";
  const mini = (vHtml, l, cls = "") => `<div class="mini ${cls}"><div class="v">${vHtml}</div><div class="l">${l}</div></div>`;

  let html = mini(num(cumNow), `Cumul ${lbl(current)} au ${dateOfPeriodDay(xNow, mode)}`);
  if (last != null) html += mini(varSpan(v(cumNow, cum[last][xNow])), `vs ${lbl(last)} à la même date`);
  if (last3.length) html += mini(varSpan(v(cumNow, moy(last3.map((k) => cum[k][xNow])))),
    `vs moyenne ${span3} à la même date`);
  if (proj) {
    const totals = (ks) => ks.filter((k) => cum[k][365] != null).map((k) => cum[k][365]);
    const t3 = totals(last3);
    const lastTot = last != null ? cum[last][365] : null;
    html += mini(`≈ ${num(Math.round(proj.total / 100) * 100)}`,
      `Projection fin ${lbl(current)} (${num(Math.round(proj.lo / 100) * 100)} – ${num(Math.round(proj.hi / 100) * 100)})<br>`
      + (lastTot ? `vs ${lbl(last)} : ${varSpan(v(proj.total, lastTot))}` : "")
      + (t3.length ? ` · vs moy. 3 dern. : ${varSpan(v(proj.total, moy(t3)))}` : ""), "proj");
  }
  el.innerHTML = html;
}

// Deux vues (switch) :
//  - "cumul" : cumul absolu des passages (stable, mais écarts écrasés par l'échelle)
//  - "ecart" : écart au cumul de référence des années passées (moyenne tronquée),
//    en échelle racine signée pour limiter l'impact des extrêmes.
// La période en cours est prolongée en pointillés par sa projection.
function renderCumul(days, mode) {
  const g = byPeriod(days, mode);
  const keys = Object.keys(g).map(Number).sort((a, b) => a - b);
  const colors = yearColors(keys);
  const current = Math.max(...keys);

  const cum = {};  // période -> { jourDePériode: cumul }
  for (const k of keys) {
    let c = 0; const mx = {};
    for (const d of g[k]) { c += d.passages; mx[dayOfPeriod(d.date, mode)] = c; }
    cum[k] = mx;
  }
  const proj = projection(cum, keys, current);
  renderCumulStats(cum, keys, current, proj, mode);

  const curLabel = periodLabel(current, mode);
  const lineFor = (k, data) => {
    const label = periodLabel(k, mode);
    return { label, data, tension: .2, ...periodStyle(colors[k], k === current, label),
      datalabels: proj && k === current ? { display: false } : endLabel(label, colors[k], k === current) };
  };
  const projFor = (data) => ({
    label: `${curLabel} (projection)`, data, tension: .2, borderDash: [6, 4],
    ...periodStyle(colors[current], true, curLabel), borderWidth: 2, _baseWidth: 2,
    datalabels: endLabel(`${curLabel} ≈ ${num(Math.round(proj.total / 100) * 100)}`, colors[current], true),
  });
  const pad = { right: proj ? 96 : mode === "saison" ? 58 : 40 };
  const titleCb = (items) => dateOfPeriodDay(items[0].parsed.x, mode);

  if (_cumulVue === "cumul") {
    const datasets = keys.map((k) => lineFor(k,
      Object.keys(cum[k]).map(Number).filter((x) => x <= 365).sort((a, b) => a - b).map((x) => ({ x, y: cum[k][x] }))));
    if (proj) datasets.push(projFor(proj.pts));
    makeInteractiveChart("chart-cumul", "picker-cumul", {
      type: "line", data: { datasets },
      options: { responsive: true, maintainAspectRatio: false, layout: { padding: pad },
        plugins: { legend: { display: false },
          tooltip: { mode: "nearest", axis: "xy", intersect: false, callbacks: { title: titleCb,
            label: (c) => `${c.dataset.label} : ${c.dataset.borderDash ? "≈ " : ""}${num(Math.round(c.parsed.y))} passages` } } },
        scales: { x: axisFor(mode), y: { beginAtZero: true, title: { display: true, text: "Passages cumulés" } } } },
    });
    return;
  }

  // vue "écart" : référence = moyenne tronquée des années passées (hors année en
  // cours). On ignore le jour 366 (sinon la réf se réduit aux bissextiles le 31/12).
  const refYears = keys.filter((k) => k !== current);
  const ref = {};
  for (let x = 1; x <= 365; x++) {
    const vals = refYears.map((k) => cum[k][x]).filter((v) => v != null);
    if (vals.length) ref[x] = refValue(vals);
  }
  const ecart = (x, y) => ({ x, y: sgnSqrt(Math.round(y - ref[x])) });
  const datasets = keys.map((k) => lineFor(k,
    Object.keys(cum[k]).map(Number).filter((x) => x <= 365 && ref[x] != null)
      .sort((a, b) => a - b).map((x) => ecart(x, cum[k][x]))));
  if (proj) datasets.push(projFor(proj.pts.filter((p) => ref[p.x] != null).map((p) => ecart(p.x, p.y))));
  const TICKS = [-10000, -7000, -5000, -3000, -2000, -1000, 0, 1000, 2000, 3000, 5000, 7000, 10000];
  makeInteractiveChart("chart-cumul", "picker-cumul", {
    type: "line", data: { datasets },
    options: { responsive: true, maintainAspectRatio: false, layout: { padding: pad },
      plugins: { legend: { display: false },
        tooltip: { mode: "nearest", axis: "xy", intersect: false, callbacks: { title: titleCb,
          label: (c) => { const r = Math.round(invSgnSqrt(c.parsed.y)); return `${c.dataset.label} : ${r > 0 ? "+" : ""}${num(r)} passages`; } } } },
      scales: { x: axisFor(mode),
        y: { title: { display: true, text: "Écart au cumul de référence (passages, échelle compressée)" },
          // graduations recalculées sur les seules courbes visibles
          afterBuildTicks: (axis) => {
            let lo = 0, hi = 0;
            axis.chart.data.datasets.forEach((ds, i) => {
              if (!axis.chart.isDatasetVisible(i)) return;
              ds.data.forEach((p) => { const r = invSgnSqrt(p.y); if (r < lo) lo = r; if (r > hi) hi = r; });
            });
            axis.ticks = TICKS.filter((v) => v >= lo && v <= hi).map((v) => ({ value: sgnSqrt(v) }));
          },
          ticks: { callback: (v) => { const r = Math.round(invSgnSqrt(v)); return (r > 0 ? "+" : "") + num(r); } } } } },
  });
}

function annual(days, mode) {
  const g = byPeriod(days, mode);
  const out = {};
  for (const k of Object.keys(g)) {
    const a = { passages: 0, hospit: 0, reorient: 0, reconsult: 0, dssum: 0, m3: 0, a2: 0, a15: 0 };
    for (const d of g[k]) {
      a.passages += d.passages; a.hospit += d.hospit; a.reorient += d.reorient;
      a.reconsult += d.reconsult_j3; a.dssum += d.ds_sum_h || 0;
      a.m3 += d.age_surv?.m3 || 0; a.a2 += d.age_surv?.a2 || 0; a.a15 += d.age_surv?.a15 || 0;
    }
    out[k] = a;
  }
  return out;
}

function barAnnuel(id, ann, valueFn, suffixe, mode) {
  const keys = Object.keys(ann).map(Number).sort((a, b) => a - b);
  makeChart(id, {
    type: "bar",
    data: { labels: keys.map((k) => periodLabel(k, mode)),
      datasets: [{ data: keys.map((k) => valueFn(ann[k])), backgroundColor: PALETTE.primary,
        datalabels: { display: true, anchor: "end", align: "end", color: "#6b7280", font: { size: 9 },
          formatter: (v) => v + (suffixe || "") } }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, grace: "8%", ticks: { callback: (v) => v + (suffixe || "") } } } },
  });
}

function renderTableAnnuelle(ann, mode) {
  const keys = Object.keys(ann).map(Number).sort((a, b) => b - a);
  const rows = keys.map((k) => {
    const a = ann[k];
    return `<tr><td>${periodLabel(k, mode)}</td><td>${num(a.passages)}</td>
      <td>${pct(a.hospit / a.passages)}</td>
      <td>${heures(a.dssum / a.passages)}</td>
      <td>${pct(a.reorient / a.passages)}</td>
      <td>${pct(a.reconsult / a.passages)}</td>
      <td>${pct(a.m3 / a.passages)}</td>
      <td>${pct(a.a2 / a.passages)}</td>
      <td>${pct(a.a15 / a.passages)}</td></tr>`;
  }).join("");
  document.getElementById("table-annuelle").innerHTML =
    `<table><thead><tr><th>${mode === "saison" ? "Saison" : "Année"}</th><th>Passages</th><th>Hospit.</th>
     <th>DS moyenne</th><th>Réorient.</th><th>Reconsult. J3</th>
     <th>&lt; 3 mois</th><th>&lt; 2 ans</th><th>&gt; 15 ans</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function showError(e) {
  document.querySelector("main").innerHTML =
    `<div class="error"><strong>Impossible de charger les données.</strong><br>${e.message}<br><br>
     Si tu ouvres le fichier en local, lance un petit serveur :
     <code>cd web &amp;&amp; python3 -m http.server</code> puis ouvre <code>http://localhost:8000</code>.</div>`;
}
