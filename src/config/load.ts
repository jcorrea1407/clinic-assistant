import { z } from "zod";
import { clientRegistry } from "../../clients/index.js";
import { localJsonSource, type FactSource } from "../facts/source.js";
import type { PublicFactSheet } from "../facts/schema.js";
import { ClientConfigSchema, type ClientConfig } from "./schema.js";

export interface LoadedClient {
  config: ClientConfig;
  facts: PublicFactSheet;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function factSourceFor(config: ClientConfig): FactSource {
  switch (config.facts.kind) {
    case "local-json":
      return localJsonSource(config.facts.data);
  }
}

function labelOf(raw: unknown, index: number): string {
  if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string") return raw.id;
  return `client #${index + 1}`;
}

/** Validates one client's config and its fact sheet. Throws ConfigError. */
export async function loadClient(raw: unknown, index = 0): Promise<LoadedClient> {
  const label = labelOf(raw, index);
  const parsed = ClientConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Config for ${label} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  try {
    const facts = await factSourceFor(parsed.data).load();
    return { config: parsed.data, facts };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Fact sheet for ${label} is invalid:\n${detail}`, { cause: error });
  }
}

/** Validates every client. Reports all failures at once, not just the first. */
export async function loadAllClients(raws: readonly unknown[] = clientRegistry): Promise<LoadedClient[]> {
  const results = await Promise.allSettled(raws.map((raw, i) => loadClient(raw, i)));
  const failures = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
  if (failures.length > 0) throw new ConfigError(failures.join("\n\n"));

  const clients = results.map((r) => (r as PromiseFulfilledResult<LoadedClient>).value);
  const ids = new Set<string>();
  for (const { config } of clients) {
    if (ids.has(config.id)) throw new ConfigError(`Two clients share the id "${config.id}"`);
    ids.add(config.id);
  }
  return clients;
}

let cached: Promise<LoadedClient[]> | undefined;

/**
 * The clients for this function instance. The build already validated them;
 * this checks again on the first request, then reuses the result.
 */
export function getClients(): Promise<LoadedClient[]> {
  cached ??= loadAllClients().catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}
