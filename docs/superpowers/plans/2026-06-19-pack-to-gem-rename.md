# Gem → Gem Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the core domain concept `Gem` → `Gem` across code, the MCP tool, the on-disk archive format, and docs/memory — with zero behavioral change.

**Architecture:** A curated, symbol-class-by-symbol-class rename (not a blind `s/gem/gem/g`). Word-boundary (`\b`) replacements protect the look-alikes that must stay (`packTar`/`unpackTar`/`unpacked`, anything with `package`). Each task is a coherent rename pass that keeps `tsc` and the vitest suite green, then commits.

**Tech Stack:** TypeScript, pnpm, vitest, BSD `sed` (macOS — uses `sed -i ''`).

## Global Constraints

- **Curated rename, never blind.** Every `sed` uses `\b` word boundaries on a specific identifier. Never run `s/gem/gem/g`.
- **Never rename:** `packTar`, `unpackTar`, `unpacked`, `unpacks` (generic tar verb); any token containing `package` (`allow_package_managers`, `packageManager`, `package.json`).
- **Clean break on disk:** no backward-compat reading of legacy `gem.json`/`gem.lock`.
- **Green between tasks:** every task ends with `pnpm build` AND `pnpm test` passing, then a commit.
- **macOS sed:** in-place edits use `sed -i ''` (note the empty-string arg).
- Spec: `docs/superpowers/specs/2026-06-19-gem-to-gem-rename-design.md`.

---

### Task 1: Rename files & directories, fix import paths

Move files first (history-preserving), updating only import *paths* — no identifier renames yet, so the build stays green.

**Files:**
- Move: `src/gem/` → `src/gem/` (whole dir incl. `__tests__/`)
- Move: `src/gem.controller.ts` → `src/gem.controller.ts`
- Move: `src/gem.tools.ts` → `src/gem.tools.ts`
- Move: `src/gem/buildPack.ts` → `src/gem/buildGem.ts`
- Move: `src/gem/__tests__/buildPack.test.ts` → `src/gem/__tests__/buildGem.test.ts`
- Move: `src/__tests__/gem.controller.test.ts` → `src/__tests__/gem.controller.test.ts`
- Modify: every file importing the above paths.

**Interfaces:**
- Consumes: nothing.
- Produces: new file layout under `src/gem/`; modules `./gem/buildGem`, `./gem.controller`, `./gem.tools` importable. Symbol names are unchanged this task (`buildPack`, `Gem`, etc. still exist).

- [ ] **Step 1: Move directory and files with git mv**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
git mv src/gem src/gem
git mv src/gem.controller.ts src/gem.controller.ts
git mv src/gem.tools.ts src/gem.tools.ts
git mv src/gem/buildPack.ts src/gem/buildGem.ts
git mv src/gem/__tests__/buildPack.test.ts src/gem/__tests__/buildGem.test.ts
git mv src/__tests__/gem.controller.test.ts src/__tests__/gem.controller.test.ts
```

- [ ] **Step 2: Fix import paths referencing moved modules**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
# directory + module path segments in import specifiers and any string paths
grep -rl --include='*.ts' -e "gem/" -e "gem.controller" -e "gem.tools" -e "buildPack" src \
  | xargs sed -i '' \
      -e "s#/gem/#/gem/#g" \
      -e "s#\./gem/#./gem/#g" \
      -e "s#\./gem\.controller#./gem.controller#g" \
      -e "s#\./gem\.tools#./gem.tools#g" \
      -e "s#/buildPack#/buildGem#g" \
      -e "s#\./buildPack#./buildGem#g"
```

- [ ] **Step 3: Build to verify paths resolve**

