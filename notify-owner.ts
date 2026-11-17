#!/usr/bin/env bun
// See COORDINATOR.md for the ask, reconfirm and resolve commands.
import { loadConfig } from "./config";
import { textOwner, updateAsk } from "./notify";

const [verb, ...args] = process.argv.slice(2);
try {
  const cfg = loadConfig();
  if (verb === "ask") {
    const sent = await textOwner(cfg, args.filter(a => a !== "--dry-run"), cfg.notify.live && !args.includes("--dry-run"));
    console.log(`Ask ${sent.key}: ${sent.outcome}`);
    process.exitCode = sent.held ? 2 : sent.outcome.startsWith("failed") ? 1 : 0;
  } else if (verb === "--resolved" || verb === "--reconfirm") {
    if (args.length > (verb === "--resolved" ? 2 : 1)) throw Error("Give one ask ID and quote the answer when resolving.");
    updateAsk(cfg, verb === "--resolved" ? "resolved" : "reconfirm", args[0], args[1]);
    console.log(verb === "--resolved" ? "Resolution recorded." : "Ask reconfirmed.");
  } else throw Error("Use ask to open an ask, --resolved to record an answer, or --reconfirm to keep an ask open.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
