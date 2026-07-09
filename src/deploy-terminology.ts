import path from "node:path";
import "dotenv/config";

import { MedplumClient } from "@medplum/core";
import type { CodeSystem, Parameters, Resource } from "@medplum/fhirtypes";

import {
  canonicalUrl,
  isBaseTerminology,
  loadPackageResources,
  PACKAGES_TO_DEPLOY,
} from "./packages";

// ── Load large JP terminology CodeSystems via CodeSystem/$import ───────────────
//
// Companion to `deploy.ts`. The main deploy script loads CodeSystems inline
// (as the resource body), which Medplum imports into Postgres in a single
// statement — that exceeds the bind-parameter limit for the big JP drug/disease
// masters (tens of thousands of concepts), so deploy.ts skips them as "too
// large".
//
// This script loads exactly those large code systems using the supported
// terminology operation, `CodeSystem/$import`
// (https://www.medplum.com/docs/api/fhir/operations/codesystem-import), which
// streams concepts into the terminology tables. For each system it:
//   1. Upserts a lightweight CodeSystem resource (metadata only, no inline
//      concepts, content = "not-present") so the resource exists for bindings
//      and updates never wipe the imported concepts.
//   2. Flattens the (possibly nested) concept tree and imports the codes in
//      bounded chunks via $import.
//
// NOTE: $import requires Project Admin privileges — the client credentials used
// here must have admin access to the target project.
//
// Usage:
//   MEDPLUM_BASE_URL=... MEDPLUM_CLIENT_ID=... MEDPLUM_CLIENT_SECRET=... \
//     tsx src/deploy-terminology.ts [./data] [--dry-run]

// Only CodeSystems with at least this many concepts are handled here; smaller
// ones are loaded inline by deploy.ts. Medplum's inline import starts failing
// around ~15–18k concepts, so this sits safely below that so nothing deploy.ts
// skips is missed; the small overlap with systems deploy.ts also loads is
// harmless because $import is idempotent. Set to 0 to import every non-base
// CodeSystem via $import.
const MIN_IMPORT_CONCEPTS = 10000;

// Concepts sent per $import request. Kept well under Postgres' 65535
// bind-parameter limit (and a modest request body) so a single call never
// trips the very limit that forces this script to exist.
const IMPORT_CHUNK = 2000;

const dataDir = path.resolve(
  process.argv.find((arg, i) => i >= 2 && !arg.startsWith("--")) ?? "./data",
);
const dryRun = process.argv.includes("--dry-run");

type FlatConcept = { code: string; display?: string };

type ConceptNode = {
  code?: string;
  display?: string;
  concept?: ConceptNode[];
};

type Target = {
  url: string;
  metadata: CodeSystem;
  concepts: FlatConcept[];
};

/** Total number of concepts in a (possibly nested) concept tree. */
function countConcepts(concepts: ConceptNode[] | undefined): number {
  let total = 0;
  for (const concept of concepts ?? []) {
    if (concept.code) {
      total += 1;
    }
    total += countConcepts(concept.concept);
  }
  return total;
}

/**
 * Flatten a (possibly hierarchical) concept tree into a flat list of codes.
 * Every node carrying a `code` is emitted with its display, including internal
 * nodes. Hierarchy (parent/child) is not preserved: these masters are consumed
 * as flat value sets, and a flat import is enough for $expand / $validate-code.
 */
function flattenConcepts(
  concepts: ConceptNode[] | undefined,
  out: FlatConcept[],
): void {
  for (const concept of concepts ?? []) {
    if (concept.code) {
      out.push(
        concept.display !== undefined
          ? { code: concept.code, display: concept.display }
          : { code: concept.code },
      );
    }
    flattenConcepts(concept.concept, out);
  }
}

