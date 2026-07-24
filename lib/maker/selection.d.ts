// Types for lib/maker/selection.js (the JS module is the source of truth).
import type { PrismaClient } from '@prisma/client'

export interface MakerSelection {
  filters: Record<string, unknown>
  venues: string[]
  allowlist: string[]
  denylist: string[]
  maxMarkets: number
  updatedAt: string | null
  updatedBy: string | null
  isDefault: boolean
}

export const DEFAULT_SELECTION: MakerSelection
export const SELECTION_ID: string
export function getMakerSelection(prisma: PrismaClient): Promise<MakerSelection>
export function saveMakerSelection(
  prisma: PrismaClient,
  input: Partial<MakerSelection>,
  updatedBy: string,
): Promise<MakerSelection>
