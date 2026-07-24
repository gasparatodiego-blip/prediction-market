'use strict';
// lib/maker/selection.js — the SINGLE source of truth for the maker's operating-universe SELECTION.
//
// One persisted row (Prisma MakerUniverseSelection, id 'singleton'). READ by agent35 every cycle AND
// WRITTEN by the gated /api/maker/universe endpoint — both import THIS module. There is exactly one
// implementation of the read/write; a second would reintroduce the file-vs-database divergence this whole
// lane was built to kill. CommonJS on purpose so the node agent and the TS route can both import it.

const SELECTION_ID = 'singleton';

// The default universe when nothing has been set: Polymarket only, no filter constraints, cap 5.
const DEFAULT_SELECTION = Object.freeze({
  filters: {}, // parseRewardFilters-compatible param object (empty ⇒ no constraint)
  venues: ['polymarket'],
  allowlist: [],
  denylist: [],
  maxMarkets: 5,
  updatedAt: null,
  updatedBy: null,
  isDefault: true,
});

function normalize(row) {
  if (!row) return { ...DEFAULT_SELECTION };
  return {
    filters: row.filters && typeof row.filters === 'object' ? row.filters : {},
    venues: Array.isArray(row.venues) && row.venues.length ? row.venues : ['polymarket'],
    allowlist: Array.isArray(row.allowlist) ? row.allowlist : [],
    denylist: Array.isArray(row.denylist) ? row.denylist : [],
    maxMarkets: Number.isFinite(row.maxMarkets) && row.maxMarkets > 0 ? row.maxMarkets : 5,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: row.updatedBy ?? null,
    isDefault: false,
  };
}

/** The current selection, or DEFAULT_SELECTION when none has ever been written. Never creates a row. */
async function getMakerSelection(prisma) {
  const row = await prisma.makerUniverseSelection.findUnique({ where: { id: SELECTION_ID } });
  return normalize(row);
}

/** Validate + persist the singleton selection. `filters` is stored verbatim (the board's param object). */
async function saveMakerSelection(prisma, input, updatedBy) {
  const filters = input && typeof input.filters === 'object' && input.filters ? input.filters : {};
  const venues = Array.isArray(input?.venues) && input.venues.length
    ? input.venues.filter((v) => v === 'polymarket' || v === 'kalshi')
    : ['polymarket'];
  const allowlist = Array.isArray(input?.allowlist) ? input.allowlist.filter(Boolean).map(String) : [];
  const denylist = Array.isArray(input?.denylist) ? input.denylist.filter(Boolean).map(String) : [];
  let maxMarkets = Number(input?.maxMarkets);
  if (!Number.isFinite(maxMarkets) || maxMarkets < 1) maxMarkets = 5;
  maxMarkets = Math.min(Math.floor(maxMarkets), 100); // sane hard ceiling

  const data = {
    filters,
    venues: venues.length ? venues : ['polymarket'],
    allowlist,
    denylist,
    maxMarkets,
    updatedBy: String(updatedBy || 'unknown'),
  };
  const row = await prisma.makerUniverseSelection.upsert({
    where: { id: SELECTION_ID },
    update: data,
    create: { id: SELECTION_ID, ...data },
  });
  return normalize(row);
}

module.exports = { getMakerSelection, saveMakerSelection, DEFAULT_SELECTION, SELECTION_ID };
