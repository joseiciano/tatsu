# Refactor plan

## Summary

### Goal

Restructure the file structure inside `src/` into package-style directories without changing runtime behavior. 

The first pass will stay mechanical, moving files, adding barrel exports, and updating imports to use barrel paths. 

The second pass is going over the contents of the file themselves and restructuring them based on the plan. This second pass is where logic splitting amongst multiple files occurs. 

### Why
- Reduce file size and make modules easier to scan
- Improve context quality for AI-assisted coding
- Make public module surface explicit through barrel exports
- Improve readability from a human perspective, as we can add in extra documentation later on 

## Scope

This plan covers all files within `src` that are the main render logic (the entrypoint of this app). 

This plan will be done in batches, with each batch being one subdirectory within `src`

**Batch 1**: `src/main/`
**Batch 2**: `src/preload/`
**Batch 3**: `src/renderer/`
**Batch 4**: `src/shared/`

For the two passes we are to do, they should only be done on the given batch. If updating one batch results in linter errors in a directory that would be in another batch, update the imports only. Otherwise, leave the directory and its files alone to be done in another batch. 

## Target structure

Each module moves into folder with same name as file stem. Folder name and primary file name stay identical.

```
src/main/
  package-1/
    index.ts
    package-1.ts
    package-1.test.ts #optional
    types.ts        # optional
    constants.ts    # optional
```

Example:

```
src/main/store/
  index.ts
  store.ts
  store.test.ts
```

## Package rules

### Required
- `index.ts`: barrel file for public exports
- `x.ts`: core module implementation

### Optional
- `types.ts`: add only when package has real shared types worth extracting
- `constants.ts`: add only when package has real shared constants worth extracting
- `x.test.ts`: module tests. Add only when this file already exists. 

Do not create empty `x.test.ts`, `types.ts` or `constants.ts` files.

## Import rules

All imports must use barrel path after move.

### Good
```ts
import { Store } from './store'
import { getRepoInfo } from './github'
```

### Bad
```ts
import { Store } from './store/store'
import { getRepoInfo } from './github/github'
```

Tests inside package should also import through barrel when practical, unless local relative access inside same package is clearly simpler and does not bypass intended public surface. Default preference: barrel import.

## Refactor strategy

### Phase 1 — mechanical move
For each paired module:
1. Create package directory under `src/main/<name>/`
2. Move `<name>.ts` to `src/main/<name>/<name>.ts`
3. Move `<name>.test.ts` to `src/main/<name>/<name>.test.ts` (if it exists)
4. Add `src/main/<name>/index.ts` that re-exports public API from `<name>.ts`
5. Update imports across repo to use barrel path only
6. Keep behavior unchanged

### Phase 2 — selective internal split
After move settles, split large packages further only where useful:
- move shared types into `types.ts`
- move reusable constants into `constants.ts`
- leave small modules alone

This phase is intentionally out of scope for first pass.

## Batching plan

Remember, the phases are meant to be done on each bach in a separate phase (i.e. If I prompt to implement phase 1 on batch 1, you should only implement changes on the directory/files in batch 1. At most, update imports from other files not in batch 1 to use the new imports we made from changing batch 1's structure.)


**Batch 1**: `src/main/`
**Batch 2**: `src/preload/`
**Batch 3**: `src/renderer/`
**Batch 4**: `src/shared/`

## Verification

Run after each batch:
- `pnpm typecheck`
- `npx electron-vite build`
- targeted `npx vitest run` for touched packages, or full `npx vitest run` when import churn is broad
- import audit: no deep moved-module imports like `./store/store` or `../store/store`; use barrel imports like `./store` or `../store`
- import audit: moved package internals use correct relative paths for unmoved root helpers, e.g. `../debug`, `../paths`, `../worktree`

## Success criteria

Refactor considered successful when:
- every targeted pair lives inside package directory with same stem name
- every moved package exports through `index.ts`
- imports use barrel paths, not deep package file paths
- no behavior changes introduced by move
- typecheck, build, and tests pass after each completed batch
