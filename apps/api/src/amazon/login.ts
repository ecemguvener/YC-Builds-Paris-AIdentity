import { loadConfig } from "../config.js";
import { captureAmazonLogin } from "./purchase.js";

// One-time login session capture: `npm run amazon:login`
async function main(): Promise<void> {
  const config = loadConfig();
  await captureAmazonLogin(config);
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[amazon:login] failed:", error);
  process.exit(1);
});
