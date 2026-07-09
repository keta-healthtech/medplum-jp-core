# FHIR JP Core Profile on Medplum

> [!NOTE]
> **Select language:** English | [日本語](README.ja.md)

![](doc/keta-medplum-jp-core.png)

Scripts and artifacts to set up the FHIR [JP Core](https://jpfhir.jp/fhir/core/) profile on [Medplum](https://www.medplum.com/), with example patient data.

The scripts do the following:

- Download the JP Core Implementation Guide and its dependencies as FHIR packages.
- Load the JP Core conformance resources (StructureDefinitions, ValueSets, CodeSystems, and terminology) into a Medplum project.
- Add example patients to the project.

Built for Medplum SDK **v5.1.23**.

## Getting started

1. Follow the [Medplum instructions](https://www.medplum.com/docs/contributing/local-dev-setup) to get a local development server running (API at `http://localhost:8103`, Web UI at `http://localhost:3000`).

2. From the Medplum Web UI, register a new user and project,

3. Next we need to get the credentials and make the **Client Application a project Admin**:

   1. Go to: Project → Clients → ... Default Client → copy the *ID* and *Secret* at the bottom for Step 4
   2. Scroll to the top: "Go to ProjectMemebership" → Edit → check Admin at the bottom → Update

4. Add those credentials to `.env.dev` (copy `.env.dev.example` if it doesn't exist yet):

   ```bash
   # .env.dev
   MEDPLUM_BASE_URL=http://localhost:8103
   MEDPLUM_CLIENT_ID=<your client id>
   MEDPLUM_CLIENT_SECRET=<your client secret>
   ```

5. Activate that environment — this copies `.env.dev` → `.env`, which the scripts read:

   ```bash
   bash ./scripts/set_env.bash dev
   ```

6. Install dependencies and run the scripts in order:

   ```bash
   npm install
   npm run fetch               # download the JP Core FHIR packages into data/jp-core/
   npm run deploy              # load profiles, value sets + terminology
   npm run deploy-terminology  # load the large drug/disease code systems
   npm run deploy-examples     # seed the 3 demo patients
   ```

7. Open the Medplum app UI at `http://localhost:3000` to browse the loaded JP Core profiles and the demo patients.

The rest of this document explains each step in detail.

## Example Patients

| | **Patient 01** | **Patient 02** | **Patient 03** |
| --- | --- | --- | --- |
| Bundle | `example-patient01-bundle.json` | `example-patient02-bundle.json` | `example-patient03-bundle.json` |
| Name (kanji) | 山田 太郎 | 佐藤 花子 | 鈴木 健一 |
| Name (kana) | ヤマダ タロウ | サトウ ハナコ | スズキ ケンイチ |
| Gender / DOB | male / 1970-01-01 | female / 1985-07-15 | male / 1958-11-30 |
| Address | 東京都新宿区 (160-0023) | 大阪府大阪市北区 (530-0001) | 愛知県名古屋市中区 (460-0008) |
| Religion (extension) | Shinto | Christian | — (none) |
| Patient identifier | `…11311234567 \| 00000010` | `…11311234567 \| 00000021` | `…11311234567 \| 00000032` |

Clinical codes are **real values pulled from the imported JP code systems**, and every kanji name has a matching katakana reading.

## Packages

`fetch.ts` resolves the JP Core IG and walks its `dependencies` transitively, producing five unpacked FHIR packages under [data/jp-core/](data/jp-core/):

| Package                             | Role                     | Deployed? | Notable contents                                                                          |
| ----------------------------------- | ------------------------ | :-------: | ----------------------------------------------------------------------------------------- |
| `hl7.fhir.r4.core-4.0.1`            | Base FHIR R4 spec        |     ✗     | 4,580 files                                                                               |
| `hl7.terminology.r4-7.0.0`          | Base terminology         |     ✗     | Base CodeSystems / ValueSets                                                               |
| `hl7.fhir.uv.extensions.r4-5.2.0`   | Base extensions          |     ✗     | Base extension definitions                                                                 |
| `jpfhir-terminology.r4-1.4.0`       | JP terminology           |     ✓     | 106 CodeSystem, 97 ValueSet                                                                |
| `jpfhir.jp.core-1.2.0`              | **JP Core IG** (root)    |     ✓     | 111 StructureDefinition, 24 ValueSet, 17 CodeSystem, 8 SearchParameter, 45 NamingSystem, 2 CapabilityStatement |

The three upstream base packages are **not** deployed: Medplum ships the base FHIR R4 definitions and common terminology built-in, so re-uploading 4,500+ base files would be wasteful and risk conflicts. Only the two JP-specific packages are loaded by default.

## Prerequisites

- Node (see [.nvmrc](.nvmrc) at the repo root)
- Install dependencies:

  ```bash
  cd artifacts
  npm install
  ```

## Project scoping (important)

Everything the `deploy*` scripts create is scoped to the **single Medplum project associated with the client credentials you authenticate with** — it is **not** shared with other or new projects.

- On write, Medplum stamps each resource with `meta.project` = the client's project, and it filters every read to that project (plus any linked ones). So the JP Core StructureDefinitions, ValueSets, CodeSystems (and demo patients) live only in that project.
- The exception is **base FHIR**, which Medplum shares with all projects via an internal "synthetic R4 project". That is why base resource types are available everywhere but JP Core is not — and why `deploy.ts` also loads the base *extensions* JP Core references into your project. A brand-new project starts with only these base built-ins.
- Terminology loaded via `CodeSystem/$import` is likewise reachable only through the project that owns the CodeSystem resource.

To make JP Core available to **multiple** projects, either:

1. **Run the scripts once per project**, using each project's own client credentials (simple, fully isolated); or
2. **Deploy once into a shared project and link others to it** via Medplum's [`Project.link`](https://www.medplum.com/docs/access/projects). Consuming projects inherit resources from the linked project, gated by `Project.exportedResourceType` (include `StructureDefinition` / `ValueSet` / `CodeSystem`, or leave it empty to export everything). Editing `Project.link` / `exportedResourceType` is an admin operation on the Project resource.

## `fetch.ts` — download the packages

Run this first — the fetched packages under [data/jp-core/](data/jp-core/) are **not** committed to git (they're large), so you must download them before deploying.

```bash
npm run fetch        # → tsx src/fetch.ts ./data
```

What it does:

- Starts from the root package `jpfhir.jp.core#1.2.0` and `hl7.fhir.r4.core#4.0.1`, then follows each package's `dependencies` breadth-first.
- Downloads each `.tgz` from known JP URLs first, then falls back to the FHIR package registries (`packages2.fhir.org`, `packages.fhir.org`, `packages.simplifier.net`). Downloads are validated (must contain `package/package.json`) before being accepted.
- Unpacks each package into `data/jp-core/<name>-<version>/` and removes the intermediate `.tgz` files.

Re-running is idempotent: already-unpacked packages are skipped.

## `deploy.ts` — load conformance into Medplum

Implements the pattern documented at <https://www.medplum.com/docs/fhir-datastore/profiles>: the `StructureDefinition` for any profile you reference via `meta.profile` (and the terminology it binds to) must exist in your project.

```bash
MEDPLUM_BASE_URL=https://api.medplum.com/ \
MEDPLUM_CLIENT_ID=... \
MEDPLUM_CLIENT_SECRET=... \
  npm run deploy               # → tsx src/deploy.ts ./data

# Preview counts without uploading:
npx tsx src/deploy.ts ./data --dry-run
```

Environment variables (loaded via `dotenv`, or export them yourself):

| Variable               | Description                                  |
| ---------------------- | -------------------------------------------- |
| `MEDPLUM_BASE_URL`     | Medplum server base URL                      |
| `MEDPLUM_CLIENT_ID`    | Client application ID (client credentials)   |
| `MEDPLUM_CLIENT_SECRET`| Client application secret                    |

`bash ./scripts/set_env.bash <dev|prod>` copies `.env.<env>` → `.env` (loaded by `dotenv`), so you don't have to export these by hand — see [Getting started](#getting-started).

### How it works

1. **Auth** — `medplum.startClientLogin(clientId, clientSecret)` (client credentials flow).
2. **Collect** — reads the top-level `package/*.json` files from each deployed package (examples, `openapi/`, `xml/` sub-directories are ignored) and keeps only the conformance resource types listed below.
3. **Filter** — two classes of artifact are dropped up front and reported as skips rather than uploaded:
   - **Base terminology** — CodeSystems whose canonical `url` is under a base root (`terminology.hl7.org`, `loinc.org`, `snomed.info`, `urn:iso:`, `urn:ietf:`, …). Medplum ships these built-in and forbids overwriting them (HTTP 403).
   - **Oversized CodeSystems** — anything serializing larger than `MAX_UPLOAD_BYTES` (4 MB). Medplum imports concepts into Postgres and exceeds its bind-parameter limit for large code systems.
4. **Sanitize** — strips `ElementDefinition.example` entries missing the required `label` (a defect in some published JP Core profiles, e.g. `JP_Consent`, that Medplum otherwise rejects). Examples are non-normative, so this doesn't change how instances validate.
5. **Resolve base extensions** — pulls in the base extension StructureDefinitions the JP profiles reference and de-versions those references (see [Base extensions & the Medplum UI](#base-extensions--the-medplum-ui)).
6. **Order** — uploads type-by-type in dependency order so that ValueSet bindings and StructureDefinition references resolve as they land:

   ```
   CodeSystem → ValueSet → StructureDefinition → SearchParameter → NamingSystem → CapabilityStatement
   ```

7. **Idempotent upload** — each resource is sent as a FHIR **conditional update** inside a batch `Bundle` (`medplum.executeBatch`), keyed on its canonical `url` (`PUT StructureDefinition?url=...`; resources without a `url`, such as R4 `NamingSystem`, fall back to `?name=`). Server-managed `id` and `meta` are stripped so the canonical URL is the sole identity key and version history is never contested. Re-runs update resources in place instead of duplicating.
8. **Batching & resilience** — entries are grouped into batches bounded by both entry count (`BATCH_SIZE`) and serialized bytes (`MAX_BATCH_BYTES`) so a batch never exceeds the server's request-size limit. If a whole batch is rejected at the request level (e.g. HTTP 413) it is split in half and retried down to single entries, so one oversized resource never aborts the run.
9. **Reporting** — per-entry statuses are classified into deployed / skipped (base) / skipped (protected, 403) / skipped (too large) / failed. Known server limits are reported as skips; only genuine, unexpected errors count as failures, and the process exits non-zero only if `failed > 0`.

### Base extensions & the Medplum UI

JP Core profiles reference a handful of base extensions with a **version-pinned canonical** in `type.profile`, e.g. `http://hl7.org/fhir/StructureDefinition/patient-religion|4.0.1`. Two problems follow when editing such a resource in the Medplum app:

- Those base extension StructureDefinitions aren't in the project (we don't deploy the base `hl7.fhir.r4.core` / `hl7.fhir.uv.extensions.r4` packages), and
- Medplum's React `ExtensionInput` looks the extension up with `StructureDefinition?url=<canonical>`, and **Medplum's `url` search does not match the `|version` suffix** (only `$expand` handles versioned canonicals). So the lookup returns nothing and the field hangs on "loading…".

`deploy.ts` fixes both: it scans profile `type.profile` values, and for each version-pinned `hl7.org` extension it **loads that extension's StructureDefinition** from the base package (at the pinned version — `4.0.1` from `hl7.fhir.r4.core`, `5.2.0` from `hl7.fhir.uv.extensions.r4`) and **strips the `|version`** from the reference so the UI resolves it by bare canonical. For JP Core 1.2.0 this adds 5 extensions (`patient-religion`, `patient-birthPlace`, `encounter-associatedEncounter`, `bodySite`, `iso21090-EN-representation`).

> Coded/enum fields bound to a **ValueSet** are unaffected — the Medplum client expands bindings via `$expand`, which _does_ resolve versioned canonicals — as long as the ValueSet exists (base ones ship with Medplum; JP ones are deployed).

> **After redeploying, hard-refresh the Medplum app.** The client caches profile schemas (including the failed lookup) in memory per session, so an already-open tab won't pick up the newly loaded extensions until reloaded.

### Modifications to source artifacts

For transparency: to make the artifacts load and render in Medplum, `deploy.ts` does **not** upload every profile byte-for-byte as published. It makes two narrow, logged edits to StructureDefinitions in memory before upload (the files on disk are never changed):

| Edit | Why | Impact |
| ---- | --- | ------ |
| Drops `ElementDefinition.example` entries missing the required `label` | Published defect (e.g. `JP_Consent`) that Medplum rejects with "Missing required property" | None — examples are non-normative documentation |
| Strips `\|version` from base-extension `type.profile` refs | Medplum's `url` search can't match versioned canonicals, so the UI can't resolve the extension | Reference becomes version-agnostic; resolves to the (single) loaded extension |

Both are reported in the run output (`removed N malformed example(s)`, `added N … base extension(s); de-versioned their type.profile refs`). If you'd rather the tool fail loudly on such defects than edit around them, remove `sanitizeExamples` / `resolveBaseExtensions` from the collect phase.

### Configuration

Knobs at the top of [src/deploy.ts](src/deploy.ts):

- `PACKAGES_TO_DEPLOY` — which unpacked packages to load (defaults to the two JP-specific packages). Add the upstream base packages here if your target server is missing base extensions/terminology that JP Core references.
- `RESOURCE_TYPE_ORDER` — the resource types loaded and the order they load in.
- `BASE_TERMINOLOGY_PREFIXES` — canonical URL roots treated as Medplum built-ins and skipped.
- `BATCH_SIZE` (50) / `MAX_BATCH_BYTES` (4 MB) — batch sizing bounds.
- `MAX_UPLOAD_BYTES` (4 MB) — single-resource ceiling above which a CodeSystem is skipped as too large for inline import.
- `BASE_EXTENSION_SOURCES` — base packages (keyed by version) that supply the referenced base extension StructureDefinitions.

### Large CodeSystems

A handful of large JP terminology CodeSystems (drug/disease masters such as `jami.jp/CodeSystem/MedicationUsage` with 178k concepts, `mhlw/masterB-disease`, the MEDIS HOT/YJ code masters) contain tens of thousands of inline concepts. Medplum's inline concept import exceeds the Postgres bind-parameter limit for these, so `deploy.ts` reports them under "too large for inline import" and skips them. Load them separately with [`deploy-terminology.ts`](#deploy-terminologyts--load-large-codesystems) below.

### Expected result

Deploying the default package set against a Medplum server yields:

| Outcome                         | Count |
| ------------------------------- | ----: |
| **Deployed**                    | ~395  |
| Skipped — base terminology      |    11 |
| Skipped — too large (`$import`) |     9 |
| Failed                          |     0 |

Deployed breakdown by type (of 402 attempted, 7 mid-size CodeSystems fail the Postgres param limit at runtime and are re-classified as too-large skips):

| Type                | Deployed |
| ------------------- | -------: |
| CodeSystem          |      103 |
| ValueSet            |      121 |
| StructureDefinition |      116 |
| SearchParameter     |        8 |
| NamingSystem        |       45 |
| CapabilityStatement |        2 |
| **TOTAL**           |  **395** |

The 116 StructureDefinitions are the 111 JP profiles/extensions plus the 5 referenced base extensions (see [Base extensions & the Medplum UI](#base-extensions--the-medplum-ui)).

## `deploy-terminology.ts` — load large CodeSystems

Companion to `deploy.ts` for the large terminology it can't load inline. Uses the [`CodeSystem/$import`](https://www.medplum.com/docs/api/fhir/operations/codesystem-import) operation, which streams concepts into Medplum's terminology tables instead of embedding them in the resource body.

```bash
MEDPLUM_BASE_URL=https://api.medplum.com/ \
MEDPLUM_CLIENT_ID=... \
MEDPLUM_CLIENT_SECRET=... \
  npm run deploy-terminology        # → tsx src/deploy-terminology.ts ./data

npx tsx src/deploy-terminology.ts ./data --dry-run   # list targets, import nothing
```

> **Permissions:** `$import` requires **Project Admin**. The client credentials used must have admin access to the target project.

Run it **after** `deploy.ts` (the CodeSystem's ValueSets and profiles should be in place first). Uses the same env vars as `deploy.ts`.

**Idempotent.** `$import` upserts concepts by `(system, code)`, so re-running lands the same state as running once — importing an existing code updates it in place rather than creating a duplicate. (Verified: re-importing a code with a changed display updates the single existing code; re-importing the original restores it.) The metadata step likewise uses `upsertResource` keyed on `url`.

### How it works

1. **Select** — loads every non-base CodeSystem and keeps those with at least `MIN_IMPORT_CONCEPTS` (10,000) concepts — i.e. the ones `deploy.ts` skips. (The inline-import limit sits around ~15–18k concepts; the threshold is set below that so nothing is missed, and any overlap with inline-loaded systems is harmless because `$import` is idempotent.)
2. **Upsert metadata** — writes a lightweight CodeSystem resource for each system (inline concepts stripped, `content: "not-present"`) so the resource exists for bindings and later updates never wipe the imported concepts.
3. **Flatten** — walks each (possibly hierarchical) concept tree into a flat list of `{ code, display }`. Hierarchy is not preserved; these masters are consumed as flat value sets, which is sufficient for `$expand` / `$validate-code`.
4. **Import** — sends concepts to `CodeSystem/$import` in chunks of `IMPORT_CHUNK` (2,000), well under the Postgres bind-parameter limit. A rejected chunk is split and retried down to a single concept, so one bad code never aborts a system.

### Configuration

Knobs at the top of [src/deploy-terminology.ts](src/deploy-terminology.ts):

- `MIN_IMPORT_CONCEPTS` (10,000) — minimum concept count to handle here; set to `0` to import every non-base CodeSystem via `$import`.
- `IMPORT_CHUNK` (2,000) — concepts per `$import` request.

### Expected result

Against the default package set it imports 11 code systems totalling ~451k concepts (shown largest-first below; the script runs smallest-first):

| CodeSystem                                              | Concepts |
| ------------------------------------------------------- | -------: |
| `jami.jp/CodeSystem/MedicationUsage`                    |  178,214 |
| `medis.or.jp/CodeSystem/master-HOT13`                   |   63,058 |
| `medis.or.jp/CodeSystem/master-HOT9`                    |   33,533 |
| `medis.or.jp/CodeSystem/master-disease-keyNumber`       |   28,284 |
| `mhlw/CodeSystem/masterB-disease`                       |   27,564 |
| `medis.or.jp/CodeSystem/master-disease-exCode`          |   27,056 |
| `YCM/JP_JfagyMedicationAllergen_CS`                     |   25,110 |
| `capstandard.jp/iyaku.info/CodeSystem/YJ-code`          |   25,106 |
| `capstandard.jp/iyaku.info/CodeSystem/YJ-code-active`   |   18,134 |
| `mhlw/CodeSystem/ICD10-2013-full`                       |   14,877 |
| `medis.or.jp/CodeSystem/master-HOT7`                    |   10,069 |
| **TOTAL**                                               | **~451k** |

### Querying imported terminology

Imported concepts live in Medplum's terminology tables (the CodeSystem resource itself is stored `content: "not-present"`), and are resolvable via the standard operations:

```ts
// exact, works for any imported code:
await medplum.get(medplum.fhirUrl('CodeSystem', '$validate-code')
  .toString() + `?url=${system}&code=${code}`);   // -> result: true/false
await medplum.get(medplum.fhirUrl('CodeSystem', '$lookup')
  .toString() + `?system=${system}&code=${code}`); // -> display, etc.
```

**`$expand` is capped at ~1000 results** and won't enumerate a full 178k-concept master, so don't rely on it for exact membership or counts — use `$validate-code` / `$lookup` (exact), or a **filtered/paginated** `$expand`. Medplum also does not expand the implicit `<system>?fhir_vs` value set; expand a real `ValueSet` (or an inline one via the `valueSet` parameter) that `compose.include`s the system.

## `deploy-examples.ts` — seed demo patients

Seeds Medplum with 3 mock JP Core patients (see table above) built from the shipped examples in `data/jp-core/…/example/`, extrapolated so the patients differ from each other. Each patient is one **transaction bundle** in [data/example/](data/example/).

### Resources in each bundle (16)

Each bundle holds the same 16 resource **types**; the values differ per patient. The **4 shared** resources (top) are identical across all three patients (same Medplum IDs); the **11 patient-specific** resources vary as shown.

| Resource (profile) | Patient 01 | Patient 02 | Patient 03 |
| --- | --- | --- | --- |
| **Practitioner** ×2 (`JP_Practitioner`) | 大阪 一郎 (m) · 東京 春子 (f) — *shared, constant* | ← same | ← same |
| **Organization** ×2 (`JP_Organization`) | 健康第一病院 · ひまわり健康保険組合 — *shared, constant* | ← same | ← same |
| Patient (`JP_Patient`) | 山田 太郎 | 佐藤 花子 | 鈴木 健一 |
| Coverage (`JP_Coverage`) | 記号 あいう / 番号 １２３ | かきく / ４５６ | さしす / ７８９ |
| Encounter (`JP_Encounter`) | AMB outpatient (2023-02-10) | AMB outpatient (2023-03-05) | IMP inpatient (2023-01-16→20) |
| Condition (`JP_Condition_Diagnosis`) | 橈骨遠位端骨折 (CJTR) | 本態性高血圧症 (URSQ) | ２型糖尿病 (U23V) |
| AllergyIntolerance (`JP_AllergyIntolerance`) | そば / high / アナフィラキシー | 鶏卵 / low / 口腔内違和感 | 落花生 / high / 蕁麻疹 |
| Observation — vital signs (`JP_Observation_VitalSigns`) | 呼吸数 16 回 | 18 回 | 20 回 |
| Observation — body measurement (`JP_Observation_BodyMeasurement`) | 体重 63.5 kg | 54.0 kg | 71.2 kg |
| Specimen (`JP_Specimen_Common`) | urine (UR) | urine (UR) | urine (UR) |
| Observation — lab result (`JP_Observation_LabResult`) | 尿酸 8.5 mg/dL (H) | 4.2 (N) | 6.9 (N) |
| Observation — social history (`JP_Observation_SocialHistory`) | 喫煙指数 400 (20/日 ×20年) | 0 (非喫煙) | 900 (30/日 ×30年) |
| Immunization (`JP_Immunization`) | 肺炎球菌ワクチン | 組換え沈降Ｂ型肝炎ワクチン | 肺炎球菌ワクチン |
| MedicationRequest (`JP_MedicationRequest`) | ロキソプロフェンＮａ細粒 | アムロジピン錠 | メトホルミン塩酸塩錠 |

References between these (e.g. `Observation.subject` → Patient, `Encounter.serviceProvider` → hospital, `Observation.performer` → practitioner, `Coverage.payor` → payer, `Observation.specimen` → Specimen) are wired within the bundle and resolved to real Medplum IDs on deploy.

### How references and identity work

- **Reference resolution** — every entry has a `fullUrl: "urn:uuid:…"` and all intra-bundle references use those urn:uuids. Posting the bundle as a FHIR **transaction** makes Medplum assign real IDs and rewrite every reference to the assigned `ResourceType/id` atomically — no second pass needed.
- **Constant practitioners** — the 2 Practitioners and 2 Organizations use the same urn:uuid in all three bundles and are written with conditional create (`ifNoneExist` on a business identifier), so they are created once and reused. The script prints their IDs to confirm they stay constant across patients. They are plain `Practitioner` resources — **not** Medplum users/logins.
- **Idempotent** — every patient-specific resource also carries a stable demo identifier (`urn:example:jp-core-demo|<patient>:<tag>`) and is conditionally created on it, so re-running the script creates nothing new (verified: a second run writes 0 resources).

> Uses the same `MEDPLUM_*` env vars as `deploy.ts`. Run `deploy.ts` (and ideally `deploy-terminology.ts`) first so the JP profiles and terminology the demo data references are already loaded.
