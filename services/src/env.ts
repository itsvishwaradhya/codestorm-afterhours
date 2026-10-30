import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const files = [
  fileURLToPath(new URL("../../.env", import.meta.url)),
  fileURLToPath(new URL("../.env", import.meta.url)),
];

for (const file of files) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    console.warn(`[env] could not load ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
