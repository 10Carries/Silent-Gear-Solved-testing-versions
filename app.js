(function(){
  try {

/* ============================================================
   Silent Gear Solved: material / alloy ranking calculator
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
  const MAX_COMBOS = 350000; // auto-narrowing budget (used to trim the pool when narrowing is on)
  const EXHAUSTIVE_TOP_K = 1000; // when auto-narrowing is off, only this many best-so-far alloys are kept in memory at once
  const DYNAMIC_INITIAL_CUT_PERCENT = 0.20; // dynamic filter's first cut, before any round has run
  const DYNAMIC_MIN_PRUNE_PERCENT = 0.10; // dynamic filter always removes at least this much between rounds
  const DYNAMIC_COMBO_TARGET = 30000000; // dynamic filter prunes further than the minimum if needed to stay under this
  const ESTIMATE_SAMPLE_SIZE = 100000; // combinations sampled by the "Estimate time" button
  const ADDITIVE_START_K = 4; // additive alloying's default initial brute-force size
  const ADDITIVE_BEAM_WIDTH = 10000; // additive alloying keeps this many alloys between rounds
  const ADDITIVE_ALT_START_K = 3; // alternate starting size, used when it's estimated to be cheaper
  const ADDITIVE_ALT_BEAM_WIDTH = 100000; // wider beam for the alternate size-3 starting round only
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
        "This doesn't look like a material export, missing column(s): " + missing.join(", ") +
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

  function romanToInt(roman) {
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let result = 0;
    for (let i = 0; i < roman.length; i++) {
      const cur = map[roman[i]];
      const next = map[roman[i + 1]];
      if (next && cur < next) result -= cur; else result += cur;
    }
    return result;
  }

  // Returns the numeric level of a trait string like "Flexible III" -> 3, or
  // null if the trait has no roman-numeral level (e.g. "Bounce*").
  function traitLevel(full) {
    const s = full.trim().replace(/\*+$/, "").trim();
    const m = s.match(/\s+([IVXLCDM]+)$/i);
    if (!m) return null;
    return romanToInt(m[1].toUpperCase());
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

  function computeStatForType(materials, stat, type) {
    if (stat === "Harvest Tier") {
      let mx = -Infinity;
      for (const m of materials) if (m.harvestTierValue > mx) mx = m.harvestTierValue;
      return mx === -Infinity ? 0 : mx;
    }
    const tokenLists = [];
    for (const m of materials) {
      const row = m.rows[type];
      if (row) tokenLists.push(row.tokensByStat[stat]);
    }
    return combineTokenLists(tokenLists);
  }

  // Returns a Map of base trait name -> highest level found (or null if that
  // trait never appears with a parseable level) across every shared role.
  // Used for trait-filter matching, where a minimum level may be required.
  function extractComboTraits(materials, sharedTypesArr) {
    const map = new Map();
    for (const m of materials) {
      for (const t of sharedTypesArr) {
        const row = m.rows[t];
        if (row && row.traits) {
          row.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
            const b = baseTraitName(tr);
            if (!b) return;
            const lvl = traitLevel(tr);
            const prev = map.has(b) ? map.get(b) : undefined;
            if (prev === undefined || (lvl !== null && (prev === null || lvl > prev))) {
              map.set(b, lvl);
            }
          });
        }
      }
    }
    return map;
  }

  // Traits for a single role only (used for display, since a hover tooltip for
  // "Coating" shouldn't list traits that only came from the "Main" role).
  // Returns [{name, level}], sorted alphabetically, level null if unparseable.
  function extractTraitsForType(materials, type) {
    const map = new Map();
    for (const m of materials) {
      const row = m.rows[type];
      if (row && row.traits) {
        row.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
          const b = baseTraitName(tr);
          if (!b) return;
          const lvl = traitLevel(tr);
          const prev = map.has(b) ? map.get(b) : undefined;
          if (prev === undefined || (lvl !== null && (prev === null || lvl > prev))) {
            map.set(b, lvl);
          }
        });
      }
    }
    return Array.from(map.entries())
      .map(([name, level]) => ({ name, level }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function formatTraitLabel(name, level) {
    return level === null || level === undefined ? name : name + " (" + level + ")";
  }

  // Same idea as extractTraitsForType, but for a single row directly (used by
  // the Single Materials tab, where items are raw rows, not MaterialDefs).
  function traitsForRow(row) {
    const map = new Map();
    if (row.traits) {
      row.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
        const b = baseTraitName(tr);
        if (!b) return;
        const lvl = traitLevel(tr);
        const prev = map.has(b) ? map.get(b) : undefined;
        if (prev === undefined || (lvl !== null && (prev === null || lvl > prev))) map.set(b, lvl);
      });
    }
    return Array.from(map.entries())
      .map(([name, level]) => ({ name, level }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function formatTraitList(traits) {
    return traits.length ? traits.map(t => formatTraitLabel(t.name, t.level)).join(", ") : ", ";
  }

  // traitFilterMap: Map<traitName, minLevel|null>. comboTraits: Map<traitName, level|null>.
  // Requires EVERY selected trait to be present, at or above its minimum level if one was given.
  function passesTraitFilter(comboTraits, traitFilterMap) {
    for (const [name, minLevel] of traitFilterMap) {
      if (!comboTraits.has(name)) return false;
      if (minLevel !== null && minLevel !== undefined) {
        const lvl = comboTraits.get(name);
        if (lvl === null || lvl < minLevel) return false;
      }
    }
    return true;
  }

  // Same idea, but true if ANY selected trait matches, used to decide which
  // materials get force-kept in the auto-narrowed pool.
  function passesAnyTraitFilter(traitLevels, traitFilterMap) {
    for (const [name, minLevel] of traitFilterMap) {
      if (traitLevels.has(name)) {
        if (minLevel === null || minLevel === undefined) return true;
        const lvl = traitLevels.get(name);
        if (lvl !== null && lvl >= minLevel) return true;
      }
    }
    return false;
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
  // Version / maker (4 alloying stations) rules
  // ---------------------------------------------------------

  const MACHINES = [
    { key: "alloyForge", label: "Alloy Forge / Metal Alloyer", test: m => m.categories.includes("Metal") || m.categories.includes("Dust") },
    { key: "superMixer", label: "Super Mixer", test: () => true },
    { key: "recrystalizer", label: "Recrystalizer", test: m => m.categories.includes("Gem") || m.categories.includes("Dust") },
    { key: "refabricator", label: "Refabricator", test: m => m.categories.includes("Slime") || m.categories.includes("Fiber") || m.categories.includes("Cloth") }
  ];

  // Base slot counts / existence per version bucket, before the user's own checkbox toggles are applied.
  function getVersionBaseConfig(bucket) {
    if (bucket === "pre402") {
      return {
        alloyForge: { slots: 4, exists: true },
        superMixer: { slots: 0, exists: false },
        recrystalizer: { slots: 4, exists: true },
        refabricator: { slots: 4, exists: true }
      };
    } else if (bucket === "402to414") {
      return {
        alloyForge: { slots: 4, exists: true },
        superMixer: { slots: 4, exists: true },
        recrystalizer: { slots: 4, exists: true },
        refabricator: { slots: 4, exists: true }
      };
    }
    return {
      alloyForge: { slots: 6, exists: true },
      superMixer: { slots: 8, exists: true },
      recrystalizer: { slots: 6, exists: true },
      refabricator: { slots: 6, exists: true }
    };
  }

  // enabledMap: { alloyForge: bool, superMixer: bool, recrystalizer: bool, refabricator: bool }
  function getVersionConfig(bucket, enabledMap) {
    const base = getVersionBaseConfig(bucket);
    const cfg = {};
    MACHINES.forEach(m => {
      const b = base[m.key];
      cfg[m.key] = { slots: b.slots, available: b.exists && !!(enabledMap && enabledMap[m.key]) };
    });
    return cfg;
  }

  function maxFeasibleSlots(cfg) {
    let mx = 0;
    MACHINES.forEach(m => { if (cfg[m.key] && cfg[m.key].available) mx = Math.max(mx, cfg[m.key].slots); });
    return mx;
  }

  function getMakerTags(materials, cfg) {
    const n = materials.length;
    const tags = [];
    for (const machine of MACHINES) {
      const mc = cfg[machine.key];
      if (!mc || !mc.available) continue;
      if (n > mc.slots) continue;
      if (!materials.every(machine.test)) continue;
      tags.push(machine.label);
    }
    return tags.length ? tags : null;
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

  // Generates combinations of exactly size k (not every size from 2 up to k).
  // Used by additive alloying, which grows a fixed-size beam one size at a time.
  function* combosOfExactSize(pool, k) {
    const n = pool.length;
    for (let p = 0; p < n; p++) {
      for (const rest of multisetCombos(n, k - 1)) {
        const combo = [pool[p]];
        for (const ri of rest) combo.push(pool[ri]);
        yield combo;
      }
    }
  }

  // For additive alloying's growth step: every surviving alloy, extended by
  // every pool material inserted either as the new primary (first) or
  // appended at the end (any non-primary position is equivalent, since only
  // the primary slot's identity affects the result).
  function* expandCandidates(survivorItems, pool) {
    for (const survivor of survivorItems) {
      for (const mat of pool) {
        yield [mat].concat(survivor.materials);
        yield survivor.materials.concat([mat]);
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

  const MIN_AUTO_NARROW_POOL = 15;

  function trimPoolToBudget(orderedPool, forcedIds, maxK, cfg) {
    const forced = orderedPool.filter(d => forcedIds && forcedIds.has(d.id));
    const rest = orderedPool.filter(d => !(forcedIds && forcedIds.has(d.id)));
    let pool = forced.slice();
    for (const d of rest) {
      const trialN = pool.length + 1;
      if (estimateTotalForPool(trialN, maxK, cfg) > MAX_COMBOS && pool.length >= MIN_AUTO_NARROW_POOL) break;
      pool.push(d);
    }
    if (pool.length === 0 && orderedPool.length > 0) pool = [orderedPool[0]];
    return pool;
  }

  // ---------------------------------------------------------
  // Bounded top-K (for exhaustive search with auto-narrowing off): keeps only
  // the best-scoring N items seen so far, using a running min/max per stat to
  // approximate "how good" each item is without holding every item in memory.
  // ---------------------------------------------------------

  class BoundedTopK {
    constructor(capacity, getScore) {
      this.capacity = capacity;
      this.getScore = getScore;
      this.data = [];
    }
    get size() { return this.data.length; }
    _cmp(a, b) { return this.getScore(a) - this.getScore(b); }
    _bubbleUp(i) {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this._cmp(this.data[p], this.data[i]) <= 0) break;
        const tmp = this.data[p]; this.data[p] = this.data[i]; this.data[i] = tmp;
        i = p;
      }
    }
    _bubbleDown(i) {
      const n = this.data.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && this._cmp(this.data[l], this.data[smallest]) < 0) smallest = l;
        if (r < n && this._cmp(this.data[r], this.data[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        const tmp = this.data[smallest]; this.data[smallest] = this.data[i]; this.data[i] = tmp;
        i = smallest;
      }
    }
    offer(item) {
      if (this.data.length < this.capacity) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
      } else if (this._cmp(item, this.data[0]) > 0) {
        this.data[0] = item;
        this._bubbleDown(0);
      }
    }
    toArray() { return this.data.slice(); }
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
  const traitFilterMinLevels = new Map(); // trait name -> number|null (null = any level)

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
        ", " + state.rows.length + " rows loaded (" + nonExample + " usable) across " +
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
    traitFilterMinLevels.clear();
    buildStatChecklist();
    buildSingleTypeFilter();
    buildRankTypeDropdown();
    buildMaterialFilterPicker();
    buildTraitFilterList();
    updateNarrowModeAvailability();
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
    types.forEach(t => sel.appendChild(el("option", { value: t }, [document.createTextNode(t)])));
    sel.value = types.includes("Main") ? "Main" : (types[0] || "");
    sel.addEventListener("change", renderSingleTab);
  }
  $("#singleHideExamples").addEventListener("change", renderSingleTab);

  function buildRankTypeDropdown() {
    const types = Array.from(new Set(state.rows.map(r => r.type).filter(Boolean))).sort();
    const sel = $("#rankTypeSelect");
    sel.innerHTML = "";
    types.forEach(t => sel.appendChild(el("option", { value: t }, [document.createTextNode(t)])));
    sel.value = types.includes("Main") ? "Main" : (types[0] || "");
    sel.addEventListener("change", () => { updateEligibilityHint(); });
  }
  function findOptionByValue(selectEl, value) {
    return Array.from(selectEl.querySelectorAll("option")).find(o => o.getAttribute("value") === value);
  }

  function updateNarrowModeAvailability() {
    const maxK = parseInt(alloySizeInput.value, 10);
    const sel = $("#narrowModeSelect");
    ["dynamic", "additive"].forEach(val => {
      const opt = findOptionByValue(sel, val);
      if (opt) {
        opt.disabled = maxK <= 3;
        if (maxK <= 3 && sel.value === val) sel.value = "auto";
      }
    });
  }

  $("#narrowModeSelect").addEventListener("change", () => {
    const mode = $("#narrowModeSelect").value;
    const warn = $("#narrowModeWarning");
    if (mode === "none") {
      warn.hidden = false;
      warn.textContent = "No narrowing checks every possible alloy combination. This can take a LOT of time.";
    } else if (mode === "dynamic") {
      warn.hidden = false;
      warn.textContent = "Dynamic filter should find the best alloy without searching every combination. I personally prefer additive alloying, it should be just as good but faster run time.";
    } else if (mode === "additive") {
      warn.hidden = false;
      warn.textContent = "This should find the best alloy for you in just a couple minutes (at most) if I don't suck at coding.";
    } else {
      warn.hidden = true;
      warn.textContent = "";
    }
    updateEligibilityHint();
    updateComboEstimateHint();
  });

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
    $("#materialFilterClearBtn").addEventListener("click", () => {
      materialFilterSelection.clear();
      renderMaterialFilterPicker();
      updateEligibilityHint();
    });
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
      ids: new Set(materialFilterSelection)
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
      const item = el("span", { class: "trait-filter-item" });
      const label = el("label", { for: id });
      const input = el("input", { type: "checkbox", id });
      label.appendChild(input);
      label.appendChild(document.createTextNode(trait));
      item.appendChild(label);

      const levelInput = el("input", { type: "number", min: "1", step: "1", placeholder: "any" , class: "trait-level-input"});
      levelInput.hidden = true;
      item.appendChild(levelInput);

      input.addEventListener("change", () => {
        if (input.checked) {
          traitFilterSelection.add(trait);
          levelInput.hidden = false;
        } else {
          traitFilterSelection.delete(trait);
          traitFilterMinLevels.delete(trait);
          levelInput.hidden = true;
          levelInput.value = "";
        }
        label.classList.toggle("checked", input.checked);
      });
      levelInput.addEventListener("input", () => {
        const v = parseInt(levelInput.value, 10);
        if (levelInput.value.trim() === "" || isNaN(v)) traitFilterMinLevels.delete(trait);
        else traitFilterMinLevels.set(trait, v);
      });

      wrap.appendChild(item);
    });
    $("#traitFilterClearBtn").addEventListener("click", () => {
      traitFilterSelection.clear();
      traitFilterMinLevels.clear();
      $$("#traitFilterList input[type=checkbox]").forEach(input => {
        input.checked = false;
        input.closest("label").classList.remove("checked");
      });
      $$("#traitFilterList input[type=number]").forEach(input => {
        input.hidden = true;
        input.value = "";
      });
    });
  }

  // ---------------------------------------------------------
  // Tab 2: forged alloys
  // ---------------------------------------------------------

  const versionSelect = $("#versionBucket");
  const machineCheckboxes = {
    alloyForge: $("#machineAlloyForge"),
    superMixer: $("#machineSuperMixer"),
    recrystalizer: $("#machineRecrystalizer"),
    refabricator: $("#machineRefabricator")
  };
  const alloySizeInput = $("#alloySize");

  let superMixerForcedOffByVersion = versionSelect.value === "pre402";

  versionSelect.addEventListener("change", () => {
    if (versionSelect.value === "pre402") {
      machineCheckboxes.superMixer.checked = false;
      machineCheckboxes.superMixer.disabled = true;
      superMixerForcedOffByVersion = true;
    } else {
      machineCheckboxes.superMixer.disabled = false;
      if (superMixerForcedOffByVersion) {
        machineCheckboxes.superMixer.checked = true; // restore default now that it exists again
      }
      superMixerForcedOffByVersion = false;
    }
    const newFeasible = maxFeasibleSlots(currentCfg());
    alloySizeInput.value = String(newFeasible);
    $("#alloySizeVal").textContent = alloySizeInput.value;
    updateNarrowModeAvailability();
    updateSlotHint();
    updateEligibilityHint();
    updateComboEstimateHint();
  });
  Object.values(machineCheckboxes).forEach(cb => {
    cb.addEventListener("change", () => { updateSlotHint(); updateEligibilityHint(); updateComboEstimateHint(); });
  });
  alloySizeInput.addEventListener("input", () => {
    $("#alloySizeVal").textContent = alloySizeInput.value;
    updateNarrowModeAvailability();
    updateSlotHint();
    updateComboEstimateHint();
  });

  function currentCfg() {
    const enabledMap = {
      alloyForge: machineCheckboxes.alloyForge.checked,
      superMixer: machineCheckboxes.superMixer.checked,
      recrystalizer: machineCheckboxes.recrystalizer.checked,
      refabricator: machineCheckboxes.refabricator.checked
    };
    return getVersionConfig(versionSelect.value, enabledMap);
  }

  function updateSlotHint() {
    const cfg = currentCfg();
    const feasible = maxFeasibleSlots(cfg);
    const requested = parseInt(alloySizeInput.value, 10);
    const parts = MACHINES.map(m => {
      if (!cfg[m.key].available) return m.label + ": not available.";
      return m.label + ": " + cfg[m.key].slots + " slots.";
    });
    let msg = parts.join(" ");
    if (feasible === 0) msg += "You didn't select any alloying machines so how will you make an alloy???.";
    else if (requested > feasible) msg += " Sizes above " + feasible + " won't produce any results with your current settings.";
    $("#slotHint").textContent = msg;
  }

  // Materials that don't even have the selected role can never keep it as a
  // shared type, so they're excluded up front. This also means a whitelist
  // is automatically narrowed to only its type compatible members.
  function getTypeAndFilterCandidates() {
    const type = $("#rankTypeSelect").value;
    let pool = state.materialDefs.filter(d => !!d.rows[type]);
    const filter = getMaterialFilterSettings();
    if (filter.mode === "whitelist") pool = pool.filter(d => filter.ids.has(d.id));
    else if (filter.mode === "blacklist") pool = pool.filter(d => !filter.ids.has(d.id));
    return pool;
  }

  function updateEligibilityHint() {
    const pool = getTypeAndFilterCandidates();
    const mode = $("#narrowModeSelect").value;
    let modeText;
    if (mode === "auto") modeText = " before auto-narrowing.";
    else if (mode === "dynamic") modeText = " before dynamic-filter's initial cut.";
    else modeText = " (no narrowing, all of these are searched).";
    $("#eligibilityHint").textContent = pool.length + " material(s) currently eligible" + modeText;
    updateComboEstimateHint();
  }

  // Projects how dynamic-filter's pool size would shrink round-by-round, using
  // the same size-only rule the real pruning step applies (the real run also
  // factors in actual material performance, so this is an approximation for
  // display purposes only).
  function estimateDynamicRoundSizes(initialPoolSize, maxK, cfg) {
    const rounds = [];
    let n = initialPoolSize;
    for (let k = 3; k <= maxK; k++) {
      rounds.push({ k, n });
      if (k < maxK) {
        const keepByMinPercent = Math.round(n * (1 - DYNAMIC_MIN_PRUNE_PERCENT));
        const keepByComboTarget = largestPoolSizeUnderTarget(n, k + 1, cfg, DYNAMIC_COMBO_TARGET);
        n = Math.max(2, Math.min(keepByMinPercent, keepByComboTarget));
      }
    }
    return rounds;
  }

  function estimateDynamicTotalCombos(initialPoolSize, maxK, cfg) {
    return estimateDynamicRoundSizes(initialPoolSize, maxK, cfg)
      .reduce((sum, r) => sum + estimateTotalForPool(r.n, r.k, cfg), 0);
  }

  // Decides whether it's cheaper to brute-force directly at size 4, or to
  // brute-force the much smaller size-3 space first (with a wider beam) and
  // grow that to size 4 via insertion. Returns both cost estimates plus which
  // one wins, so the same decision can be reused for display and execution.
  function chooseAdditiveStartStrategy(n) {
    const costDirect4 = n * nMultichoose(n, ADDITIVE_START_K - 1);
    const costAt3 = n * nMultichoose(n, ADDITIVE_ALT_START_K - 1);
    const survivorsAt3Estimate = Math.min(ADDITIVE_ALT_BEAM_WIDTH, costAt3);
    const growTo4Cost = survivorsAt3Estimate * n * 2;
    const costVia3 = costAt3 + growTo4Cost;
    return { costDirect4, costVia3, useVia3: costVia3 < costDirect4 };
  }

  function estimateAdditiveTotalCombos(n, maxK, cfg) {
    const strategy = chooseAdditiveStartStrategy(n);
    const startCost = strategy.useVia3 ? strategy.costVia3 : strategy.costDirect4;
    const survivorsAfterStart = Math.min(ADDITIVE_BEAM_WIDTH,
      strategy.useVia3 ? Math.min(ADDITIVE_ALT_BEAM_WIDTH, n * nMultichoose(n, ADDITIVE_ALT_START_K - 1)) * n * 2 : strategy.costDirect4);
    const totalRounds = Math.max(1, maxK - ADDITIVE_START_K + 1);
    const expansionRoundTotal = survivorsAfterStart * n * 2;
    return startCost + Math.max(0, totalRounds - 1) * expansionRoundTotal;
  }

  function updateComboEstimateHint() {
    const box = $("#comboEstimateHint");
    const selectedStats = Array.from(state.selectedStats);
    const maxK = parseInt(alloySizeInput.value, 10);
    const cfg = currentCfg();
    const mode = $("#narrowModeSelect").value;
    const candidateDefs = getTypeAndFilterCandidates();

    if (candidateDefs.length === 0) {
      box.textContent = "No materials match your current filters.";
      return;
    }

    if (mode === "none") {
      const total = estimateTotalForPool(candidateDefs.length, maxK, cfg);
      box.textContent = total.toLocaleString() + " combinations possible with no narrowing.";
    } else if (mode === "dynamic") {
      if (maxK <= 3) {
        box.textContent = "Dynamic filter needs a max alloy size above 3.";
      } else {
        const initialPoolSize = Math.max(2, Math.round(candidateDefs.length * (1 - DYNAMIC_INITIAL_CUT_PERCENT)));
        const totalAcrossRounds = estimateDynamicTotalCombos(initialPoolSize, maxK, cfg);
        box.textContent = "Dynamic filter: cuts to ~" + initialPoolSize + " of " + candidateDefs.length +
          " materials first, then an estimated " + totalAcrossRounds.toLocaleString() +
          " combinations total across all rounds through size " + maxK + " (narrows adaptively, so the real count may vary).";
      }
    } else if (mode === "additive") {
      if (maxK < ADDITIVE_START_K) {
        box.textContent = "Additive alloying needs a max alloy size of at least " + ADDITIVE_START_K + ".";
      } else {
        const strategy = chooseAdditiveStartStrategy(candidateDefs.length);
        const startK = strategy.useVia3 ? ADDITIVE_ALT_START_K : ADDITIVE_START_K;
        const totalAcrossRounds = estimateAdditiveTotalCombos(candidateDefs.length, maxK, cfg);
        box.textContent = "Additive alloying: tests all " + candidateDefs.length +
          " materials, starting at size " + startK + (strategy.useVia3 ? " (faster than starting at " + ADDITIVE_START_K + " for this many materials)" : "") +
          ", an estimated " + totalAcrossRounds.toLocaleString() + " combinations total, growing to size " + maxK + ".";
      }
    } else {
      const ordered = selectPool(candidateDefs, selectedStats, maxK, null);
      const trimmed = trimPoolToBudget(ordered, null, maxK, cfg);
      const total = estimateTotalForPool(trimmed.length, maxK, cfg);
      box.textContent = "Auto-narrow will check " + total.toLocaleString() + " combinations (from " + trimmed.length + " of " + candidateDefs.length + " materials).";
    }
  }

  function renderAlloyTab() {
    if (!state.alloy.computed) {
      $("#alloyResults").innerHTML = "";
      $("#alloyPager").innerHTML = "";
      $("#alloyComputeMsg").textContent = "";
    }
  }

  $("#computeAlloysBtn").addEventListener("click", runAlloyComputation);

  function formatDuration(totalSeconds) {
    if (!isFinite(totalSeconds) || totalSeconds < 0) return "unknown";
    if (totalSeconds < 60) return Math.ceil(totalSeconds) + " sec";
    if (totalSeconds < 3600) return Math.ceil(totalSeconds / 60) + " min";
    if (totalSeconds < 86400) return (totalSeconds / 3600).toFixed(1) + " hr";
    return (totalSeconds / 86400).toFixed(1) + " days";
  }

  $("#estimateTimeBtn").addEventListener("click", () => {
    const selectedStats = Array.from(state.selectedStats);
    const resultEl = $("#estimateTimeResult");
    if (selectedStats.length === 0) {
      resultEl.textContent = "Select at least one stat first.";
      return;
    }

    const cfg = currentCfg();
    const maxK = parseInt(alloySizeInput.value, 10);
    const rankType = $("#rankTypeSelect").value;
    const mode = $("#narrowModeSelect").value;
    const traitFilterSet = new Map(Array.from(traitFilterSelection).map(name => [name, traitFilterMinLevels.has(name) ? traitFilterMinLevels.get(name) : null]));
    const candidateDefs = getTypeAndFilterCandidates();

    if (candidateDefs.length === 0) {
      resultEl.textContent = "No materials match your filter settings and selected role.";
      return;
    }

    let forcedIds = null;
    if (traitFilterSet.size > 0) {
      forcedIds = new Set();
      candidateDefs.forEach(d => {
        const row = d.rows[rankType];
        if (!row || !row.traits) return;
        const levels = new Map();
        row.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
          const b = baseTraitName(tr);
          if (!b) return;
          const lvl = traitLevel(tr);
          const prev = levels.has(b) ? levels.get(b) : undefined;
          if (prev === undefined || (lvl !== null && (prev === null || lvl > prev))) levels.set(b, lvl);
        });
        if (passesAnyTraitFilter(levels, traitFilterSet)) forcedIds.add(d.id);
      });
    }

    let samplePool, sampleK, projectedTotal;
    if (mode === "none") {
      samplePool = candidateDefs;
      sampleK = maxK;
      projectedTotal = estimateTotalForPool(samplePool.length, maxK, cfg);
    } else if (mode === "dynamic") {
      if (maxK <= 3) {
        resultEl.textContent = "Dynamic filter needs a max alloy size above 3.";
        return;
      }
      const ordered = selectPool(candidateDefs, selectedStats, maxK, forcedIds);
      const initialKeepCount = Math.max(2, Math.round(candidateDefs.length * (1 - DYNAMIC_INITIAL_CUT_PERCENT)));
      samplePool = ordered.slice(0, Math.min(initialKeepCount, ordered.length));
      sampleK = 3;
      projectedTotal = estimateDynamicTotalCombos(samplePool.length, maxK, cfg);
    } else if (mode === "additive") {
      if (maxK < ADDITIVE_START_K) {
        resultEl.textContent = "Additive alloying needs a max alloy size of at least " + ADDITIVE_START_K + ".";
        return;
      }
      samplePool = candidateDefs;
      sampleK = chooseAdditiveStartStrategy(candidateDefs.length).useVia3 ? ADDITIVE_ALT_START_K : ADDITIVE_START_K;
      projectedTotal = estimateAdditiveTotalCombos(samplePool.length, maxK, cfg);
    } else {
      const ordered = selectPool(candidateDefs, selectedStats, maxK, forcedIds);
      samplePool = trimPoolToBudget(ordered, forcedIds, maxK, cfg);
      sampleK = maxK;
      projectedTotal = estimateTotalForPool(samplePool.length, maxK, cfg);
    }

    resultEl.textContent = "Measuring…";
    $("#estimateTimeBtn").disabled = true;

    const gen = mode === "additive" ? combosOfExactSize(samplePool, sampleK) : comboGenerator(samplePool, sampleK, cfg);
    const startTime = Date.now();
    let sampled = 0;

    function step() {
      let count = 0;
      let res = gen.next();
      while (!res.done && count < CHUNK_SIZE && sampled < ESTIMATE_SAMPLE_SIZE) {
        const combo = res.value;
        const uniqueCount = new Set(combo.map(m => m.key)).size;
        if (uniqueCount >= 2) {
          const sharedTypesSet = getSharedTypes(combo);
          if (sharedTypesSet.has(rankType)) {
            const makerTags = getMakerTags(combo, cfg);
            if (makerTags) {
              const sharedTypesArr = Array.from(sharedTypesSet);
              let passTraits = true;
              if (traitFilterSet.size > 0) {
                const comboTraits = extractComboTraits(combo, sharedTypesArr);
                passTraits = passesTraitFilter(comboTraits, traitFilterSet);
              }
              if (passTraits) {
                const synergy = computeSynergy(combo);
                selectedStats.forEach(stat => {
                  const raw = computeStatForType(combo, stat, rankType);
                  void (stat === "Harvest Tier" ? raw : raw * synergy);
                });
              }
            }
          }
        }
        sampled++;
        count++;
        res = gen.next();
      }

      if (!res.done && sampled < ESTIMATE_SAMPLE_SIZE) {
        resultEl.textContent = "Measuring… (" + sampled.toLocaleString() + " / " + ESTIMATE_SAMPLE_SIZE.toLocaleString() + ")";
        setTimeout(step, 0);
      } else {
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const rate = sampled / Math.max(elapsedSeconds, 0.001);
        const estimatedSeconds = projectedTotal / rate;
        $("#estimateTimeBtn").disabled = false;
        resultEl.textContent = "Sampled " + sampled.toLocaleString() + " combinations in " + elapsedSeconds.toFixed(2) +
          "s (~" + Math.round(rate).toLocaleString() + "/s). Estimated total for " + projectedTotal.toLocaleString() +
          " combinations: ~" + formatDuration(estimatedSeconds) + ".";
      }
    }
    step();
  });

  // Runs the full validity/maker/trait pipeline for one combo and returns the
  // finished result item, or null if the combo isn't a valid alloy under the
  // current settings. Shared by additive alloying's two round types.
  function tryBuildResultItem(combo, opts) {
    const { rankType, cfg, traitFilterSet, selectedStats } = opts;
    const uniqueCount = new Set(combo.map(m => m.key)).size;
    if (uniqueCount < 2) return null;
    const sharedTypesSet = getSharedTypes(combo);
    if (!sharedTypesSet.has(rankType)) return null;
    const makerTags = getMakerTags(combo, cfg);
    if (!makerTags) return null;
    const sharedTypesArr = Array.from(sharedTypesSet);
    if (traitFilterSet.size > 0) {
      const comboTraits = extractComboTraits(combo, sharedTypesArr);
      if (!passesTraitFilter(comboTraits, traitFilterSet)) return null;
    }
    const synergy = computeSynergy(combo);
    const values = {};
    selectedStats.forEach(stat => {
      const raw = computeStatForType(combo, stat, rankType);
      values[stat] = stat === "Harvest Tier" ? raw : raw * synergy;
    });
    return { materials: combo, synergy, values, sharedTypes: sharedTypesArr, rankType, makerTags, single: false };
  }

  function makeRunningScorer(selectedStats, runningRange) {
    return item => {
      let s = 0;
      for (const stat of selectedStats) {
        const r = runningRange[stat];
        const range = r.max - r.min;
        s += range > 0 ? (item.values[stat] - r.min) / range : 0;
      }
      return s / selectedStats.length;
    };
  }

  // Additive alloying, step 1: brute-force search of exactly size k, keeping
  // the best `beamWidth` alloys as the starting beam (defaults to
  // ADDITIVE_BEAM_WIDTH; the alternate size-3 pre-round uses a wider one).
  function runExactSizeSearch(pool, k, opts, onComplete) {
    const { selectedStats, progressPrefix, beamWidth } = opts;
    const total = pool.length * nMultichoose(pool.length, k - 1);
    const progressFill = $("#progressFill");
    const progressLabel = $("#progressLabel");

    const gen = combosOfExactSize(pool, k);
    const runningRange = {};
    selectedStats.forEach(stat => { runningRange[stat] = { min: Infinity, max: -Infinity }; });
    const topK = new BoundedTopK(beamWidth || ADDITIVE_BEAM_WIDTH, makeRunningScorer(selectedStats, runningRange));

    let processed = 0;
    function step() {
      let count = 0;
      let res = gen.next();
      while (!res.done && count < CHUNK_SIZE) {
        const item = tryBuildResultItem(res.value, opts);
        if (item) {
          selectedStats.forEach(stat => {
            const v = item.values[stat];
            const r = runningRange[stat];
            if (v < r.min) r.min = v;
            if (v > r.max) r.max = v;
          });
          topK.offer(item);
        }
        processed++;
        count++;
        res = gen.next();
      }
      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      progressFill.style.width = pct + "%";
      progressLabel.textContent = (progressPrefix || "") + processed.toLocaleString() + " / " + total.toLocaleString() +
        " combinations checked (" + pct + "%) · keeping best " + topK.size.toLocaleString();
      if (!res.done) {
        setTimeout(step, 0);
      } else {
        onComplete(topK.toArray(), total);
      }
    }
    step();
  }

  // Additive alloying, growth step: extends every surviving alloy by every
  // pool material (inserted first or appended), keeping the best
  // ADDITIVE_BEAM_WIDTH again. Cost per round is roughly
  // survivors × poolSize × 2
  function runExpansionRound(survivorItems, pool, opts, onComplete) {
    const { selectedStats, progressPrefix } = opts;
    const total = survivorItems.length * pool.length * 2;
    const progressFill = $("#progressFill");
    const progressLabel = $("#progressLabel");

    const gen = expandCandidates(survivorItems, pool);
    const runningRange = {};
    selectedStats.forEach(stat => { runningRange[stat] = { min: Infinity, max: -Infinity }; });
    const topK = new BoundedTopK(ADDITIVE_BEAM_WIDTH, makeRunningScorer(selectedStats, runningRange));

    let processed = 0;
    function step() {
      let count = 0;
      let res = gen.next();
      while (!res.done && count < CHUNK_SIZE) {
        const combo = res.value;
        const item = tryBuildResultItem(combo, opts);
        if (item) {
          selectedStats.forEach(stat => {
            const v = item.values[stat];
            const r = runningRange[stat];
            if (v < r.min) r.min = v;
            if (v > r.max) r.max = v;
          });
          topK.offer(item);
        }
        processed++;
        count++;
        res = gen.next();
      }
      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      progressFill.style.width = pct + "%";
      progressLabel.textContent = (progressPrefix || "") + processed.toLocaleString() + " / " + total.toLocaleString() +
        " combinations checked (" + pct + "%) · keeping best " + topK.size.toLocaleString();
      if (!res.done) {
        setTimeout(step, 0);
      } else {
        onComplete(topK.toArray(), total);
      }
    }
    step();
  }

  // Runs one full chunked combination search over `pool` for sizes 2..roundMaxK.
  // If topKCap is set, keeps only the best-so-far topKCap items (bounded memory);
  // otherwise accumulates every valid result in a plain array. Calls
  // onComplete(rankedResults, totalChecked) once the whole pool has been scanned.
  // Runs one full chunked pass over `pool` at exactly size k purely to score
  // materials by how they actually perform in combinations. No combo objects
  // are retained (just a running per-stat range and a small per-material sum/
  // count/best accumulator), so this stays cheap and memory-safe regardless of
  // how many combinations exist, unlike sampling from a bounded top-K survivor
  // set (which would bias scoring toward whichever materials happened to pair
  // with an already-strong partner).
  function runComboSearchForAggregate(pool, k, opts, onComplete) {
    const { selectedStats, rankType, cfg, traitFilterSet, progressPrefix } = opts;
    const total = estimateTotalForPool(pool.length, k, cfg);
    const progressFill = $("#progressFill");
    const progressLabel = $("#progressLabel");

    const gen = comboGenerator(pool, k, cfg);
    const runningRange = {};
    selectedStats.forEach(stat => { runningRange[stat] = { min: Infinity, max: -Infinity }; });
    const materialAgg = new Map(); // id -> { sum, count, best }

    function scoreOf(values) {
      let s = 0;
      for (const stat of selectedStats) {
        const r = runningRange[stat];
        const range = r.max - r.min;
        s += range > 0 ? (values[stat] - r.min) / range : 0;
      }
      return s / selectedStats.length;
    }

    let processed = 0;

    function step() {
      let count = 0;
      let res = gen.next();
      while (!res.done && count < CHUNK_SIZE) {
        const combo = res.value;
        const uniqueCount = new Set(combo.map(m => m.key)).size;
        if (uniqueCount >= 2) {
          const sharedTypesSet = getSharedTypes(combo);
          if (sharedTypesSet.has(rankType)) {
            const makerTags = getMakerTags(combo, cfg);
            if (makerTags) {
              const sharedTypesArr = Array.from(sharedTypesSet);
              let passTraits = true;
              if (traitFilterSet.size > 0) {
                const comboTraits = extractComboTraits(combo, sharedTypesArr);
                passTraits = passesTraitFilter(comboTraits, traitFilterSet);
              }
              if (passTraits) {
                const synergy = computeSynergy(combo);
                const values = {};
                selectedStats.forEach(stat => {
                  const raw = computeStatForType(combo, stat, rankType);
                  values[stat] = stat === "Harvest Tier" ? raw : raw * synergy;
                });
                selectedStats.forEach(stat => {
                  const v = values[stat];
                  const r = runningRange[stat];
                  if (v < r.min) r.min = v;
                  if (v > r.max) r.max = v;
                });
                const score = scoreOf(values);
                const seenInCombo = new Set();
                combo.forEach(m => {
                  if (seenInCombo.has(m.id)) return; // count repeats once per combo
                  seenInCombo.add(m.id);
                  const rec = materialAgg.get(m.id) || { sum: 0, count: 0, best: -Infinity };
                  rec.sum += score;
                  rec.count++;
                  if (score > rec.best) rec.best = score;
                  materialAgg.set(m.id, rec);
                });
              }
            }
          }
        }
        processed++;
        count++;
        res = gen.next();
      }

      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      progressFill.style.width = pct + "%";
      progressLabel.textContent = (progressPrefix || "") + processed.toLocaleString() + " / " + total.toLocaleString() + " combinations checked (" + pct + "%)";

      if (!res.done) {
        setTimeout(step, 0);
      } else {
        onComplete(materialAgg, total);
      }
    }
    step();
  }

  function runComboSearchRound(pool, roundMaxK, opts, onComplete) {
    const { selectedStats, rankType, cfg, traitFilterSet, topKCap, progressPrefix } = opts;
    const total = estimateTotalForPool(pool.length, roundMaxK, cfg);
    const progressFill = $("#progressFill");
    const progressLabel = $("#progressLabel");

    const gen = comboGenerator(pool, roundMaxK, cfg);
    const results = topKCap ? null : [];
    const runningRange = {};
    selectedStats.forEach(stat => { runningRange[stat] = { min: Infinity, max: -Infinity }; });
    const topK = topKCap ? new BoundedTopK(topKCap, item => {
      let s = 0;
      for (const stat of selectedStats) {
        const r = runningRange[stat];
        const range = r.max - r.min;
        s += range > 0 ? (item.values[stat] - r.min) / range : 0;
      }
      return s / selectedStats.length;
    }) : null;

    let processed = 0;

    function step() {
      let count = 0;
      let res = gen.next();
      while (!res.done && count < CHUNK_SIZE) {
        const combo = res.value;
        const uniqueCount = new Set(combo.map(m => m.key)).size;
        if (uniqueCount >= 2) {
          const sharedTypesSet = getSharedTypes(combo);
          if (sharedTypesSet.has(rankType)) {
            const makerTags = getMakerTags(combo, cfg);
            if (makerTags) {
              const sharedTypesArr = Array.from(sharedTypesSet);
              let passTraits = true;
              if (traitFilterSet.size > 0) {
                const comboTraits = extractComboTraits(combo, sharedTypesArr);
                passTraits = passesTraitFilter(comboTraits, traitFilterSet);
              }
              if (passTraits) {
                const synergy = computeSynergy(combo);
                const values = {};
                selectedStats.forEach(stat => {
                  const raw = computeStatForType(combo, stat, rankType);
                  values[stat] = stat === "Harvest Tier" ? raw : raw * synergy;
                });
                const item = { materials: combo, synergy, values, sharedTypes: sharedTypesArr, rankType, makerTags, single: false };
                if (topKCap) {
                  selectedStats.forEach(stat => {
                    const v = values[stat];
                    const r = runningRange[stat];
                    if (v < r.min) r.min = v;
                    if (v > r.max) r.max = v;
                  });
                  topK.offer(item);
                } else {
                  results.push(item);
                }
              }
            }
          }
        }
        processed++;
        count++;
        res = gen.next();
      }

      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      progressFill.style.width = pct + "%";
      progressLabel.textContent = (progressPrefix || "") + processed.toLocaleString() + " / " + total.toLocaleString() +
        " combinations checked (" + pct + "%)" + (topK ? " · keeping best " + topK.size.toLocaleString() + " so far" : "");

      if (!res.done) {
        setTimeout(step, 0);
      } else {
        const finalResults = topKCap ? topK.toArray() : results;
        const ranked = rankItems(finalResults, selectedStats);
        onComplete(ranked, total);
      }
    }
    step();
  }

  // Largest pool size n (<= currentN) such that a full search at `nextK` would
  // stay under DYNAMIC_COMBO_TARGET combinations.
  function largestPoolSizeUnderTarget(currentN, nextK, cfg, target) {
    let n = currentN;
    while (n > 2 && estimateTotalForPool(n, nextK, cfg) >= target) n--;
    return Math.max(2, n);
  }

  // Decide how many materials survive into the next round: at least the
  // DYNAMIC_MIN_PRUNE_PERCENT minimum removal, but more if needed to keep the
  // next round's combination count under DYNAMIC_COMBO_TARGET.
  function pruneForDynamicRound(pool, materialAgg, nextK, cfg, scoringMode) {
    const scored = pool.map(def => {
      const rec = materialAgg.get(def.id);
      if (!rec || rec.count === 0) return { def, score: -Infinity };
      const score = scoringMode === "best" ? rec.best : rec.sum / rec.count;
      return { def, score };
    });
    scored.sort((a, b) => b.score - a.score); // descending: best first

    const keepByMinPercent = Math.round(pool.length * (1 - DYNAMIC_MIN_PRUNE_PERCENT));
    const keepByComboTarget = largestPoolSizeUnderTarget(pool.length, nextK, cfg, DYNAMIC_COMBO_TARGET);
    const keepCount = Math.max(2, Math.min(keepByMinPercent, keepByComboTarget));
    return scored.slice(0, keepCount).map(s => s.def);
  }

  function runAlloyComputation() {
    const selectedStats = Array.from(state.selectedStats);
    const msg = $("#alloyComputeMsg");
    if (selectedStats.length === 0) {
      msg.textContent = "Select at least one stat above before computing.";
      return;
    }

    const cfg = currentCfg();
    const maxK = parseInt(alloySizeInput.value, 10);
    const rankType = $("#rankTypeSelect").value;
    const mode = $("#narrowModeSelect").value;
    const traitFilterSet = new Map(Array.from(traitFilterSelection).map(name => [name, traitFilterMinLevels.has(name) ? traitFilterMinLevels.get(name) : null]));

    const candidateDefs = getTypeAndFilterCandidates();

    if (candidateDefs.length === 0) {
      msg.textContent = "No materials match your filter settings and selected role.";
      $("#alloyResults").innerHTML = "";
      $("#alloyPager").innerHTML = "";
      return;
    }

    // Materials carrying at least one of the required traits (on the selected
    // role's row) are always kept in the auto-narrowed pool, so trait filtering
    // doesn't get starved out by pure stat-relevance scoring.
    let forcedIds = null;
    if (traitFilterSet.size > 0) {
      forcedIds = new Set();
      candidateDefs.forEach(d => {
        const row = d.rows[rankType];
        if (!row || !row.traits) return;
        const levels = new Map();
        row.traits.split(",").map(s => s.trim()).filter(Boolean).forEach(tr => {
          const b = baseTraitName(tr);
          if (!b) return;
          const lvl = traitLevel(tr);
          const prev = levels.has(b) ? levels.get(b) : undefined;
          if (prev === undefined || (lvl !== null && (prev === null || lvl > prev))) levels.set(b, lvl);
        });
        if (passesAnyTraitFilter(levels, traitFilterSet)) forcedIds.add(d.id);
      });
    }

    $("#computeAlloysBtn").disabled = true;
    const progressWrap = $("#progressWrap");
    const progressFill = $("#progressFill");
    const progressLabel = $("#progressLabel");
    progressWrap.hidden = false;
    progressFill.style.width = "0%";
    progressLabel.textContent = "Starting…";
    msg.textContent = "";

    const baseOpts = { selectedStats, rankType, cfg, traitFilterSet };

    function finish(pool, ranked, totalChecked, summaryPrefix) {
      state.alloy.ranked = ranked;
      state.alloy.page = 1;
      state.alloy.computed = true;
      progressWrap.hidden = true;
      $("#computeAlloysBtn").disabled = false;
      msg.textContent = "";
      renderResultsPage("alloy");
    }

    if (mode === "none") {
      const pool = candidateDefs;
      runComboSearchRound(pool, maxK, Object.assign({ topKCap: EXHAUSTIVE_TOP_K, progressPrefix: "" }, baseOpts), (ranked, total) => {
        finish(pool, ranked, total, "Searched all " + pool.length + " eligible materials (no narrowing)");
      });
    } else if (mode === "dynamic" && maxK > 3) {
      // Initial cut: standalone relevance scoring (same scorer auto-narrow
      // uses), since no alloy performance data exists before round 1 yet.
      const orderedByScore = selectPool(candidateDefs, selectedStats, maxK, forcedIds);
      const initialKeepCount = Math.max(2, Math.round(candidateDefs.length * (1 - DYNAMIC_INITIAL_CUT_PERCENT)));
      const initialPool = orderedByScore.slice(0, Math.min(initialKeepCount, orderedByScore.length));

      const startK = 3;
      const totalRounds = Math.max(1, maxK - startK + 1);

      function doRound(pool, k, roundIndex) {
        const prefix = "Dynamic filter: round " + roundIndex + " of " + totalRounds + " (alloy size " + k + "): ";
        if (k >= maxK) {
          // Final round: a real search that produces the actual displayed results.
          runComboSearchRound(pool, k, Object.assign({ topKCap: EXHAUSTIVE_TOP_K, progressPrefix: prefix }, baseOpts), (ranked, total) => {
            finish(pool, ranked, total, "Dynamic filter finished at size " + maxK + " with " + pool.length + " of " + candidateDefs.length + " materials");
          });
        } else {
          // Pruning-only pass: aggregate how every material actually performed
          // across every valid combination this round (not just a top-K sample).
          runComboSearchForAggregate(pool, k, Object.assign({ progressPrefix: prefix }, baseOpts), (materialAgg, total) => {
            const nextPool = pruneForDynamicRound(pool, materialAgg, k + 1, cfg, "best");
            msg.textContent = "Narrowed from " + pool.length + " to " + nextPool.length + " materials.";
            setTimeout(() => doRound(nextPool, k + 1, roundIndex + 1), 0);
          });
        }
      }
      doRound(initialPool, startK, 1);
    } else if (mode === "additive" && maxK >= ADDITIVE_START_K) {
      // No pre-cut here: every eligible material is tested in the starting
      // round's brute force and stays available for every later growth round.
      // Only the alloy beam (not the material pool) narrows between rounds.
      const pool = candidateDefs;
      const totalRounds = maxK - ADDITIVE_START_K + 1;
      const strategy = chooseAdditiveStartStrategy(pool.length);

      function proceed(survivors, k, roundIndex, lastTotal) {
        if (k === maxK) {
          const ranked = rankItems(survivors, selectedStats);
          finish(pool, ranked, lastTotal, "Additive alloying finished at size " + maxK + " with all " + pool.length +
            " eligible materials (beam width " + ADDITIVE_BEAM_WIDTH.toLocaleString() + ")");
          return;
        }
        const nextK = k + 1;
        const prefix = "Additive alloying: round " + (roundIndex + 1) + " of " + totalRounds + " (growing to size " + nextK + "): ";
        runExpansionRound(survivors, pool, Object.assign({ progressPrefix: prefix }, baseOpts), (nextSurvivors, roundTotal) => {
          setTimeout(() => proceed(nextSurvivors, nextK, roundIndex + 1, roundTotal), 0);
        });
      }

      if (strategy.useVia3) {
        // Cheaper for this many materials: brute force the smaller size, 3
        // space with a wide beam, then grow that to size 4 via insertion
        // landing in the same "beam of alloys at size 4" state proceed() expects.
        runExactSizeSearch(pool, ADDITIVE_ALT_START_K, Object.assign({ beamWidth: ADDITIVE_ALT_BEAM_WIDTH, progressPrefix: "Additive alloying pre-round (size " + ADDITIVE_ALT_START_K + "): " }, baseOpts), (survivorsAt3) => {
          runExpansionRound(survivorsAt3, pool, Object.assign({ progressPrefix: "Additive alloying: round 1 of " + totalRounds + " (growing to size " + ADDITIVE_START_K + "): " }, baseOpts), (survivorsAt4, total4) => {
            proceed(survivorsAt4, ADDITIVE_START_K, 1, total4);
          });
        });
      } else {
        runExactSizeSearch(pool, ADDITIVE_START_K, Object.assign({ beamWidth: ADDITIVE_BEAM_WIDTH, progressPrefix: "Additive alloying: round 1 of " + totalRounds + " (size " + ADDITIVE_START_K + "): " }, baseOpts), (survivors, total) => {
          proceed(survivors, ADDITIVE_START_K, 1, total);
        });
      }
    } else {
      // Default / "auto", also the safe fallback for any unrecognized mode value.
      const orderedByScore = selectPool(candidateDefs, selectedStats, maxK, forcedIds);
      const pool = trimPoolToBudget(orderedByScore, forcedIds, maxK, cfg);
      runComboSearchRound(pool, maxK, Object.assign({ topKCap: null, progressPrefix: "" }, baseOpts), (ranked, total) => {
        finish(pool, ranked, total, "Auto-narrowed to " + pool.length + " of " + candidateDefs.length + " eligible materials");
      });
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
      container.appendChild(el("p", { class: "hint" }, [document.createTextNode(
        which === "alloy" ? "No valid alloys found yet. Set your filters and click \u201cApply filters & compute rankings.\u201d" : "No materials match the current filters."
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

    const jumpWrap = el("span", { class: "page-jump" });
    const jumpInput = el("input", { type: "number", min: "1", max: String(totalPages), value: String(st.page), class: "page-jump-input" });
    const jumpBtn = el("button", { class: "btn btn-ghost btn-sm" }, [document.createTextNode("Go")]);
    function doJump() {
      const n = parseInt(jumpInput.value, 10);
      if (!isNaN(n)) {
        st.page = clamp(n, 1, totalPages);
        renderResultsPage(which);
        container.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    jumpBtn.addEventListener("click", doJump);
    jumpInput.addEventListener("keydown", e => { if (e.key === "Enter") doJump(); });
    jumpWrap.appendChild(document.createTextNode("Go to page:"));
    jumpWrap.appendChild(jumpInput);
    jumpWrap.appendChild(jumpBtn);

    pagerEl.appendChild(prevBtn);
    pagerEl.appendChild(label);
    pagerEl.appendChild(nextBtn);
    pagerEl.appendChild(jumpWrap);
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
      body.appendChild(el("div", { class: "composition" }, [document.createTextNode(mats[0].type + " · " + (mats[0].categories.join(", ") || ", "))]));
    }

    if (item.single) {
      const statValues = el("div", { class: "stat-values" });
      selectedStats.forEach(stat => {
        const span = el("span", {}, [document.createTextNode(stat + ": ")]);
        span.appendChild(el("b", {}, [document.createTextNode(formatNum(item.values[stat]))]));
        statValues.appendChild(span);
      });
      body.appendChild(statValues);

      const row = mats[0];
      body.appendChild(el("div", { class: "trait-line" }, [document.createTextNode("Traits: " + formatTraitList(traitsForRow(row)))]));

      const def = state.materialDefs.find(d => d.id === row.id);
      if (def) {
        const otherTypes = Object.keys(def.rows).filter(t => t !== row.type).sort();
        if (otherTypes.length) {
          const chipsRow = el("div", { class: "type-chips-row" });
          otherTypes.forEach(type => {
            const otherRow = def.rows[type];
            const chip = el("span", { class: "type-chip", tabindex: "0" }, [document.createTextNode(type)]);
            const tooltip = el("div", { class: "type-tooltip" });
            tooltip.appendChild(el("span", { class: "tt-title" }, [document.createTextNode("As " + type)]));
            selectedStats.forEach(stat => {
              const val = computeStatSingle(otherRow, stat);
              tooltip.appendChild(el("span", { class: "tt-line" }, [document.createTextNode(stat + ": " + formatNum(val))]));
            });
            tooltip.appendChild(el("span", { class: "tt-line tt-traits" }, [document.createTextNode("Traits: " + formatTraitList(traitsForRow(otherRow)))]));
            chip.appendChild(tooltip);
            chipsRow.appendChild(chip);
          });
          body.appendChild(chipsRow);
        }
      }
    } else {
      body.appendChild(el("div", { class: "type-stat-heading" }, [document.createTextNode("As " + item.rankType)]));
      const statValues = el("div", { class: "stat-values" });
      selectedStats.forEach(stat => {
        const span = el("span", {}, [document.createTextNode(stat + ": ")]);
        span.appendChild(el("b", {}, [document.createTextNode(formatNum(item.values[stat]))]));
        statValues.appendChild(span);
      });
      body.appendChild(statValues);

      const mainTraits = extractTraitsForType(mats, item.rankType);
      const mainTraitsText = mainTraits.length ? mainTraits.map(t => formatTraitLabel(t.name, t.level)).join(", ") : ", ";
      body.appendChild(el("div", { class: "trait-line" }, [document.createTextNode("Traits: " + mainTraitsText)]));

      const otherTypes = item.sharedTypes.filter(t => t !== item.rankType).sort();
      if (otherTypes.length) {
        const chipsRow = el("div", { class: "type-chips-row" });
        otherTypes.forEach(type => {
          const chip = el("span", { class: "type-chip", tabindex: "0" }, [document.createTextNode(type)]);
          const tooltip = el("div", { class: "type-tooltip" });
          tooltip.appendChild(el("span", { class: "tt-title" }, [document.createTextNode("As " + type)]));
          selectedStats.forEach(stat => {
            const raw = computeStatForType(mats, stat, type);
            const val = stat === "Harvest Tier" ? raw : raw * item.synergy;
            tooltip.appendChild(el("span", { class: "tt-line" }, [document.createTextNode(stat + ": " + formatNum(val))]));
          });
          const typeTraits = extractTraitsForType(mats, type);
          const typeTraitsText = typeTraits.length ? typeTraits.map(t => formatTraitLabel(t.name, t.level)).join(", ") : ", ";
          tooltip.appendChild(el("span", { class: "tt-line tt-traits" }, [document.createTextNode("Traits: " + typeTraitsText)]));
          chip.appendChild(tooltip);
          chipsRow.appendChild(chip);
        });
        body.appendChild(chipsRow);
      }
    }

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

  $("#reloadBtn").addEventListener("click", () => {
    state.rows = [];
    state.materialDefs = [];
    state.alloy.computed = false;
    materialFilterSelection.clear();
    traitFilterSelection.clear();
    traitFilterMinLevels.clear();
    $("#app").hidden = true;
    $("#uploadSection").hidden = false;
    $("#uploadError").hidden = true;
    fileInput.value = "";
  });

})();

  } catch (err) {
    var banner = document.getElementById('fatalErrorBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = 'Something went wrong loading the page: ' + (err && err.message ? err.message : String(err)) + '. Please report this (see the browser console for details).';
    }
    console.error(err);
  }
})();
