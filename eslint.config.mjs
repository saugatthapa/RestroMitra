import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import { globalIgnores } from "eslint/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next@15.x still ships its "core-web-vitals"/"typescript"
// presets as legacy (non-flat) configs, not native ESLint 9 flat config —
// FlatCompat is the standard bridge Next's own create-next-app scaffolds
// for this version, converting those legacy configs into flat-config
// entries this file's array can use directly.
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Parallel-agent git worktrees (see .claude/worktrees/) live under the
    // repo root and each contains a full copy of src/ — without this,
    // ESLint's flat-config file globbing walks every one of them too,
    // multiplying warning/error counts by however many worktrees happen to
    // exist at lint time and (with enough of them) making full-repo lint
    // runs pathologically slow. Diagnosed twice in this project's history
    // (a spurious 48,015-error run, and a full timeout with 14 worktrees
    // live) before landing this ignore.
    ".claude/worktrees/**",
  ]),
];

export default eslintConfig;
