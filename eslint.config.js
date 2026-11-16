// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      // Prisma-generated test client (output of `prisma generate`).
      "packages/prisma/test/prisma/**",
      // Same thing for the examples. Each one generates its own client into
      // `generated/` so the two cannot overwrite each other in the shared
      // @prisma/client install, which also means two more directories of
      // generated code that is not ours to lint.
      "examples/*/generated/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
