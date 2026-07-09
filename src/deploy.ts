import { readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";

import { MedplumClient } from "@medplum/core";
import type {
  Bundle,
  BundleEntry,
  OperationOutcome,
  Resource,
  StructureDefinition,
} from "@medplum/fhirtypes";

import {
  canonicalUrl,
  isBaseTerminology,
  loadPackageResources,
  packageDir,
  PACKAGES_TO_DEPLOY,
  type PackageRef,
} from "./packages";

// ── Deploy JP Core conformance artifacts into a Medplum project ────────────────
//
// Reads the unpacked FHIR packages produced by `fetch.ts` and loads their
// conformance resources (CodeSystem / ValueSet / StructureDefinition / ...)
// into a Medplum project via the SDK, following the pattern documented at
// https://www.medplum.com/docs/fhir-datastore/profiles
//
// Resources are uploaded as idempotent conditional updates keyed on their
// canonical `url` (see https://hl7.org/fhir/http.html#cond-update), so the
// script can be re-run safely: an artifact is created the first time and
// updated in place on subsequent runs.
//
// Some artifacts are intentionally NOT uploaded and are reported as skips:
//   - Base terminology (HL7/ISO/IETF/LOINC/...) that Medplum ships built-in.
//     Overwriting these is forbidden (HTTP 403) and pointless.
//   - Very large inline CodeSystems (tens of thousands of concepts). Medplum
//     imports concepts into Postgres and hits its bind-parameter limit for
//     these, returning HTTP 400 ("bind message has N parameter formats ...")
//     or 413. Load those with `deploy-terminology.ts`, which uses the
//     `CodeSystem/$import` operation.
//
// Usage:
//   MEDPLUM_BASE_URL=... MEDPLUM_CLIENT_ID=... MEDPLUM_CLIENT_SECRET=... \
//     tsx src/deploy.ts [./data] [--dry-run]

// Conformance resource types to load, in dependency order: terminology first
// so that ValueSet bindings and StructureDefinition references resolve, then
// the profiles/extensions, then search + capability metadata.
const RESOURCE_TYPE_ORDER = [
  "CodeSystem",
  "ValueSet",
  "StructureDefinition",
  "SearchParameter",
  "NamingSystem",
  "CapabilityStatement",
] as const;

type DeployableType = (typeof RESOURCE_TYPE_ORDER)[number];

const DEPLOYABLE_TYPES = new Set<string>(RESOURCE_TYPE_ORDER);

// Batch sizing. A batch Bundle is capped by both entry count and serialized
// byte size so we never exceed the server's request-size limit. Any single
// resource larger than MAX_UPLOAD_BYTES is not attempted (it would be rejected
// with 413 / a Postgres bind-parameter error) and is reported as a skip.
const BATCH_SIZE = 50;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
// Resources larger than this are not attempted: Medplum imports CodeSystem
// concepts into Postgres and exceeds its bind-parameter limit for big code
// systems (returning 400 / 413 / dropping the DB connection). Such systems
// must be loaded via the CodeSystem/$import operation (deploy-terminology.ts).
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const dataDir = path.resolve(
  process.argv.find((arg, i) => i >= 2 && !arg.startsWith("--")) ?? "./data",
);
const dryRun = process.argv.includes("--dry-run");

type Stats = {
  deployed: number;
  skippedBase: number; // base terminology owned by Medplum built-ins
  skippedProtected: number; // 403 at runtime
  oversize: string[]; // too large for inline import — needs CodeSystem/$import
  failed: string[]; // genuine, unexpected failures
};

/**
 * Build the conditional-update search query that identifies an existing copy
 * of a conformance resource. Canonical resources are keyed on `url`; the few
 * that lack one (e.g. NamingSystem in R4) fall back to `name`.
 */
function conditionalQuery(resource: Resource): string | undefined {
  const url = canonicalUrl(resource);
  if (url) {
    return `url=${encodeURIComponent(url)}`;
  }

  const name = (resource as { name?: string }).name;
  if (name) {
    return `name=${encodeURIComponent(name)}`;
  }

  return undefined;
}

type SizedEntry = { entry: BundleEntry; bytes: number; label: string };

/**
 * Convert a resource into a batch entry performing an idempotent conditional
 * update. The server-managed `id` and `meta` are stripped so the canonical
 * `url` is the sole identity key and we never fight version history.
 */
function toSizedEntry(resource: Resource): SizedEntry | undefined {
  const query = conditionalQuery(resource);
  const label = canonicalUrl(resource) ?? (resource as { name?: string }).name ?? "?";
  if (!query) {
    console.warn(
      `  ! skipping ${resource.resourceType} without url/name (cannot key): ${label}`,
    );
    return undefined;
  }

  const { id, meta, ...body } = resource as Resource & { id?: string };

  const entry: BundleEntry = {
    resource: body as Resource,
    request: {
      method: "PUT",
      url: `${resource.resourceType}?${query}`,
    },
  };

  return {
    entry,
    bytes: Buffer.byteLength(JSON.stringify(body)),
    label: `${resource.resourceType} ${label}`,
  };
}

/** Group sized entries into batches bounded by both count and byte size. */
function batchBySize(items: SizedEntry[]): SizedEntry[][] {
  const batches: SizedEntry[][] = [];
  let current: SizedEntry[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const wouldExceed =
      current.length >= BATCH_SIZE ||
      (current.length > 0 && currentBytes + item.bytes > MAX_BATCH_BYTES);
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.bytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** Classify a failing outcome so known server limits aren't treated as errors. */
function isOversizeFailure(status: string, text: string): boolean {
  const t = text.toLowerCase();
  return (
    status === "413" ||
    t.includes("too large") ||
    t.includes("parameter formats") || // Postgres bind-parameter overflow
    t.includes("bind message") ||
    t.includes("connection terminated") || // large concept import kills the DB conn
    t.includes("econnreset")
  );
}

/**
 * Strip `ElementDefinition.example` entries that are missing the required
 * `label` (FHIR: example.label is 1..1). Several published JP Core profiles
 * (e.g. JP_Consent) ship examples without a label, which Medplum rejects with
 * "Missing required property". Examples are non-normative documentation, so
 * dropping the malformed ones lets the profile load without affecting how
 * instances validate against it. Returns the number of examples removed.
 */
function sanitizeExamples(resource: Resource): number {
  if (resource.resourceType !== "StructureDefinition") {
    return 0;
  }
  const sd = resource as StructureDefinition;
  let removed = 0;
  for (const elements of [sd.snapshot?.element, sd.differential?.element]) {
    for (const element of elements ?? []) {
      if (!element.example) {
        continue;
      }
      const kept = element.example.filter((ex) => ex.label !== undefined);
      removed += element.example.length - kept.length;
      element.example = kept.length > 0 ? kept : undefined;
    }
  }
  return removed;
}

// Base FHIR packages that provide extension StructureDefinitions referenced by
// JP Core, keyed by the version pinned in the reference. (These base packages
// are otherwise not deployed — see PACKAGES_TO_DEPLOY.)
const BASE_EXTENSION_SOURCES: Record<string, PackageRef> = {
  "4.0.1": { name: "hl7.fhir.r4.core", version: "4.0.1" },
  "5.2.0": { name: "hl7.fhir.uv.extensions.r4", version: "5.2.0" },
};
const DEFAULT_BASE_SOURCE = BASE_EXTENSION_SOURCES["4.0.1"];

function splitCanonicalVersion(canonical: string): [string, string | undefined] {
  const i = canonical.indexOf("|");
  return i < 0
    ? [canonical, undefined]
    : [canonical.slice(0, i), canonical.slice(i + 1)];
}

/**
 * JP Core profiles reference base extensions with a *versioned* canonical in
 * `type.profile`, e.g. `.../patient-religion|4.0.1`. Medplum's `StructureDefinition`
 * `url` search does not match the `|version` suffix (only `$expand` handles
 * versioned canonicals), so the Medplum UI's extension lookup returns nothing
 * and the field is stuck "loading…".
 *
 * This resolves that by (1) stripping the `|version` from `type.profile` so the
 * UI queries the bare canonical Medplum can match, and (2) loading the referenced
 * base extension StructureDefinition (which the base packages provide but we
 * otherwise don't deploy) at its pinned version. Mutates `resources` in place and
 * returns the extra base extension resources to deploy.
 */
function resolveBaseExtensions(resources: Resource[], dataDir: string): Resource[] {
  const wanted = new Map<string, string | undefined>(); // bare url -> pinned version

  for (const resource of resources) {
    if (resource.resourceType !== "StructureDefinition") {
      continue;
    }
    const sd = resource as StructureDefinition;
    for (const elements of [sd.snapshot?.element, sd.differential?.element]) {
      for (const element of elements ?? []) {
        for (const type of element.type ?? []) {
          if (type.code !== "Extension" || !type.profile) {
            continue;
          }
          type.profile = type.profile.map((profile) => {
            const [bare, version] = splitCanonicalVersion(profile);
            if (version && bare.startsWith("http://hl7.org/")) {
              if (!wanted.has(bare)) {
                wanted.set(bare, version);
              }
              return bare; // strip version so Medplum can resolve by bare url
            }
            return profile;
          });
        }
      }
    }
  }

  // Load each referenced base extension from disk (skip any the JP packages
  // already provide). Base FHIR files are named StructureDefinition-<id>.json
  // where <id> is the last canonical URL segment.
  const provided = new Set(
    resources.map((r) => canonicalUrl(r)).filter((u): u is string => !!u),
  );
  const loaded: Resource[] = [];
  for (const [bare, version] of wanted) {
    if (provided.has(bare)) {
      continue;
    }
    const source =
      (version ? BASE_EXTENSION_SOURCES[version] : undefined) ??
      DEFAULT_BASE_SOURCE;
    const id = bare.slice(bare.lastIndexOf("/") + 1);
    const file = path.join(
      packageDir(dataDir, source),
      `StructureDefinition-${id}.json`,
    );
    try {
      const sd = JSON.parse(readFileSync(file, "utf8")) as Resource;
      if (sd.resourceType === "StructureDefinition" && canonicalUrl(sd) === bare) {
        loaded.push(sd);
      } else {
        console.warn(`  ! base extension ${bare}: url mismatch in ${file}`);
      }
    } catch {
      console.warn(
        `  ! could not load base extension ${bare} from ${source.name}#${source.version}`,
      );
    }
  }
  return loaded;
}

function outcomeText(response: BundleEntry["response"] | undefined): string {
  const issue = response?.outcome?.issue?.[0];
  return issue?.details?.text ?? issue?.diagnostics ?? "";
}

/**
 * Submit a batch, tolerating request-level rejections (e.g. 413): if a
 * multi-entry batch is rejected wholesale, it is split and retried; a single
 * rejected entry is classified and recorded. Per-entry results are classified
 * so 403 (protected base resource) and oversize limits are reported as skips.
 */
async function submitBatch(
  medplum: MedplumClient,
  items: SizedEntry[],
  stats: Stats,
): Promise<void> {
  const bundle: Bundle = {
    resourceType: "Bundle",
    type: "batch",
    entry: items.map((i) => i.entry),
  };

  let result: Bundle;
  try {
    result = await medplum.executeBatch(bundle);
  } catch (err) {
    // Whole request rejected before per-entry processing (typically 413).
    if (items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      await submitBatch(medplum, items.slice(0, mid), stats);
      await submitBatch(medplum, items.slice(mid), stats);
      return;
    }
    const item = items[0];
    const outcome = (err as { outcome?: OperationOutcome }).outcome;
    const message =
      outcome?.issue?.[0]?.details?.text ??
      (err instanceof Error ? err.message : String(err));
    if (isOversizeFailure("", message)) {
      stats.oversize.push(`${item.label} (${(item.bytes / 1e6).toFixed(1)} MB)`);
    } else {
      stats.failed.push(`${item.label}: ${message}`);
      console.warn(`  ! ${item.label}: ${message}`);
    }
    return;
  }

  (result.entry ?? []).forEach((responseEntry, i) => {
    const item = items[i];
    const status = responseEntry.response?.status ?? "";
    if (status.startsWith("2")) {
      stats.deployed += 1;
      return;
    }

    const text = outcomeText(responseEntry.response);
    if (status === "403") {
      stats.skippedProtected += 1;
    } else if (isOversizeFailure(status, text)) {
      stats.oversize.push(`${item.label} (${(item.bytes / 1e6).toFixed(1)} MB)`);
    } else {
      stats.failed.push(`${item.label}: ${status} ${text}`.trimEnd());
      console.warn(`  ! ${status} ${item.label} ${text}`.trimEnd());
    }
  });
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

  const stats: Stats = {
    deployed: 0,
    skippedBase: 0,
    skippedProtected: 0,
    oversize: [],
    failed: [],
  };

  // Collect and group every deployable resource across all packages by type,
  // filtering out base terminology and resources too large to import inline.
  const byType = new Map<DeployableType, SizedEntry[]>();
  for (const type of RESOURCE_TYPE_ORDER) {
    byType.set(type, []);
  }

  const collected: Resource[] = [];
  for (const ref of PACKAGES_TO_DEPLOY) {
    const resources = (await loadPackageResources(dataDir, ref)).filter((r) =>
      DEPLOYABLE_TYPES.has(r.resourceType),
    );
    console.log(
      `Loaded ${resources.length} conformance resources from ${ref.name}#${ref.version}`,
    );
    collected.push(...resources);
  }

  // Pull in the base extension StructureDefinitions the JP profiles reference by
  // versioned canonical (and de-version those references) so the Medplum UI can
  // resolve them; without this, extension fields hang on "loading…".
  const baseExtensions = resolveBaseExtensions(collected, dataDir);
  collected.push(...baseExtensions);

  let sanitizedExamples = 0;
  for (const resource of collected) {
    if (isBaseTerminology(resource)) {
      stats.skippedBase += 1;
      continue;
    }
    sanitizedExamples += sanitizeExamples(resource);
    const sized = toSizedEntry(resource);
    if (!sized) {
      continue;
    }
    if (sized.bytes > MAX_UPLOAD_BYTES) {
      stats.oversize.push(`${sized.label} (${(sized.bytes / 1e6).toFixed(1)} MB)`);
      continue;
    }
    byType.get(resource.resourceType as DeployableType)!.push(sized);
  }

  console.log("\nResource counts to deploy:");
  let total = 0;
  for (const type of RESOURCE_TYPE_ORDER) {
    const count = byType.get(type)!.length;
    total += count;
    if (count > 0) {
      console.log(`  ${type.padEnd(20)} ${count}`);
    }
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${total}`);
  console.log(
    `  (skipping ${stats.skippedBase} base terminology CodeSystem(s) built into Medplum)`,
  );
  if (baseExtensions.length > 0) {
    console.log(
      `  (added ${baseExtensions.length} referenced base extension StructureDefinition(s); de-versioned their type.profile refs)`,
    );
  }
  if (sanitizedExamples > 0) {
    console.log(
      `  (removed ${sanitizedExamples} malformed ElementDefinition.example(s) missing 'label')`,
    );
  }

  if (dryRun) {
    console.log("\n[--dry-run] Nothing was uploaded.");
    return;
  }

  const medplum = new MedplumClient({ baseUrl });
  console.log(`\nAuthenticating with ${baseUrl} ...`);
  await medplum.startClientLogin(clientId, clientSecret);

  // Upload type-by-type in dependency order so bindings resolve as we go.
  for (const type of RESOURCE_TYPE_ORDER) {
    const items = byType.get(type)!;
    if (items.length === 0) {
      continue;
    }

    console.log(`Deploying ${items.length} ${type} ...`);
    for (const batch of batchBySize(items)) {
      await submitBatch(medplum, batch, stats);
    }
  }

  console.log("\n──────────────────────────────────────────────");
  if (stats.failed.length > 0) {
    console.log(
      `⚠  Finished with ${stats.failed.length} failure(s) — see below. ${stats.deployed} resources deployed.`,
    );
  } else {
    console.log(`✓  Done — ${stats.deployed} resources deployed successfully.`);
  }

  // Skips are expected and require no action — reassure rather than alarm.
  if (stats.skippedBase > 0) {
    console.log(
      `\n${stats.skippedBase} base code systems were skipped — this is expected, nothing to do.`,
    );
    console.log(
      "   Medplum already ships these built-in (LOINC, SNOMED, HL7, …), so we don't re-upload them.",
    );
  }
  if (stats.skippedProtected > 0) {
    console.log(
      `\n${stats.skippedProtected} resources were skipped because Medplum protects them from being overwritten — safe to ignore.`,
    );
  }

  // Oversized code systems are handled by the next script, not an error.
  if (stats.oversize.length > 0) {
    console.log(
      `\n${stats.oversize.length} large code systems are too big to load here — they load in the next step.`,
    );
    console.log("→  Next: run  npm run deploy-terminology");
  }

  if (stats.failed.length > 0) {
    console.log("\nFailures (these need attention):");
    for (const label of stats.failed) {
      console.log(`  - ${label}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
