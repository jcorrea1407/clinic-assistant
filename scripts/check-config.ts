import { loadAllClients } from "../src/config/load.js";

// Runs in `npm run build`, so a bad config or fact sheet fails the Vercel deploy.

try {
  const clients = await loadAllClients();
  for (const { config, facts } of clients) {
    const lines = Object.values(facts.collections).reduce((n, c) => n + c.length, 0);
    console.log(`✓ ${config.id}: ${lines} fact-sheet lines, model ${config.model.id} (${config.model.effort} effort)`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
