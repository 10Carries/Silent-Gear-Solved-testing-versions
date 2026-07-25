/* ============================================================
   Silent Gear Solved — material / alloy ranking calculator
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
  const MAX_COMBOS = 350000; // safety/time budget for the alloy search
  const CHUNK_SIZE = 4000;

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

  function parsePart(part) {
    let m;
    m = part.match(/^\^(-?\d*\.?\d+)$/);
    if (m) return { op: "MAX", value: parseFloat(m[1]) };
    m = part.match(/^[xX](-?\d*\.?\d+)$/);
    if (m) return { op: "MULTIPLY_TOTAL", value: parseFloat(m[1]) - 1 };
    m = part.match(/^(-?\d*\.?\d+)[xX]$/);
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) };
    m = part.match(/^([+-]\d*\.?\d+)%$/);
    if (m) return { op: "MULTIPLY_BASE", value: parseFloat(m[1]) / 100 };
    m = part.match(/^(\d*\.?\d+)%$/);
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) / 100 };
    m = part.match(/^([+-]\d*\.?\d+)$/);
    if (m) return { op: "ADD", value: parseFloat(m[1]) };
    m = part.match(/^(-?\d*\.?\d+)$/);
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) };
    m = part.match(/\(\s*(-?\d*\.?\d+)\s*\)/);
    if (m) return { op: "AVERAGE", value: parseFloat(m[1]) };
    return null;
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

  function baseTraitName(full) {
    let s = full.trim().replace(/\*+$/, "").trim();
    s = s.replace(/\s+[IVXLCDM]+$/i, "").trim();
    return s;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---------------------------------------------------------
  // Compute engine (recreates NumberProperty.compute)
  // ---------------------------------------------------------

  function getPrimaryMod(tokens) {
    let primaryMod = -1;
    for (const t of tokens) if (primaryMod < 0) primaryMod = t.value;
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

  function combineTokenLists(tokenLists) {
    // tokenLists: array (in material/primary order) of token arrays
    const modifiers = [];
    for (const toks of tokenLists) if (toks) for (const t of toks) modifiers.push(t);
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

  // Single-row convenience (Tab 1, and for deriving a material's own rarity/tier)
  function computeStatSingle(row, stat) {
    return combineTokenLists([row.tokensByStat[stat]]);
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
    for (const m of materials) for (const c of m.categories) catCounts.set(c, (catCounts.get(c) || 0) + 1);

    let sharedAll = false;
    for (const v of catCounts.values()) { if (v === n) { sharedAll = true; break; } }
    if (!sharedAll) synergy -= NO_SHARED_PENALTY;

    for (const v of catCounts.values()) if (v > 1) synergy += SHARED_BONUS * (v / (n - x + 1));

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
  // Building rows, then grouping rows into MaterialDefs (by ID)
  // ---------------------------------------------------------

  function buildRows(headers, rawRows) {
    const rows = [];
    rawRows.forEach((cols, rowIdx) => {
      const raw = {};
      headers.forEach((h, i) => { raw[h] = (cols[i] || "").trim(); });

      const id = raw["ID"] || "";
      const type = raw["Type"] || "";
      const name = raw["Name"] || "(unnamed)";
      const categories = (raw["Categories"] || "").split(",").map(s => s.trim()).filter(Boolean);
      const traits = raw["Traits"] || "";

      const row = {
        rowIdx, pack: raw["Pack"] || "", name, type, id, categories, traits,
        additive: (raw["Additive"] || "").trim().toLowerCase() === "yes",
        isExample: /:example$/i.test(id) || name.trim().toLowerCase() === "example",
        key: (id || name) + "::" + type,
        raw, tokensByStat: {}
      };
      for (const stat of STAT_FIELDS) row.tokensByStat[stat] = parseCellTokens(raw[stat]);
      rows.push(row);
    });
    return rows;
  }

  function buildMaterialDefs(rows) {
    const map = new Map();
    for (const row of rows) {
      if (row.isExample) continue;
      if (!row.id) continue;
      let def = map.get(row.id);
      if (!def) {
        def = { id: row.id, name: row.name, key: row.id, categorySet: new Set(), rows: {} };
        map.set(row.id, def);
      }
      def.rows[row.type] = row;
      row.categories.forEach(c => def.categorySet.add(c));
      if (row.type === "Main") def.name = row.name; // prefer Main row's display name
    }
    const defs = Array.from(map.values());
    defs.forEach(def => {
      def.categories = Array.from(def.categorySet);
      delete def.categorySet;
      def.rarityValue = pickSingleStatValue(def, "Rarity");
      def.harvestTierValue = pickSingleStatValue(def, "Harvest Tier");
    });
    return defs;
  }

  function typeOrderFor(def) {
    const types = Object.keys(def.rows);
    types.sort((a, b) => (a === "Main" ? -1 : b === "Main" ? 1 : a.localeCompare(b)));
    return types;
  }

  function pickSingleStatValue(def, stat) {
    for (const t of typeOrderFor(def)) {
      const row = def.rows[t];
      if (row.tokensByStat[stat] && row.tokensByStat[stat].length) return computeStatSingle(row, stat);
    }
    return 0;
  }

  // ---------------------------------------------------------
  // Alloy validity (recreates AlloyMakerBlockEntity.canCompoundMaterials)
  // ---------------------------------------------------------

  function getSharedTypes(materials) {
    let shared = null;
    for (const m of materials) {
      const types = new Set(Object.keys(m.rows));
      shared = shared === null ? types : new Set(Array.from(shared).filter(t => types.has(t)));
      if (shared.size === 0) return shared;
    }
    if (!shared) return new Set();
    const result = new Set();
    for (const t of shared) {
      const allAdditive = materials.every(m => m.rows[t] && m.rows[t].additive);
      if (!allAdditive) result.add(t);
    }
    return result;
  }

  function computeStatForCombo(materials, stat, sharedTypesArr) {
    if (stat === "Harvest Tier") {
      let mx = -Infinity;
      for (const m of materials) if (m.harvestTierValue > mx) mx = m.harvestTierValue;
      return mx === -Infinity ? 0 : mx;
    }
    const tokenLists = [];
    for (const m of materials) {
      for (const t of sharedTypesArr) {
        const row = m.rows[t];
        if (row) tokenLists.push(row.tokensByStat[stat]);
      }
    }
    return combineTokenLists(tokenLists);
  }

  function extractComboTraits(materials, sharedTypesArr) {
    const set = new Set();
    for (const m of materials) {
      for (const t of sharedTypesArr) {
        const row = m.rows[t];
        if (row && row.traits) {
          row.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
            const b = baseTraitName(tr);
            if (b) set.add(b);
          });
        }
      }
    }
    return set;
  }

  function allUniqueBaseTraits(rows) {
    const set = new Set();
    rows.forEach(r => {
      if (r.isExample || !r.traits) return;
      r.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
        const b = baseTraitName(tr);
        if (b) set.add(b);
      });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  // ---------------------------------------------------------
  // Version / maker (Alloy Forge vs Super Mixer) rules
  // ---------------------------------------------------------

  function getVersionConfig(bucket, superMixerCheckbox) {
    let alloyForgeSlots, superMixerBase, superMixerSlots;
    if (bucket === "pre402") {
      alloyForgeSlots = 4; superMixerBase = false; superMixerSlots = 0;
    } else if (bucket === "402to414") {
      alloyForgeSlots = 4; superMixerBase = true; superMixerSlots = 4;
    } else {
      alloyForgeSlots = 6; superMixerBase = true; superMixerSlots = 8;
    }
    return {
      alloyForgeSlots,
      superMixerAvailable: superMixerBase && !!superMixerCheckbox,
      superMixerSlots
    };
  }

  function maxFeasibleSlots(cfg) {
    return Math.max(cfg.alloyForgeSlots, cfg.superMixerAvailable ? cfg.superMixerSlots : 0);
  }

  function getMakerTags(materials, cfg) {
    const n = materials.length;
    const allMetalOrDust = materials.every(m => m.categories.includes("Metal") || m.categories.includes("Dust"));
    const canAlloyForge = allMetalOrDust && n <= cfg.alloyForgeSlots;
    const canSuperMixer = cfg.superMixerAvailable && n <= cfg.superMixerSlots;
    if (!canAlloyForge && !canSuperMixer) return null;
    const tags = [];
    if (canAlloyForge) tags.push("Alloy Forge / Metal Alloyer");
    if (canSuperMixer) tags.push("Super Mixer");
    return tags;
  }

  // ---------------------------------------------------------
  // Combination generation (order-reduced: only the primary
  // slot's identity matters; everything after it is unordered)
  // ---------------------------------------------------------

  function nMultichoose(n, r) {
    if (r < 0 || n <= 0) return r === 0 ? 1 : 0;
    const N = n + r - 1;
    const R = Math.min(r, N - r);
    let result = 1;
    for (let i = 0; i < R; i++) result = (result * (N - i)) / (i + 1);
    return result;
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

  function estimateTotalForPool(n, maxK, cfg) {
    const upper = Math.min(maxK, maxFeasibleSlots(cfg));
    let total = 0;
    for (let k = 2; k <= upper; k++) total += n * nMultichoose(n, k - 1);
    return total;
  }

  function* comboGenerator(pool, maxK, cfg) {
    const n = pool.length;
    const upper = Math.min(maxK, maxFeasibleSlots(cfg));
    for (let k = 2; k <= upper; k++) {
      for (let p = 0; p < n; p++) {
        for (const rest of multisetCombos(n, k - 1)) {
          const combo = [pool[p]];
          for (const ri of rest) combo.push(pool[ri]);
          yield combo;
        }
      }
    }
  }

  // ---------------------------------------------------------
  // Relevance scoring + auto pool selection (replaces manual pick)
  // ---------------------------------------------------------

  function singleDefStatValue(def, stat) {
    if (stat === "Harvest Tier") return def.harvestTierValue;
    for (const t of typeOrderFor(def)) {
      const row = def.rows[t];
      if (row.tokensByStat[stat] && row.tokensByStat[stat].length) return computeStatSingle(row, stat);
    }
    return 0;
  }

  function computeRelevanceScores(defs, statsForScoring) {
    const scores = new Array(defs.length).fill(0);
    statsForScoring.forEach(stat => {
      const vals = defs.map(d => singleDefStatValue(d, stat));
      const min = Math.min.apply(null, vals);
      const max = Math.max.apply(null, vals);
      const range = max - min;
      defs.forEach((d, i) => { scores[i] += range > 0 ? (vals[i] - min) / range : 0; });
    });
    return scores;
  }

  function selectPool(defs, selectedStats, maxK, forcedIds) {
    const statsForScoring = selectedStats.length ? selectedStats : STAT_FIELDS;
    const scores = computeRelevanceScores(defs, statsForScoring);
    const scored = defs.map((d, i) => ({ d, score: scores[i] }));
    scored.sort((a, b) => b.score - a.score);

    const forced = forcedIds ? scored.filter(s => forcedIds.has(s.d.id)) : [];
    const rest = forcedIds ? scored.filter(s => !forcedIds.has(s.d.id)) : scored;

    const pool = forced.map(s => s.d);
    // (budget check uses a placeholder cfg-free upper bound; real feasibility re-checked by caller with cfg)
    for (const s of rest) {
      pool.push(s.d);
    }
    return pool; // trimming to budget happens in trimPoolToBudget() once cfg/maxK are known
  }

  function trimPoolToBudget(orderedPool, forcedIds, maxK, cfg) {
    const forced = orderedPool.filter(d => forcedIds && forcedIds.has(d.id));
    const rest = orderedPool.filter(d => !(forcedIds && forcedIds.has(d.id)));
    let pool = forced.slice();
    for (const d of rest) {
      const trialN = pool.length + 1;
      if (estimateTotalForPool(trialN, maxK, cfg) > MAX_COMBOS) break;
      pool.push(d);
    }
    if (pool.length === 0 && orderedPool.length > 0) pool = [orderedPool[0]];
    return pool;
  }

  // ---------------------------------------------------------
  // Ranking (highest raw value per stat = best / rank 1)
  // ---------------------------------------------------------

  function rankItems(items, selectedStats) {
    const n = items.length;
    if (n === 0 || selectedStats.length === 0) return items.map(it => ({ item: it, avgRank: 0 }));
    const rankSums = new Array(n).fill(0);

    for (const stat of selectedStats) {
      const arr = items.map((it, i) => ({ i, v: it.values[stat] }));
      arr.sort((a, b) => b.v - a.v); // descending: highest value = rank 1
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
    rows: [],
    materialDefs: [],
    selectedStats: new Set(),
    tab: "single",
    single: { page: 1, ranked: [] },
    alloy: { page: 1, ranked: [], computed: false }
  };

  const materialFilterSelection = new Set(); // ids chosen in the whitelist/blacklist picker
  const traitFilterSelection = new Set();

  // ---------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of children) e.appendChild(c);
    return e;
  }

  function formatNum(v) {
    if (!isFinite(v)) return "0";
    return (Math.round(v * 100) / 100).toString();
  }

  // ---------------------------------------------------------
  // Loading a file
  // ---------------------------------------------------------

  function loadTSVText(text, label) {
    const errBox = $("#uploadError");
    errBox.hidden = true;
    try {
      const { headers, rows } = parseTSV(text);
      state.rows = buildRows(headers, rows);
      state.materialDefs = buildMaterialDefs(state.rows);

      $("#dataFileName").textContent = label;
      const nonExample = state.rows.filter(r => !r.isExample).length;
      $("#dataSummary").textContent =
        " — " + state.rows.length + " rows loaded (" + nonExample + " usable) across " +
        state.materialDefs.length + " unique materials";
      $("#uploadSection").hidden = true;
      $("#app").hidden = false;
      initAppUI();
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = e.message || String(e);
    }
  }

  function initAppUI() {
    materialFilterSelection.clear();
    traitFilterSelection.clear();
    buildStatChecklist();
    buildSingleTypeFilter();
    buildMaterialFilterPicker();
    buildTraitFilterList();
    updateSlotHint();
    updateEligibilityHint();
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
        updateEligibilityHint();
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
    syncStatCheckboxes(); updateStatsCount(); renderSingleTab(); updateEligibilityHint();
  });
  $("#statsNoneBtn").addEventListener("click", () => {
    state.selectedStats.clear();
    syncStatCheckboxes(); updateStatsCount(); renderSingleTab(); updateEligibilityHint();
  });
  function syncStatCheckboxes() {
    $$("#statChecklist input").forEach(input => {
      const stat = STAT_FIELDS.find(s => "stat_" + s.replace(/\s+/g, "_") === input.id);
      input.checked = state.selectedStats.has(stat);
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
  // Tab 1: single materials (row-based, unaffected by alloy rules)
  // ---------------------------------------------------------

  function buildSingleTypeFilter() {
    const types = Array.from(new Set(state.rows.map(r => r.type).filter(Boolean))).sort();
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
    return state.rows.filter(r => {
      if (hideEx && r.isExample) return false;
      if (typeFilter && r.type !== typeFilter) return false;
      return true;
    });
  }

  function renderSingleTab() {
    if (!state.rows.length) return;
    const candidates = getSingleCandidates();
    const selectedStats = Array.from(state.selectedStats);
    const evaluated = candidates.map(row => {
      const values = {};
      selectedStats.forEach(stat => { values[stat] = computeStatSingle(row, stat); });
      return { materials: [row], synergy: 1, values, single: true };
    });
    state.single.ranked = rankItems(evaluated, selectedStats);
    state.single.page = 1;
    renderResultsPage("single");
  }

  // ---------------------------------------------------------
  // Material filter picker (whitelist / blacklist)
  // ---------------------------------------------------------

  function buildMaterialFilterPicker() {
    renderMaterialFilterPicker();
    $("#materialFilterSearch").addEventListener("input", renderMaterialFilterPicker);
    $("#materialFilterMode").addEventListener("change", () => {
      updateEligibilityHint();
    });
    $("#onlyWhitelisted").addEventListener("change", updateEligibilityHint);
  }

  function renderMaterialFilterPicker() {
    const search = $("#materialFilterSearch").value.trim().toLowerCase();
    const wrap = $("#materialFilterPicker");
    wrap.innerHTML = "";
    state.materialDefs
      .filter(d => !search || d.name.toLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(d => {
        const id = "mf_" + d.id.replace(/[^a-z0-9]/gi, "_");
        const label = el("label", { for: id });
        const input = el("input", { type: "checkbox", id });
        input.checked = materialFilterSelection.has(d.id);
        input.addEventListener("change", () => {
          if (input.checked) materialFilterSelection.add(d.id);
          else materialFilterSelection.delete(d.id);
          updateEligibilityHint();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(d.name));
        wrap.appendChild(label);
      });
  }

  function getMaterialFilterSettings() {
    return {
      mode: $("#materialFilterMode").value,
      ids: new Set(materialFilterSelection),
      onlyWhitelisted: $("#onlyWhitelisted").checked
    };
  }

  // ---------------------------------------------------------
  // Trait filter
  // ---------------------------------------------------------

  function buildTraitFilterList() {
    const traits = allUniqueBaseTraits(state.rows);
    const wrap = $("#traitFilterList");
    wrap.innerHTML = "";
    traits.forEach(trait => {
      const id = "tf_" + trait.replace(/[^a-z0-9]/gi, "_");
      const label = el("label", { for: id });
      const input = el("input", { type: "checkbox", id });
      input.addEventListener("change", () => {
        if (input.checked) traitFilterSelection.add(trait);
        else traitFilterSelection.delete(trait);
        label.classList.toggle("checked", input.checked);
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(trait));
      wrap.appendChild(label);
    });
  }

  // ---------------------------------------------------------
  // Tab 2: forged alloys
  // ---------------------------------------------------------

  const versionSelect = $("#versionBucket");
  const superMixerCheckbox = $("#superMixerAllowed");
  const alloySizeInput = $("#alloySize");

  versionSelect.addEventListener("change", () => {
    if (versionSelect.value === "pre402") {
      superMixerCheckbox.checked = false;
      superMixerCheckbox.disabled = true;
    } else {
      superMixerCheckbox.disabled = false;
    }
    updateSlotHint();
    updateEligibilityHint();
  });
  superMixerCheckbox.addEventListener("change", () => { updateSlotHint(); updateEligibilityHint(); });
  alloySizeInput.addEventListener("input", () => {
    $("#alloySizeVal").textContent = alloySizeInput.value;
    updateSlotHint();
  });

  function currentCfg() {
    return getVersionConfig(versionSelect.value, superMixerCheckbox.checked);
  }

  function updateSlotHint() {
    const cfg = currentCfg();
    const feasible = maxFeasibleSlots(cfg);
    const requested = parseInt(alloySizeInput.value, 10);
    let msg = "Alloy Forge: " + cfg.alloyForgeSlots + " slots.";
    if (cfg.superMixerAvailable) msg += " Super Mixer: " + cfg.superMixerSlots + " slots.";
    else msg += " Super Mixer not available for this version/setting.";
    if (requested > feasible) msg += " Sizes above " + feasible + " won't produce any results with your current settings.";
    $("#slotHint").textContent = msg;
  }

  function updateEligibilityHint() {
    const filter = getMaterialFilterSettings();
    let pool = state.materialDefs;
    if (filter.mode === "blacklist") pool = pool.filter(d => !filter.ids.has(d.id));
    else if (filter.mode === "whitelist" && filter.onlyWhitelisted) pool = pool.filter(d => filter.ids.has(d.id));
    $("#eligibilityHint").textContent = pool.length + " material(s) currently eligible before auto‑narrowing.";
  }

  function renderAlloyTab() {
    if (!state.alloy.computed) {
      $("#alloyResults").innerHTML = "";
      $("#alloyPager").innerHTML = "";
      $("#alloyComputeMsg").textContent = "";
    }
  }

  $("#computeAlloysBtn").addEventListener("click", runAlloyComputation);

  function runAlloyComputation() {
    const selectedStats = Array.from(state.selectedStats);
    const msg = $("#alloyComputeMsg");
    if (selectedStats.length === 0) {
      msg.textContent = "Select at least one stat above before computing.";
      return;
    }

    const cfg = currentCfg();
    const maxK = parseInt(alloySizeInput.value, 10);
    const filter = getMaterialFilterSettings();

    let candidateDefs = state.materialDefs;
    let forcedIds = null;
    if (filter.mode === "blacklist") {
      candidateDefs = candidateDefs.filter(d => !filter.ids.has(d.id));
    } else if (filter.mode === "whitelist") {
      if (filter.onlyWhitelisted) candidateDefs = candidateDefs.filter(d => filter.ids.has(d.id));
      else forcedIds = filter.ids;
    }

    if (candidateDefs.length === 0) {
      msg.textContent = "No materials match your filter settings.";
      $("#alloyResults").innerHTML = "";
      $("#alloyPager").innerHTML = "";
      return;
    }

    const orderedByScore = selectPool(candidateDefs, selectedStats, maxK, forcedIds);
    const pool = trimPoolToBudget(orderedByScore, forcedIds, maxK, cfg);

    const total = estimateTotalForPool(pool.length, maxK, cfg);
    const traitFilterSet = new Set(traitFilterSelection);

    $("#computeAlloysBtn").disabled = true;
    const progressWrap = $("#progressWrap");
    const progressFill = $("#progressFill");
    const progressLabel = $("#progressLabel");
    progressWrap.hidden = false;
    progressFill.style.width = "0%";
    progressLabel.textContent = "Starting…";
    msg.textContent = "Auto-narrowed to " + pool.length + " of " + candidateDefs.length + " eligible materials for this search.";

    const gen = comboGenerator(pool, maxK, cfg);
    const results = [];
    let processed = 0;

    function step() {
      let count = 0;
      let res = gen.next();
      while (!res.done && count < CHUNK_SIZE) {
        const combo = res.value;
        const sharedTypesSet = getSharedTypes(combo);
        if (sharedTypesSet.size > 0) {
          const makerTags = getMakerTags(combo, cfg);
          if (makerTags) {
            const sharedTypesArr = Array.from(sharedTypesSet);
            let passTraits = true;
            if (traitFilterSet.size > 0) {
              const comboTraits = extractComboTraits(combo, sharedTypesArr);
              for (const t of traitFilterSet) { if (!comboTraits.has(t)) { passTraits = false; break; } }
            }
            if (passTraits) {
              const synergy = computeSynergy(combo);
              const values = {};
              selectedStats.forEach(stat => {
                const raw = computeStatForCombo(combo, stat, sharedTypesArr);
                values[stat] = stat === "Harvest Tier" ? raw : raw * synergy;
              });
              results.push({ materials: combo, synergy, values, sharedTypes: sharedTypesArr, makerTags, single: false });
            }
          }
        }
        processed++;
        count++;
        res = gen.next();
      }

      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      progressFill.style.width = pct + "%";
      progressLabel.textContent = processed.toLocaleString() + " / " + total.toLocaleString() + " combinations checked (" + pct + "%)";

      if (!res.done) {
        setTimeout(step, 0);
      } else {
        state.alloy.ranked = rankItems(results, selectedStats);
        state.alloy.page = 1;
        state.alloy.computed = true;
        progressWrap.hidden = true;
        $("#computeAlloysBtn").disabled = false;
        msg.textContent = "Auto-narrowed to " + pool.length + " of " + candidateDefs.length +
          " eligible materials · checked " + total.toLocaleString() + " combinations · " +
          results.length.toLocaleString() + " valid alloys found.";
        renderResultsPage("alloy");
      }
    }
    step();
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
      container.appendChild(el("p", { class: "hint" }, [document.createTextNode(
        which === "alloy" ? "No valid alloys found yet — set your filters and click \u201cApply filters & compute rankings.\u201d" : "No materials match the current filters."
      )]));
      pagerEl.innerHTML = "";
      return;
    }

    const totalPages = Math.max(1, Math.ceil(st.ranked.length / RESULTS_PER_PAGE));
    st.page = clamp(st.page, 1, totalPages);
    const startIdx = (st.page - 1) * RESULTS_PER_PAGE;
    const pageItems = st.ranked.slice(startIdx, startIdx + RESULTS_PER_PAGE);

    pageItems.forEach((entry, i) => container.appendChild(renderResultCard(entry, startIdx + i + 1, selectedStats)));

    pagerEl.innerHTML = "";
    const prevBtn = el("button", { class: "btn btn-ghost btn-sm" }, [document.createTextNode("← Prev")]);
    prevBtn.disabled = st.page <= 1;
    prevBtn.addEventListener("click", () => { st.page--; renderResultsPage(which); container.scrollIntoView({ behavior: "smooth", block: "start" }); });
    const nextBtn = el("button", { class: "btn btn-ghost btn-sm" }, [document.createTextNode("Next →")]);
    nextBtn.disabled = st.page >= totalPages;
    nextBtn.addEventListener("click", () => { st.page++; renderResultsPage(which); container.scrollIntoView({ behavior: "smooth", block: "start" }); });
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

    if (item.single) {
      title.appendChild(el("span", { class: "no-alloy-tag" }, [document.createTextNode("No alloying required")]));
    } else {
      const synClass = item.synergy >= 1 ? "pos" : "neg";
      title.appendChild(el("span", { class: "synergy-tag " + synClass }, [document.createTextNode("synergy " + formatNum(item.synergy) + "x")]));
      (item.makerTags || []).forEach(tag => {
        title.appendChild(el("span", { class: "maker-tag" }, [document.createTextNode(tag)]));
      });
    }
    body.appendChild(title);

    if (mats.length > 1) {
      const compParts = mats.map((m, i) => (i === 0 ? m.name + " (primary)" : m.name));
      const compLine = compParts.join(" + ") + "  ·  keeps: " + (item.sharedTypes || []).join(", ");
      body.appendChild(el("div", { class: "composition" }, [document.createTextNode(compLine)]));
    } else {
      body.appendChild(el("div", { class: "composition" }, [document.createTextNode(mats[0].type + " · " + (mats[0].categories.join(", ") || "—"))]));
    }

    const statValues = el("div", { class: "stat-values" });
    selectedStats.forEach(stat => {
      const span = el("span", {}, [document.createTextNode(stat + ": ")]);
      span.appendChild(el("b", {}, [document.createTextNode(formatNum(item.values[stat]))]));
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

  ["dragenter", "dragover"].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
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
    state.rows = [];
    state.materialDefs = [];
    state.alloy.computed = false;
    materialFilterSelection.clear();
    traitFilterSelection.clear();
    $("#app").hidden = true;
    $("#uploadSection").hidden = false;
    $("#uploadError").hidden = true;
    fileInput.value = "";
  });

})();
