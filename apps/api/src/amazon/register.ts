import { loadConfig } from "../config.js";
import { registerAmazonAccount } from "./purchase.js";

// Create a new Amazon account for the agent: `npm run amazon:register`
async function main(): Promise<void> {
  const config = loadConfig();
  await registerAmazonAccount(config);
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[amazon:register] failed:", error);
  process.exit(1);
});
