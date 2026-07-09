import { promises as fs } from "node:fs";
import path from "node:path";
import "dotenv/config";

import { MedplumClient } from "@medplum/core";
import type { Bundle, BundleEntry, Resource } from "@medplum/fhirtypes";

// ── Seed Medplum with JP Core demo patients ───────────────────────────────────
//
// Reads the transaction bundles in `data/example/` and posts each to Medplum.
//
// Reference handling: every entry has a `fullUrl: "urn:uuid:…"` and all
// intra-bundle references use those same urn:uuids. Posting the bundle as a FHIR
// **transaction** makes Medplum assign real resource IDs and rewrite every
// urn:uuid reference to the assigned `ResourceType/id` atomically — so related
// resources end up pointing at the correct Medplum IDs with no second pass.
//
// The shared Practitioners/Organizations use conditional create
// (`ifNoneExist`), so they are created once and reused across all three
// patients — this script prints the resolved IDs to show they stay constant.
// They are plain Practitioner resources, i.e. NOT Medplum users/logins.
//
// Usage:
//   MEDPLUM_BASE_URL=... MEDPLUM_CLIENT_ID=... MEDPLUM_CLIENT_SECRET=... \
//     tsx src/deploy-examples.ts [./data/example]

const exampleDir = path.resolve(
  process.argv.find((arg, i) => i >= 2 && !arg.startsWith("--")) ??
    "./data/example",
);

/** Parse a transaction-response `location` (e.g. `Patient/<id>/_history/1`). */
function parseLocation(location: string | undefined): string | undefined {
  if (!location) {
    return undefined;
  }
  const [resourceType, id] = location.replace(/^\//, "").split("/");
  return resourceType && id ? `${resourceType}/${id}` : undefined;
}

function displayName(resource: Resource): string {
  const name = (resource as { name?: { text?: string }[] }).name;
  return name?.[0]?.text ?? (resource as { name?: string }).name?.toString?.() ?? "";
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

  const files = (await fs.readdir(exampleDir))
    .filter((f) => f.endsWith("-bundle.json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No *-bundle.json files found in ${exampleDir}`);
  }

  const medplum = new MedplumClient({ baseUrl });
  console.log(`Authenticating with ${baseUrl} ...`);
  await medplum.startClientLogin(clientId, clientSecret);

  // urn:uuid -> resolved "ResourceType/id"; shared urns recur across bundles.
  const resolved = new Map<string, Set<string>>();
  let created = 0;
  let failed = 0;

  for (const file of files) {
    const bundle = JSON.parse(
      await fs.readFile(path.join(exampleDir, file), "utf8"),
    ) as Bundle;
    const entries = bundle.entry ?? [];

    const patient = entries.find(
      (e) => e.resource?.resourceType === "Patient",
    )?.resource;

    let result: Bundle;
    try {
      result = await medplum.executeBatch(bundle); // transaction
    } catch (err) {
      const outcome = (err as { outcome?: { issue?: { details?: { text?: string }; diagnostics?: string }[] } }).outcome;
      const detail = outcome?.issue
        ?.map((i) => i.details?.text ?? i.diagnostics)
        .filter(Boolean)
        .join("; ");
      console.error(
        `✗  ${displayName(patient!)} — failed: ${detail ?? (err as Error).message}`,
      );
      failed += 1;
      continue;
    }

    let newCount = 0;
    let reusedCount = 0;
    (result.entry ?? []).forEach((responseEntry, i) => {
      const reqEntry: BundleEntry | undefined = entries[i];
      const status = responseEntry.response?.status ?? "";
      const ref = parseLocation(responseEntry.response?.location);
      if (reqEntry?.fullUrl && ref) {
        if (!resolved.has(reqEntry.fullUrl)) {
          resolved.set(reqEntry.fullUrl, new Set());
        }
        resolved.get(reqEntry.fullUrl)!.add(ref);
      }
      if (status.startsWith("201")) {
        newCount += 1;
        created += 1;
      } else if (status.startsWith("200")) {
        reusedCount += 1;
        created += 1;
      }
    });
    console.log(
      `✓  ${displayName(patient!).padEnd(12)} ${newCount} new, ${reusedCount} reused`,
    );
  }

  // The shared Practitioners/Organizations use the same urn:uuid in every
  // bundle; if conditional create worked, each maps to exactly one Medplum id.
  const shared = [...resolved.values()].filter((ids) =>
    /^(Practitioner|Organization)\//.test([...ids][0] ?? ""),
  );
  const drift = shared.some((ids) => ids.size > 1);

  console.log("\n──────────────────────────────────────────────");
  if (failed > 0) {
    console.log(
      `⚠  Finished with ${failed} failed bundle(s) — see above. ${created} resources written.`,
    );
    process.exitCode = 1;
  } else {
    const patients = files.length - failed;
    console.log(
      `✓  Done — ${patients} demo patients loaded (${created} resources).`,
    );
    console.log(
      `   The ${shared.length} shared practitioners/organizations were reused across all patients${drift ? " ⚠ (but some drifted — check above)" : ""}.`,
    );
  }
  if (drift) {
    process.exitCode = 1;
  }

  if (failed === 0 && !drift) {
    const appUrl = baseUrl.includes("localhost")
      ? "http://localhost:3000"
      : "your Medplum app";
    console.log(
      `\n✓  All JP Core data loaded — open ${appUrl} to browse the profiles and demo patients.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