Run: `pnpm build`
Expected: PASS (no "Cannot find module" errors). The `buildPack` *symbol* still exists inside `buildGem.ts`; only paths changed.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS (all suites; behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(gem): rename gem files/dirs to gem; fix import paths"
```

---

### Task 2: Rename the `Gem` type family → `Gem`

Rename the domain *types/interfaces* (not zod schemas, not functions — those are Tasks 3–4). Word boundaries keep `PackArtifactSchema`, `packTar`, etc. untouched.

**Files:**
- Modify: `src/gem/types.ts` (definitions) and every consumer under `src/`.
- Test: existing suites assert these types indirectly; they must still pass.

**Interfaces:**
- Consumes: file layout from Task 1.
- Produces: `Gem`, `GemArtifact`, `GemCheck`, `GemVerificationReport`, `GemLock`, `GemManifest`, `GemManifestArtifact`, `GemSelection` (replacing the `Gem*` type names). `*Schema` names are NOT changed yet.

- [ ] **Step 1: Replace type identifiers (specific tokens, word-bounded)**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
FILES=$(grep -rl --include='*.ts' -E '\b(Gem|PackArtifact|PackCheck|PackVerificationReport|PackLock|PackManifest|PackManifestArtifact|PackSelection)\b' src)
echo "$FILES" | xargs sed -i '' \
  -e 's/\bPackVerificationReport\b/GemVerificationReport/g' \
  -e 's/\bPackManifestArtifact\b/GemManifestArtifact/g' \
  -e 's/\bPackManifest\b/GemManifest/g' \
  -e 's/\bPackSelection\b/GemSelection/g' \
  -e 's/\bPackArtifact\b/GemArtifact/g' \
  -e 's/\bPackCheck\b/GemCheck/g' \
  -e 's/\bPackLock\b/GemLock/g' \
  -e 's/\bPack\b/Gem/g'
```

(Note: `\bPackArtifact\b` etc. do NOT match `PackArtifactSchema` — those carry the `Schema` suffix and are handled in Task 3.)

- [ ] **Step 2: Build to verify all type references updated**

Run: `pnpm build`
Expected: PASS. A failure here names any file still referencing an old `Gem*` type — fix and rebuild.

- [ ] **Step 3: Confirm no schema names were caught**

Run: `grep -rnE '\bGem[A-Za-z]*Schema\b' src`
Expected: NO matches (schemas are still `Gem*Schema` until Task 3).

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(gem): rename Gem type family to Gem"
```

---

### Task 3: Rename the zod schemas `Gem*Schema` → `Gem*Schema`

**Files:**
- Modify: `src/schemas.ts` (definitions) and every consumer (`src/gem.tools.ts`, `src/gem.controller.ts`, `src/gem/*.ts`, tests).

**Interfaces:**
- Consumes: type names from Task 2.
- Produces: `GemSchema`, `GemRequestSchema`, `GemSelectionSchema`, `GemCheckSchema`, `GemManifestSchema`, `GemManifestArtifactSchema`, `GemLockSchema`, `GemArtifactSchema`.

- [ ] **Step 1: Replace schema identifiers (word-bounded)**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
FILES=$(grep -rl --include='*.ts' -E '\bPack[A-Za-z]*Schema\b' src)
echo "$FILES" | xargs sed -i '' \
  -e 's/\bPackManifestArtifactSchema\b/GemManifestArtifactSchema/g' \
  -e 's/\bPackManifestSchema\b/GemManifestSchema/g' \
  -e 's/\bPackSelectionSchema\b/GemSelectionSchema/g' \
  -e 's/\bPackRequestSchema\b/GemRequestSchema/g' \
  -e 's/\bPackArtifactSchema\b/GemArtifactSchema/g' \
  -e 's/\bPackCheckSchema\b/GemCheckSchema/g' \
  -e 's/\bPackLockSchema\b/GemLockSchema/g' \
  -e 's/\bPackSchema\b/GemSchema/g'
```

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 3: Verify no stray `Gem*Schema` remain**

Run: `grep -rnE '\bPack[A-Za-z]*Schema\b' src`
Expected: NO matches.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(gem): rename Gem*Schema to Gem*Schema"
```

---

### Task 4: Rename functions, classes, fields, fixtures

Rename the remaining mixed-case / specific lowercase identifiers. Each is word-bounded, so `packTar`/`unpackTar`/`unpacked`/`package*` are untouched.

**Files:**
- Modify: `src/gem/buildGem.ts`, `src/gem/archive.ts`, `src/gem.controller.ts`, `src/gem.tools.ts`, and all consumers/tests referencing these symbols.

**Interfaces:**
- Consumes: types (Task 2) + schemas (Task 3).
- Produces: `buildGem()`, `writeGemArchive()`, `readGemArchive()`, classes `GemController`/`GemTools`, `GemInput`, lock field `gemDigest`, var `gemName`; test fixtures `mygem`/`my_gem`.

- [ ] **Step 1: Replace function/class/field/fixture identifiers (word-bounded)**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
FILES=$(grep -rl --include='*.ts' -E '\b(buildPack|writePackArchive|readPackArchive|PackController|PackTools|PackInput|gemDigest|packName|packname|mypack|my_pack)\b' src)
echo "$FILES" | xargs sed -i '' \
  -e 's/\bwritePackArchive\b/writeGemArchive/g' \
  -e 's/\breadPackArchive\b/readGemArchive/g' \
  -e 's/\bPackController\b/GemController/g' \
  -e 's/\bPackTools\b/GemTools/g' \
  -e 's/\bPackInput\b/GemInput/g' \
  -e 's/\bbuildPack\b/buildGem/g' \
  -e 's/\bpackDigest\b/gemDigest/g' \
  -e 's/\bpackName\b/gemName/g' \
  -e 's/\bpackname\b/gemname/g' \
  -e 's/\bmypack\b/mygem/g' \
  -e 's/\bmy_pack\b/my_gem/g'
```

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: PASS. Archive tests still reference `gem.json`/`gem.lock` strings (unchanged until Task 5) and the `gemDigest` field via the renamed symbol — both consistent.

- [ ] **Step 4: Confirm tar verbs & package tokens survived**

Run: `grep -rnE '\b(packTar|unpackTar|unpacked|allow_package_managers)\b' src`
Expected: matches STILL present and unchanged (these must NOT be renamed).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(gem): rename buildPack/archive fns, controller/tools classes, fields, fixtures"
```

---

### Task 5: On-disk format strings, MCP tool name, lowercase noun

The ordering-sensitive pass. Do the literal-string changes (tool name, file names) FIRST, then the global bare-`gem` noun sweep, so `"gem"` (tool) → `"build_gem"` rather than `"gem"`.

**Files:**
- Modify: `src/gem/archive.ts` (`MANIFEST_PATH`, `LOCK_PATH`, error strings), `src/gem.tools.ts` (`@tool("gem")`, default name), plus any remaining bare-`gem` in comments/vars/prompts/tests.

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: archive written as `gem.json`/`gem.lock`; MCP tool `build_gem`; default gem name `"gem"`.

- [ ] **Step 1: Change the MCP tool name and default name explicitly (before the global sweep)**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
sed -i '' -e 's/@tool("gem"/@tool("build_gem"/' src/gem.tools.ts
sed -i '' -e 's/input\.name ?? "gem"/input.name ?? "gem"/' src/gem.tools.ts
```

- [ ] **Step 2: Change on-disk file names and error strings**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
sed -i '' -e 's/"gem\.json"/"gem.json"/g' -e 's/"gem\.lock"/"gem.lock"/g' src/gem/archive.ts
# error-message prose that names the files (string literals, not paths)
grep -rl --include='*.ts' -e 'gem.json' -e 'gem.lock' src \
  | xargs sed -i '' -e 's/gem\.json/gem.json/g' -e 's/gem\.lock/gem.lock/g'
```

- [ ] **Step 3: Sweep remaining bare lowercase `gem` noun (word-bounded)**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
# \bpack\b matches the bare noun only — NOT packTar/unpacked/package
FILES=$(grep -rlE '\bpack\b' --include='*.ts' src)
[ -n "$FILES" ] && echo "$FILES" | xargs sed -i '' -e 's/\bpack\b/gem/g'
```

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: PASS. Archive round-trip tests now assert `gem.json`/`gem.lock`. If a test still hard-codes `gem.json`, update that literal to `gem.json` and re-run.

- [ ] **Step 6: Final grep gate over source**

Run:
```bash
grep -rInE '\b[A-Za-z_]*[Pp]ack[A-Za-z_]*\b' src
```
Expected: ONLY intentional survivors — `packTar`, `unpackTar`, `unpacked`, `unpacks`, `allow_package_managers`, `packageManager`, `package.json`. Any other hit must be renamed before committing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(gem): on-disk gem.json/gem.lock, build_gem tool, lowercase noun"
```

---

### Task 6: Docs & memory

**Files:**
- Move + edit: `docs/superpowers/plans/2026-06-16-gem-checks.md`, `docs/superpowers/plans/2026-06-18-gem-archive-format.md`, `docs/superpowers/plans/2026-06-18-gem-workspaces.md`, `docs/superpowers/specs/2026-06-16-gem-checks-design.md`, `docs/superpowers/specs/2026-06-18-gem-archive-format-design.md`, `docs/superpowers/specs/2026-06-18-gem-workspaces-design.md`.
- Modify: auto-memory `…/memory/gem-archive-format-spec.md` and `…/memory/MEMORY.md`.

**Interfaces:**
- Consumes: final naming from Tasks 1–5.
- Produces: docs/memory consistent with `Gem`/`gem.json`/`gem.lock`/`gemDigest`/`build_gem`.

- [ ] **Step 1: Rename the doc files**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
git mv docs/superpowers/plans/2026-06-16-gem-checks.md          docs/superpowers/plans/2026-06-16-gem-checks.md
git mv docs/superpowers/plans/2026-06-18-gem-archive-format.md  docs/superpowers/plans/2026-06-18-gem-archive-format.md
git mv docs/superpowers/plans/2026-06-18-gem-workspaces.md      docs/superpowers/plans/2026-06-18-gem-workspaces.md
git mv docs/superpowers/specs/2026-06-16-gem-checks-design.md         docs/superpowers/specs/2026-06-16-gem-checks-design.md
git mv docs/superpowers/specs/2026-06-18-gem-archive-format-design.md docs/superpowers/specs/2026-06-18-gem-archive-format-design.md
git mv docs/superpowers/specs/2026-06-18-gem-workspaces-design.md     docs/superpowers/specs/2026-06-18-gem-workspaces-design.md
```

- [ ] **Step 2: Update prose inside docs (preserve tar/package terms)**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
grep -rlE '\b[Pp]ack\b' docs/superpowers \
  | xargs sed -i '' \
      -e 's/\bPack\b/Gem/g' \
      -e 's/\bpack\.json\b/gem.json/g' \
      -e 's/\bpack\.lock\b/gem.lock/g' \
      -e 's/\bpackDigest\b/gemDigest/g' \
      -e 's/\bpack\b/gem/g'
```

Then read each renamed doc and fix any now-awkward sentence by hand (the auto-pass is a first cut, not the final word). Leave `packTar`/`package` references intact.

- [ ] **Step 3: Update auto-memory**

Rewrite `/Users/rfeng/.claude/projects/-Users-rfeng-Projects-ninemind-agentgem/memory/gem-archive-format-spec.md`:
- Rename the file to `gem-archive-format-spec.md` (and its `name:` frontmatter slug to `gem-archive-format-spec`).
- Update body to describe `gem.json` + `gem.lock` + `gemDigest` serializing a `Gem`.

Then update `…/memory/MEMORY.md`: change the index line to point at `gem-archive-format-spec.md` with a `Gem`-worded hook, and do a light prose pass on the target fast-follow lines that say "Gem".

- [ ] **Step 4: Verify docs grep gate**

Run: `grep -rInE '\b[A-Za-z_]*[Pp]ack[A-Za-z_]*\b' docs`
Expected: only intentional `packTar`/`package`-style survivors, if any.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(gem): rename gem docs/memory to gem"
```

---

## Self-Review

**Spec coverage:**
- Code symbols + files → Tasks 1–4. ✓
- MCP tool name (`build_gem`) → Task 5 Step 1. ✓
- On-disk format (`gem.json`/`gem.lock`/`gemDigest`, clean break) → Tasks 4 (field) + 5 (strings). ✓
- Docs + memory → Task 6. ✓
- "Deliberately NOT renamed" guardrail → Global Constraints + verified in Task 4 Step 4 and the Task 5/6 grep gates. ✓

**Placeholder scan:** No TBD/TODO; every code step has the exact command. ✓

**Type consistency:** `Gem`/`GemArtifact`/`GemCheck`/`Gem*Schema`/`buildGem`/`writeGemArchive`/`readGemArchive`/`GemController`/`GemTools`/`GemInput`/`gemDigest` used identically across tasks and match the spec table. ✓

**Note on ordering:** Tasks 2–4 use `\b`-bounded replacements, so they are internally order-independent except where longer tokens are listed first as defense-in-depth. Task 5 is the one ordering-sensitive pass (tool/file literals before the bare-`gem` sweep) and is sequenced accordingly.
