import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
  },
  // public/ is the one place browser code lives — served to a page, never
  // run under Node. Without this it was linted with no globals at all, which
  // flags fetch, document, location and console as undefined.
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.browser,
    },
  },
];