/** A CodeSystem resource with inline concepts stripped, marked not-present. */
function toMetadata(cs: CodeSystem): CodeSystem {
  const { id, meta, concept, ...rest } = cs as CodeSystem & { id?: string };
  return { ...rest, content: "not-present" };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Import a slice of concepts via CodeSystem/$import. If the request is rejected
 * (e.g. a size/parameter limit) the slice is split and retried down to a single
 * concept, so one problematic code never aborts the whole system. Returns the
 * number of concepts successfully imported.
 */
async function importConcepts(
  medplum: MedplumClient,
  system: string,
  concepts: FlatConcept[],
): Promise<number> {
  const params: Parameters = {
    resourceType: "Parameters",
    parameter: [
      { name: "system", valueUri: system },
      ...concepts.map((c) => ({ name: "concept", valueCoding: c })),
    ],
  };

  try {
    await medplum.post(
      medplum.fhirUrl("CodeSystem", "$import").toString(),
      params,
    );
    return concepts.length;
  } catch (err) {
    if (concepts.length > 1) {
      const mid = Math.ceil(concepts.length / 2);
      return (
        (await importConcepts(medplum, system, concepts.slice(0, mid))) +
        (await importConcepts(medplum, system, concepts.slice(mid)))
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  ! failed to import ${concepts[0]?.code}: ${message}`);
    return 0;
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.MEDPLUM_BASE_URL;
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;

  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error(
      "Missing MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID or MEDPLUM_CLIENT_SECRET",
    );
  }

  // Select the large CodeSystems and pre-flatten their concepts.
  const targets: Target[] = [];
  for (const ref of PACKAGES_TO_DEPLOY) {
    const resources: Resource[] = await loadPackageResources(dataDir, ref);
    for (const resource of resources) {
      if (resource.resourceType !== "CodeSystem" || isBaseTerminology(resource)) {
        continue;
      }
      const cs = resource as CodeSystem;
      if (countConcepts(cs.concept as ConceptNode[]) < MIN_IMPORT_CONCEPTS) {
        continue; // small enough for inline import via deploy.ts
      }
      const url = canonicalUrl(cs);
      if (!url) {
        console.warn(`  ! skipping CodeSystem without url: ${cs.name ?? "?"}`);
        continue;
      }
      const concepts: FlatConcept[] = [];
      flattenConcepts(cs.concept as ConceptNode[], concepts);
      targets.push({ url, metadata: toMetadata(cs), concepts });
    }
  }

  targets.sort((a, b) => a.concepts.length - b.concepts.length);

  const grandTotal = targets.reduce((n, t) => n + t.concepts.length, 0);
  console.log(
    `Terminology to import via CodeSystem/$import (>= ${MIN_IMPORT_CONCEPTS} concepts):`,
  );
  for (const t of targets) {
    console.log(`  ${t.concepts.length.toString().padStart(7)}  ${t.url}`);
  }
  console.log(`  ${grandTotal.toString().padStart(7)}  TOTAL concepts`);

  if (dryRun) {
    console.log("\n[--dry-run] Nothing was imported.");
    return;
  }

  const medplum = new MedplumClient({ baseUrl });
  console.log(`\nAuthenticating with ${baseUrl} ...`);
  await medplum.startClientLogin(clientId, clientSecret);

  let importedTotal = 0;
  const failed: string[] = [];

  for (const target of targets) {
    console.log(`\n${target.url}`);

    // 1. Ensure the CodeSystem resource exists (metadata only).
    try {
      await medplum.upsertResource(
        target.metadata,
        `url=${encodeURIComponent(target.url)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  ! could not upsert CodeSystem resource: ${message}`);
      failed.push(`${target.url} (resource upsert)`);
      continue;
    }

    // 2. Stream the concepts in bounded chunks.
    let imported = 0;
    for (const slice of chunk(target.concepts, IMPORT_CHUNK)) {
      imported += await importConcepts(medplum, target.url, slice);
      process.stdout.write(`  ${imported}/${target.concepts.length} concepts\r`);
    }
    process.stdout.write("\n");
    importedTotal += imported;
    if (imported < target.concepts.length) {
      failed.push(
        `${target.url} (${target.concepts.length - imported} concept(s) failed)`,
      );
    }
  }

  console.log("\n──────────────────────────────────────────────");
  if (failed.length > 0) {
    console.log(
      `⚠  Finished with ${failed.length} incomplete import(s) — see below. ${importedTotal.toLocaleString()} concepts imported.`,
    );
    console.log("\nIncomplete (these need attention):");
    for (const label of failed) {
      console.log(`  - ${label}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `✓  Done — ${importedTotal.toLocaleString()} concepts imported across ${targets.length} code systems.`,
    );
    console.log("→  Next: run  npm run deploy-examples  to add demo patients.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
