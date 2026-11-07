import { z } from "zod";
import { HORIZON_DAYS_CAP, MAX_PER_RUN_CAP } from "./types.ts";

/**
 * The fields an operator may set on a source, bounded by the relay policy's caps
 * (docs/syndication.md). A value over a cap is refused, never clamped, so a row never records a
 * schedule the runner will not honour.
 */
export const sourceField = {
  name: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()),
  homepage: z.url(),
  license: z.string().trim().min(10).max(500),
  default_kind: z.enum(["event", "offer", "request", "announcement"]),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(10),
  run_every_minutes: z.number().int().min(15).max(10080),
  max_per_run: z.number().int().min(1).max(MAX_PER_RUN_CAP),
  horizon_days: z.number().int().min(1).max(HORIZON_DAYS_CAP),
  notes: z.string().trim().max(1000),
};

/** A partial update of a source: only the keys present are written, and any other key is refused. */
export const SourcePatch = z.object({
  ...sourceField,
  homepage: sourceField.homepage.nullable(),
  notes: sourceField.notes.nullable(),
}).partial().strict();

export type SourcePatch = z.infer<typeof SourcePatch>;
