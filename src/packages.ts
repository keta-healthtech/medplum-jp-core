import { promises as fs } from "node:fs";
import path from "node:path";

import type { Resource } from "@medplum/fhirtypes";

// Shared package-loading helpers used by both deploy.ts and
// deploy-terminology.ts so the two stay in sync on which packages are loaded
// and what counts as base (Medplum built-in) terminology.

export type PackageRef = {
  name: string;
  version: string;
};

// Packages to deploy, in the order listed. The upstream base packages
// (hl7.fhir.r4.core, hl7.terminology.r4, hl7.fhir.uv.extensions.r4) are NOT
// deployed: Medplum ships the base FHIR R4 definitions and common terminology
// built-in, so we only load the JP-specific conformance and its dedicated
// terminology.
export const PACKAGES_TO_DEPLOY: PackageRef[] = [
  { name: "jpfhir-terminology.r4", version: "1.4.0" },
  { name: "jpfhir.jp.core", version: "1.2.0" },
];

// Canonical URL roots owned by base specifications. Code systems under these
// roots are provided by Medplum out-of-the-box; re-uploading them is forbidden
// (403) and, for LOINC/SNOMED, enormous. They are skipped everywhere.
export const BASE_TERMINOLOGY_PREFIXES = [
  "http://hl7.org/",
  "http://terminology.hl7.org/",
  "http://loinc.org",
  "http://snomed.info/",
  "http://unitsofmeasure.org",
  "http://www.nlm.nih.gov/research/umls/rxnorm",
  "urn:iso:",
  "urn:ietf:",
];

export function packageDir(dataDir: string, ref: PackageRef): string {
  return path.join(dataDir, "jp-core", `${ref.name}-${ref.version}`, "package");
}

export function canonicalUrl(resource: Resource): string | undefined {
  return (resource as { url?: string }).url;
}

export function isBaseTerminology(resource: Resource): boolean {
  if (resource.resourceType !== "CodeSystem") {
    return false;
  }
  const url = canonicalUrl(resource) ?? "";
  return BASE_TERMINOLOGY_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Load every conformance resource from a single unpacked package's `package/`
 * directory. Only top-level JSON files are considered (examples, openapi and
 * xml live in sub-directories and are skipped); callers filter by resourceType.
 */
export async function loadPackageResources(
  dataDir: string,
  ref: PackageRef,
): Promise<Resource[]> {
  const dir = packageDir(dataDir, ref);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const resources: Resource[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    if (entry.name === "package.json" || entry.name.startsWith(".")) {
      continue; // package manifest and .index.json etc.
    }

    const raw = await fs.readFile(path.join(dir, entry.name), "utf8");

    let resource: Resource;
    try {
      resource = JSON.parse(raw) as Resource;
    } catch {
      console.warn(`  ! skipping unparseable file: ${entry.name}`);
      continue;
    }

    if (!resource || !resource.resourceType) {
      continue;
    }

    resources.push(resource);
  }

  return resources;
}
