/* ============================================================
   Assay Bench — Silent Gear material / alloy ranking calculator
   Fully generic: works with any material export TSV that shares
   the same column layout (header row + one row per material entry).
   ============================================================ */

(function () {
  "use strict";

  // ---- The checklist stats, in the order requested ----
  const STAT_FIELDS = [
    "Durability", "Armor Durability", "Repair Efficiency", "Repair Bonus",
    "Enchantment Value", "Charging Value", "Rarity", "Harvest Tier",
    "Harvest Speed", "Block Reach", "Attack Damage", "Attack Speed",
    "Attack Reach", "Magic Damage", "Ranged Damage", "Draw Speed",
    "Projectile Speed", "Projectile Accuracy", "Armor", "Armor Toughness",
    "Knockback Resistance", "Magic Armor"
  ];

  const REQUIRED_HEADERS = ["Name", "Type", "ID"];
  const RESULTS_PER_PAGE = 10;
  const MAX_COMBOS = 250000; // hard safety cap for the alloy tab

  const SYNERGY_MULTI = 1.1;
  const MIN_SYN = 0.1;
  const MAX_SYN = 2.0;
  const RARITY_WEIGHT = 0.001;
  const NO_SHARED_PENALTY = 0.2;
  const SHARED_BONUS = 0.015;

  // ---------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------

  function parseTSV(text) {
    const lines = text.split(/\r\n|\n|\r/);
    // find first non-empty line as header
    let headerIdx = 0;
    while (headerIdx < lines.length && lines[headerIdx].trim() === "") headerIdx++;
    if (headerIdx >= lines.length) throw new Error("File appears to be empty.");

    const headers = lines[headerIdx].split("\t").map(h => h.trim());
    const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
    if (missing.length) {
      throw new Error(
        "This doesn't look like a material export — missing column(s): " + missing.join(", ") +
        ". Expected a header row with at least Name, Type, and ID."
      );
    }

    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      rows.push(lines[i].split("\t"));
    }
    if (rows.length === 0) throw new Error("No material rows found below the header.");
    return { headers, rows };
  }

  // Parses one cell into zero or more {op, value} tokens.
  function parsePart(part) {
    let m;

    m = part.match(/^\^(-?\d*\.?\d+)$/); // ^N -> explicit MAX marker (not seen in vanilla exports, supported for completeness)
    if (m) return { op: "MAX", value: parseFloat(m[1]) };

    m = part.match(/^[xX](-?\d*\.?\d+)$/); // xN -> multiply total
    if (m) return { op: "MULTIPLY_TOTAL", value: parseFloat(m[1]) - 1 };

    m = part.match(/^(-?\d*\.?\d+)[xX]$/); // Nx -> average, multiplier-style baseline
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) };

    m = part.match(/^([+-]\d*\.?\d+)%$/); // signed percent -> multiply base
    if (m) return { op: "MULTIPLY_BASE", value: parseFloat(m[1]) / 100 };

    m = part.match(/^(\d*\.?\d+)%$/); // bare percent -> average fraction
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) / 100 };

    m = part.match(/^([+-]\d*\.?\d+)$/); // signed plain number -> add
    if (m) return { op: "ADD", value: parseFloat(m[1]) };

    m = part.match(/^(-?\d*\.?\d+)$/); // plain number -> average
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) };

    m = part.match(/\(\s*(-?\d*\.?\d+)\s*\)/); // fallback: "name (N)" e.g. Rarity / Harvest Tier
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) };

    return null; // non-numeric / unparseable text — ignored
  }

  function parseCellTokens(raw) {
    if (!raw) return [];
    const text = String(raw).trim();
    if (!text) return [];
    const parts = text.split(",").map(s => s.trim()).filter(Boolean);
    const tokens = [];
    for (const part of parts) {
      const t = parsePart(part);
      if (t) tokens.push(t);
    }
    return tokens;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---------------------------------------------------------
  // Compute engine (recreates NumberProperty.compute)
  // ---------------------------------------------------------

  function getPrimaryMod(tokens) {
    let primaryMod = -1;
    for (const t of tokens) {
      if (primaryMod < 0) primaryMod = t.value;
    }
    return primaryMod > 0 ? primaryMod : 1;
  }

  function weightedAverage(tokens, primaryMod) {
    let ret = 0, totalWeight = 0;
    for (const t of tokens) {
      const w = 1 + t.value / (1 + Math.abs(primaryMod));
      totalWeight += w;
      ret += t.value * w;
    }
    return totalWeight > 0 ? ret / totalWeight : 0;
  }

  // materials: ordered array of material objects (first = primary/first-forged)
  function computeStat(materials, stat) {
    const modifiers = [];
    for (const m of materials) {
      const toks = m.tokensByStat[stat];
      if (toks && toks.length) {
        for (const t of toks) modifiers.push(t);
      }
    }
    const avgTokens = modifiers.filter(t => t.op === "AVERAGE");
    const primaryMod = getPrimaryMod(avgTokens);
    let f0 = weightedAverage(avgTokens, primaryMod);
    for (const t of modifiers) if (t.op === "MAX") f0 = Math.max(f0, t.value);
    let f1 = f0;
    for (const t of modifiers) if (t.op === "MULTIPLY_BASE") f1 += f0 * t.value;
    for (const t of modifiers) if (t.op === "MULTIPLY_TOTAL") f1 *= (1 + t.value);
    for (const t of modifiers) if (t.op === "ADD") f1 += t.value;
    return f1;
  }

  // ---------------------------------------------------------
  // Synergy engine (recreates SynergyUtils.getSynergy)
  // ---------------------------------------------------------

  function computeSynergy(materials) {
    if (materials.length < 2) return 1;
    const n = materials.length;

    const uniqueKeys = new Set(materials.map(m => m.key));
    const x = uniqueKeys.size;
    const a = SYNERGY_MULTI;
    let synergy = a * (x / (x + a)) + 1 / (1 + a);

    const catCounts = new Map();
    for (const m of materials) {
      for (const c of m.categories) catCounts.set(c, (catCounts.get(c) || 0) + 1);
    }

    let sharedAll = false;
    for (const v of catCounts.values()) { if (v === n) { sharedAll = true; break; } }
    if (!sharedAll) synergy -= NO_SHARED_PENALTY;

    for (const v of catCounts.values()) {
      if (v > 1) synergy += SHARED_BONUS * (v / (n - x + 1));
    }

    const primaryRarity = materials[0].rarityValue;
    let maxRarity = -Infinity;
    for (const m of materials) if (m.rarityValue > maxRarity) maxRarity = m.rarityValue;

    if (maxRarity > 0) {
      const seen = new Set();
      for (const m of materials) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        synergy -= RARITY_WEIGHT * Math.abs(primaryRarity - m.rarityValue);
      }
    }

    return clamp(synergy, MIN_SYN, MAX_SYN);
  }

  // ---------------------------------------------------------
  // Building materials from parsed rows
  // ---------------------------------------------------------

  function buildMaterials(headers, rows) {
    const materials = [];
    rows.forEach((cols, rowIdx) => {
      const raw = {};
      headers.forEach((h, i) => { raw[h] = (cols[i] || "").trim(); });

      const id = raw["ID"] || "";
      const type = raw["Type"] || "";
      const name = raw["Name"] || "(unnamed)";
      const categories = (raw["Categories"] || "").split(",").map(s => s.trim()).filter(Boolean);

      const material = {
        rowIdx,
        pack: raw["Pack"] || "",
        name, type, id,
        categories,
        traits: raw["Traits"] || "",
        isExample: /:example$/i.test(id) || name.trim().toLowerCase() === "example",
        key: (id || name) + "::" + type,
        raw,
        tokensByStat: {}
      };
      for (const stat of STAT_FIELDS) material.tokensByStat[stat] = parseCellTokens(raw[stat]);
      material.rarityValue = computeStat([material], "Rarity");
      material.harvestTierValue = computeStat([material], "Harvest Tier");

      materials.push(material);
    });
    return materials;
  }

  // ---------------------------------------------------------
  // Combination generation (order-reduced: only the primary
  // slot's identity matters; everything after it is unordered)
  // ---------------------------------------------------------

  function nMultichoose(n, r) {
    // number of multisets of size r from n items = C(n + r - 1, r)
    if (r < 0 || n <= 0) return r === 0 ? 1 : 0;
    const N = n + r - 1;
    let R = Math.min(r, N - r);
    let result = 1;
    for (let i = 0; i < R; i++) result = (result * (N - i)) / (i + 1);
    return result;
  }

  function estimateComboCount(n, maxK) {
    let total = 0;
    for (let k = 1; k <= maxK; k++) {
      total += (k === 1) ? n : n * nMultichoose(n, k - 1);
    }
    return total;
  }

  function* multisetCombos(n, r) {
    if (r === 0) { yield []; return; }
    if (n === 0) return;
    const idx = new Array(r).fill(0);
    while (true) {
      yield idx.slice();
      let i = r - 1;
      while (i >= 0 && idx[i] === n - 1) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < r; j++) idx[j] = idx[i];
    }
  }

  function generateCombos(pool, maxK) {
    const n = pool.length;
    const combos = [];
    for (let k = 1; k <= maxK; k++) {
      if (k === 1) {
        for (let p = 0; p < n; p++) combos.push([pool[p]]);
      } else {
        for (let p = 0; p < n; p++) {
          for (const rest of multisetCombos(n, k - 1)) {
            const combo = [pool[p]];
            for (const ri of rest) combo.push(pool[ri]);
            combos.push(combo);
          }
        }
      }
    }
    return combos;
  }

  // ---------------------------------------------------------
  // Ranking
  // ---------------------------------------------------------

  function evaluateCombos(combos, selectedStats) {
    return combos.map(mats => {
      const synergy = computeSynergy(mats);
      const values = {};
      for (const stat of selectedStats) values[stat] = computeStat(mats, stat) * synergy;
      return { materials: mats, synergy, values };
    });
  }

  function rankItems(items, selectedStats) {
    const n = items.length;
    if (n === 0 || selectedStats.length === 0) {
      return items.map(it => ({ item: it, avgRank: 0 }));
    }
    const rankSums = new Array(n).fill(0);

    for (const stat of selectedStats) {
      const arr = items.map((it, i) => ({ i, v: it.values[stat] }));
      arr.sort((a, b) => a.v - b.v);
      let idx = 0;
      while (idx < n) {
        let j = idx;
        while (j + 1 < n && arr[j + 1].v === arr[idx].v) j++;
        const avgRank = (idx + 1 + j + 1) / 2;
        for (let m = idx; m <= j; m++) rankSums[arr[m].i] += avgRank;
        idx = j + 1;
      }
    }

    const result = items.map((it, i) => ({ item: it, avgRank: rankSums[i] / selectedStats.length }));
    result.sort((a, b) => a.avgRank - b.avgRank);
    return result;
  }

  // ---------------------------------------------------------
  // App state
  // ---------------------------------------------------------

  const state = {
    headers: [],
    materials: [],
    selectedStats: new Set(),
    tab: "single",
    single: { page: 1, ranked: [] },
    alloy: { page: 1, ranked: [], computed: false }
  };

  // ---------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of children) e.appendChild(c);
    return e;
  }

  function formatNum(v) {
    if (!isFinite(v)) return "0";
    const rounded = Math.round(v * 100) / 100;
    return rounded.toString();
  }

  // ---------------------------------------------------------
  // Loading a file
  // ---------------------------------------------------------

  function loadTSVText(text, label) {
    const errBox = $("#uploadError");
    errBox.hidden = true;
    try {
      const { headers, rows } = parseTSV(text);
      state.headers = headers;
      state.materials = buildMaterials(headers, rows);
      $("#dataFileName").textContent = label;
      const nonExample = state.materials.filter(m => !m.isExample).length;
      $("#dataSummary").textContent =
        " — " + state.materials.length + " entries loaded (" + nonExample + " usable, " +
        (state.materials.length - nonExample) + " template rows)";
      $("#uploadSection").hidden = true;
      $("#app").hidden = false;
      initAppUI();
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = e.message || String(e);
    }
  }

  function initAppUI() {
    buildStatChecklist();
    buildSingleTypeFilter();
    buildAlloyTypeChecks();
    buildAlloyMaterialPicker();
    updateComboEstimate();
    renderSingleTab();
    renderAlloyTab();
  }

  // ---------------------------------------------------------
  // Stat checklist
  // ---------------------------------------------------------

  function buildStatChecklist() {
    const wrap = $("#statChecklist");
    wrap.innerHTML = "";
    STAT_FIELDS.forEach(stat => {
      const id = "stat_" + stat.replace(/\s+/g, "_");
      const label = el("label", { class: "stat-chip", for: id });
      const input = el("input", { type: "checkbox", id });
      input.addEventListener("change", () => {
        if (input.checked) state.selectedStats.add(stat);
        else state.selectedStats.delete(stat);
        label.classList.toggle("checked", input.checked);
        updateStatsCount();
        renderSingleTab();
        state.alloy.computed = false;
        renderAlloyTab();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(stat));
      wrap.appendChild(label);
    });
    updateStatsCount();
  }

  function updateStatsCount() {
    $("#statsCount").textContent = state.selectedStats.size + " of " + STAT_FIELDS.length + " selected";
  }

  $("#statsAllBtn").addEventListener("click", () => {
    STAT_FIELDS.forEach(s => state.selectedStats.add(s));
    syncStatCheckboxes();
    updateStatsCount();
    renderSingleTab();
    state.alloy.computed = false;
    renderAlloyTab();
  });
  $("#statsNoneBtn").addEventListener("click", () => {
    state.selectedStats.clear();
    syncStatCheckboxes();
    updateStatsCount();
    renderSingleTab();
    state.alloy.computed = false;
    renderAlloyTab();
  });
  function syncStatCheckboxes() {
    $$("#statChecklist input").forEach(input => {
      input.checked = state.selectedStats.has(STAT_FIELDS.find(s => "stat_" + s.replace(/\s+/g, "_") === input.id));
      input.closest(".stat-chip").classList.toggle("checked", input.checked);
    });
  }

  // ---------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------

  $$(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.tab = btn.dataset.tab;
      $$(".tab-panel").forEach(p => p.classList.remove("active"));
      $("#tab-" + state.tab).classList.add("active");
    });
  });

  // ---------------------------------------------------------
  // Tab 1: single materials
  // ---------------------------------------------------------

  function buildSingleTypeFilter() {
    const types = Array.from(new Set(state.materials.map(m => m.type).filter(Boolean))).sort();
    const sel = $("#singleTypeFilter");
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "" }, [document.createTextNode("All types")]));
    types.forEach(t => sel.appendChild(el("option", { value: t }, [document.createTextNode(t)])));
    sel.value = "";
    sel.addEventListener("change", renderSingleTab);
  }

  $("#singleHideExamples").addEventListener("change", renderSingleTab);

  function getSingleCandidates() {
    const typeFilter = $("#singleTypeFilter").value;
    const hideEx = $("#singleHideExamples").checked;
    return state.materials.filter(m => {
      if (hideEx && m.isExample) return false;
      if (typeFilter && m.type !== typeFilter) return false;
      return true;
    });
  }

  function renderSingleTab() {
    if (!state.materials.length) return;
    const candidates = getSingleCandidates();
    const combos = candidates.map(m => [m]);
    const evaluated = evaluateCombos(combos, Array.from(state.selectedStats));
    state.single.ranked = rankItems(evaluated, Array.from(state.selectedStats));
    state.single.page = 1;
    renderResultsPage("single");
  }

  // ---------------------------------------------------------
  // Tab 2: forged alloys
  // ---------------------------------------------------------

  function buildAlloyTypeChecks() {
    const types = Array.from(new Set(state.materials.map(m => m.type).filter(Boolean))).sort();
    const wrap = $("#alloyTypeChecks");
    wrap.innerHTML = "";
    types.forEach(t => {
      const id = "atype_" + t.replace(/\s+/g, "_");
      const label = el("label", { for: id });
      const input = el("input", { type: "checkbox", id });
      input.checked = (t === "Main"); // sensible realistic default
      input.addEventListener("change", () => {
        label.classList.toggle("checked", input.checked);
        buildAlloyMaterialPicker();
        updateComboEstimate();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(t));
      label.classList.toggle("checked", input.checked);
      wrap.appendChild(label);
    });
  }

  function getAlloyTypeFilterSet() {
    const set = new Set();
    $$("#alloyTypeChecks input:checked").forEach(inp => {
      const label = inp.closest("label");
      set.add(label.textContent.trim());
    });
    return set;
  }

  const alloySelection = new Set(); // keys of materials chosen for the candidate pool

  function alloyFilteredList() {
    const hideEx = $("#alloyHideExamples").checked;
    const nameFilter = $("#alloyNameFilter").value.trim().toLowerCase();
    const typeSet = getAlloyTypeFilterSet();
    return state.materials.filter(m => {
      if (hideEx && m.isExample) return false;
      if (typeSet.size && !typeSet.has(m.type)) return false;
      if (nameFilter && !m.name.toLowerCase().includes(nameFilter)) return false;
      return true;
    });
  }

  function buildAlloyMaterialPicker() {
    const list = alloyFilteredList();
    const wrap = $("#alloyMaterialPicker");
    wrap.innerHTML = "";
    list.forEach(m => {
      const id = "amat_" + m.rowIdx;
      const label = el("label", { for: id });
      const input = el("input", { type: "checkbox", id });
      input.checked = alloySelection.has(m.key);
      input.addEventListener("change", () => {
        if (input.checked) alloySelection.add(m.key);
        else alloySelection.delete(m.key);
        updateAlloySelectedCount();
        updateComboEstimate();
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(m.name + " "));
      const typeSpan = el("span", { class: "mp-type" });
      typeSpan.appendChild(document.createTextNode(m.type));
      label.appendChild(typeSpan);
      wrap.appendChild(label);
    });
    updateAlloySelectedCount();
  }

  function updateAlloySelectedCount() {
    $("#alloySelectedCount").textContent = alloySelection.size + " material(s) selected for the alloy pool";
  }

  $("#alloyNameFilter").addEventListener("input", () => { buildAlloyMaterialPicker(); });
  $("#alloyHideExamples").addEventListener("change", () => { buildAlloyMaterialPicker(); updateComboEstimate(); });

  $("#alloySelectVisibleBtn").addEventListener("click", () => {
    alloyFilteredList().forEach(m => alloySelection.add(m.key));
    buildAlloyMaterialPicker();
    updateComboEstimate();
  });
  $("#alloyClearBtn").addEventListener("click", () => {
    alloySelection.clear();
    buildAlloyMaterialPicker();
    updateComboEstimate();
  });

  const alloySizeInput = $("#alloySize");
  alloySizeInput.addEventListener("input", () => {
    $("#alloySizeVal").textContent = alloySizeInput.value;
    updateComboEstimate();
  });

  function getAlloyPool() {
    return state.materials.filter(m => alloySelection.has(m.key));
  }

  function updateComboEstimate() {
    const n = getAlloyPool().length;
    const maxK = parseInt(alloySizeInput.value, 10);
    const estBox = $("#comboEstimate");
    const computeBtn = $("#computeAlloysBtn");
    if (n === 0) {
      estBox.textContent = "Select at least one candidate material.";
      estBox.className = "combo-estimate";
      computeBtn.disabled = true;
      return;
    }
    const total = Math.round(estimateComboCount(n, maxK));
    const over = total > MAX_COMBOS;
    estBox.textContent = total.toLocaleString() + " combinations to evaluate (limit " + MAX_COMBOS.toLocaleString() + ")" +
      (over ? " — reduce materials or max size." : "");
    estBox.className = "combo-estimate " + (over ? "over" : "ok");
    computeBtn.disabled = over || state.selectedStats.size === 0;
  }

  $("#computeAlloysBtn").addEventListener("click", () => {
    const pool = getAlloyPool();
    const maxK = parseInt(alloySizeInput.value, 10);
    const msg = $("#alloyComputeMsg");
    if (state.selectedStats.size === 0) {
      msg.textContent = "Select at least one stat above before computing.";
      return;
    }
    msg.textContent = "Computing…";
    setTimeout(() => {
      const combos = generateCombos(pool, maxK);
      const evaluated = evaluateCombos(combos, Array.from(state.selectedStats));
      state.alloy.ranked = rankItems(evaluated, Array.from(state.selectedStats));
      state.alloy.page = 1;
      state.alloy.computed = true;
      msg.textContent = "Ranked " + combos.length.toLocaleString() + " alloy combinations.";
      renderResultsPage("alloy");
    }, 20);
  });

  function renderAlloyTab() {
    updateComboEstimate();
    if (!state.alloy.computed) {
      $("#alloyResults").innerHTML = "";
      $("#alloyPager").innerHTML = "";
      $("#alloyComputeMsg").textContent = "";
    }
  }

  // ---------------------------------------------------------
  // Rendering result cards + pagination
  // ---------------------------------------------------------

  function renderResultsPage(which) {
    const st = state[which];
    const container = $(which === "single" ? "#singleResults" : "#alloyResults");
    const pagerEl = $(which === "single" ? "#singlePager" : "#alloyPager");
    container.innerHTML = "";

    const selectedStats = Array.from(state.selectedStats);
    if (selectedStats.length === 0) {
      container.appendChild(el("p", { class: "hint" }, [document.createTextNode("Select at least one stat above to see rankings.")]));
      pagerEl.innerHTML = "";
      return;
    }
    if (st.ranked.length === 0) {
      container.appendChild(el("p", { class: "hint" }, [document.createTextNode("No materials match the current filters.")]));
      pagerEl.innerHTML = "";
      return;
    }

    const totalPages = Math.max(1, Math.ceil(st.ranked.length / RESULTS_PER_PAGE));
    st.page = clamp(st.page, 1, totalPages);
    const startIdx = (st.page - 1) * RESULTS_PER_PAGE;
    const pageItems = st.ranked.slice(startIdx, startIdx + RESULTS_PER_PAGE);

    pageItems.forEach((entry, i) => {
      container.appendChild(renderResultCard(entry, startIdx + i + 1, selectedStats));
    });

    pagerEl.innerHTML = "";
    const prevBtn = el("button", { class: "btn btn-ghost btn-sm" }, [document.createTextNode("← Prev")]);
    prevBtn.disabled = st.page <= 1;
    prevBtn.addEventListener("click", () => { st.page--; renderResultsPage(which); window.scrollTo({ top: container.offsetTop - 20, behavior: "smooth" }); });
    const nextBtn = el("button", { class: "btn btn-ghost btn-sm" }, [document.createTextNode("Next →")]);
    nextBtn.disabled = st.page >= totalPages;
    nextBtn.addEventListener("click", () => { st.page++; renderResultsPage(which); window.scrollTo({ top: container.offsetTop - 20, behavior: "smooth" }); });
    const label = el("span", {}, [document.createTextNode("Page " + st.page + " of " + totalPages + " (" + st.ranked.length.toLocaleString() + " results)")]);
    pagerEl.appendChild(prevBtn);
    pagerEl.appendChild(label);
    pagerEl.appendChild(nextBtn);
  }

  function renderResultCard(entry, rank, selectedStats) {
    const item = entry.item;
    const mats = item.materials;

    const card = el("div", { class: "result-card" });
    card.appendChild(el("div", { class: "rank-badge" }, [document.createTextNode(String(rank))]));

    const body = el("div", { class: "result-body" });

    const title = el("div", { class: "result-title" });
    const nameText = mats.length === 1 ? mats[0].name : mats.map(m => m.name).join(" + ");
    title.appendChild(el("h3", {}, [document.createTextNode(nameText)]));
    if (mats.length > 1) {
      const synClass = item.synergy >= 1 ? "pos" : "neg";
      title.appendChild(el("span", { class: "synergy-tag " + synClass }, [document.createTextNode("synergy " + formatNum(item.synergy) + "x")]));
    }
    body.appendChild(title);

    if (mats.length > 1) {
      const compParts = mats.map((m, i) => (i === 0 ? m.name + " (primary)" : m.name));
      body.appendChild(el("div", { class: "composition" }, [document.createTextNode(compParts.join(" + "))]));
    } else {
      body.appendChild(el("div", { class: "composition" }, [document.createTextNode(mats[0].type + " · " + (mats[0].categories.join(", ") || "—"))]));
    }

    const statValues = el("div", { class: "stat-values" });
    selectedStats.forEach(stat => {
      const v = item.values[stat];
      const span = el("span", {}, [document.createTextNode(stat + ": ")]);
      span.appendChild(el("b", {}, [document.createTextNode(formatNum(v))]));
      statValues.appendChild(span);
    });
    body.appendChild(statValues);

    body.appendChild(el("div", { class: "avg-rank" }, [document.createTextNode("Average rank: " + formatNum(entry.avgRank))]));

    card.appendChild(body);
    return card;
  }

  // ---------------------------------------------------------
  // File input wiring
  // ---------------------------------------------------------

  const fileInput = $("#fileInput");
  const dropzone = $("#dropzone");

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadTSVText(reader.result, file.name);
    reader.onerror = () => {
      const errBox = $("#uploadError");
      errBox.hidden = false;
      errBox.textContent = "Couldn't read that file.";
    };
    reader.readAsText(file);
  });

  ["dragenter", "dragover"].forEach(evt => {
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(evt => {
    dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove("dragover"); });
  });
  dropzone.addEventListener("drop", e => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadTSVText(reader.result, file.name);
    reader.readAsText(file);
  });

  $("#sampleDataBtn").addEventListener("click", () => {
    if (typeof SAMPLE_TSV === "undefined") return;
    loadTSVText(SAMPLE_TSV, "sample-data.tsv (bundled example)");
  });

  $("#reloadBtn").addEventListener("click", () => {
    state.materials = [];
    alloySelection.clear();
    state.alloy.computed = false;
    $("#app").hidden = true;
    $("#uploadSection").hidden = false;
    $("#uploadError").hidden = true;
    fileInput.value = "";
  });

})();
