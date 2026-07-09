import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";


// import { MedplumClient } from "@medplum/core";



// ── Medplum client ────────────────────────────────────────────────────────────
// const medplum = new MedplumClient({
//   baseUrl: process.env.MEDPLUM_BASE_URL,
//   clientId: process.env.MEDPLUM_CLIENT_ID,
//   clientSecret: process.env.MEDPLUM_CLIENT_SECRET,
// });

type PackageRef = {
  name: string;
  version: string;
};

const ROOT_PACKAGE: PackageRef = {
  name: "jpfhir.jp.core",
  version: "1.2.0",
};

const FHIR_R4_CORE: PackageRef = {
  name: "hl7.fhir.r4.core",
  version: "4.0.1",
};

const outDir = path.resolve(process.argv[2] ?? "./jp-core-1.2.0-packages");
const tgzDir = path.join(outDir, "tgz");
const packageDir = path.join(outDir, "jp-core");

const knownPackageUrls = new Map<string, string>([
  [refKey(ROOT_PACKAGE), "https://jpfhir.jp/fhir/core/1.2.0/package.tgz"],
  [
    "jpfhir-terminology.r4#1.4.0",
    "https://jpfhir.jp/fhir/core/terminology/jpfhir-terminology.r4-1.4.0.tgz",
  ],
]);

function refKey(ref: PackageRef): string {
  return `${ref.name}#${ref.version}`;
}

function parseRef(key: string): PackageRef {
  const index = key.lastIndexOf("#");
  if (index < 1) {
    throw new Error(`Invalid package ref: ${key}`);
  }

  return {
    name: key.slice(0, index),
    version: key.slice(index + 1),
  };
}

function packageFileName(ref: PackageRef): string {
  return `${ref.name.replaceAll("/", "_")}-${ref.version}.tgz`;
}

function tgzPath(ref: PackageRef): string {
  return path.join(tgzDir, packageFileName(ref));
}

function unpackedPath(ref: PackageRef): string {
  return path.join(packageDir, `${ref.name}-${ref.version}`);
}

function packageJsonPath(ref: PackageRef): string {
  return path.join(unpackedPath(ref), "package", "package.json");
}

function registryCandidateUrls(ref: PackageRef): string[] {
  const name = encodeURIComponent(ref.name);
  const version = encodeURIComponent(ref.version);

  return [
    `https://packages2.fhir.org/packages/${name}/${version}`,
    `https://packages.fhir.org/${name}/${version}`,
    `https://packages.simplifier.net/${name}/${version}`,
  ];
}

async function isValidFhirPackageTgz(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    return false;
  }

  let hasPackageJson = false;

  try {
    await tar.t({
      file: filePath,
      onentry: (entry) => {
        if (entry.path === "package/package.json") {
          hasPackageJson = true;
        }
      },
    });

    return hasPackageJson;
  } catch {
    return false;
  }
}

async function downloadUrl(url: string, destination: string): Promise<boolean> {
  const tmp = `${destination}.tmp`;

  await fs.rm(tmp, { force: true });

  console.log(`    GET ${url}`);

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      accept: "application/gzip, application/octet-stream, */*",
    },
  });

  if (!response.ok || !response.body) {
    await fs.rm(tmp, { force: true });
    return false;
  }

  await pipeline(
    Readable.fromWeb(response.body as any),
    createWriteStream(tmp),
  );

  if (!(await isValidFhirPackageTgz(tmp))) {
    await fs.rm(tmp, { force: true });
    return false;
  }

  await fs.rename(tmp, destination);
  return true;
}

async function downloadPackage(ref: PackageRef): Promise<void> {
  const key = refKey(ref);
  const destination = tgzPath(ref);

  if (await isValidFhirPackageTgz(destination)) {
    console.log(`✓ downloaded ${key}`);
    return;
  }

  console.log(`Downloading ${key}`);

  const urls = [
    ...(knownPackageUrls.has(key) ? [knownPackageUrls.get(key)!] : []),
    ...registryCandidateUrls(ref),
  ];

  for (const url of urls) {
    try {
      if (await downloadUrl(url, destination)) {
        console.log(`✓ downloaded ${key}`);
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`    failed: ${message}`);
    }
  }

  throw new Error(`Could not download ${key}`);
}

async function unpackPackage(ref: PackageRef): Promise<void> {
  const key = refKey(ref);
  const destination = unpackedPath(ref);
  const pkgJson = packageJsonPath(ref);

  if (existsSync(pkgJson)) {
    console.log(`✓ unpacked ${key}`);
    return;
  }

  console.log(`Unpacking ${key}`);

  const tmp = `${destination}.tmp`;

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  await tar.x({
    file: tgzPath(ref),
    cwd: tmp,
  });

  if (!existsSync(path.join(tmp, "package", "package.json"))) {
    throw new Error(`Package ${key} did not contain package/package.json`);
  }

  await fs.rename(tmp, destination);
  console.log(`✓ unpacked ${key}`);
}

async function readDependencies(ref: PackageRef): Promise<PackageRef[]> {
  const raw = await fs.readFile(packageJsonPath(ref), "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
  };

  const dependencies = pkg.dependencies ?? {};
  const refs: PackageRef[] = [];

  for (const [name, version] of Object.entries(dependencies)) {
    if (name.includes("template")) {
      continue;
    }

    if (!/^[0-9][0-9A-Za-z.-]*$/.test(version)) {
      console.warn(`Skipping non-exact dependency: ${name}#${version}`);
      continue;
    }

    refs.push({ name, version });
  }

  return refs;
}

async function main(): Promise<void> {
  await fs.mkdir(tgzDir, { recursive: true });
  await fs.mkdir(packageDir, { recursive: true });

  const seen = new Set<string>();
  const queue: PackageRef[] = [ROOT_PACKAGE, FHIR_R4_CORE];

  const installed: PackageRef[] = [];

  while (queue.length > 0) {
    const ref = queue.shift()!;
    const key = refKey(ref);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (existsSync(packageJsonPath(ref))) {
      console.log(`✓ unpacked ${key}`);
    } else {
      await downloadPackage(ref);
      await unpackPackage(ref);
    }

    installed.push(ref);

    const dependencies = await readDependencies(ref);

    for (const dependency of dependencies) {
      if (!seen.has(refKey(dependency))) {
        queue.push(dependency);
      }
    }
  }

  await fs.rm(tgzDir, { recursive: true, force: true });

  installed.sort((a, b) => refKey(a).localeCompare(refKey(b)));

  console.log("\nDone.");
  console.log(`Unpacked packages: ${packageDir}`);

  console.log("\nPackages:");
  for (const ref of installed) {
    console.log(`  - ${refKey(ref)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

