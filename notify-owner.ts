#!/usr/bin/env bun
// The coordinator's deliberate text to the owner: only for a decision or a blocker it cannot resolve itself.
//   bun notify-owner.ts "One or two plain sentences ending in what is needed."
//   bun notify-owner.ts --resolved      the owner has answered; clear the asks from "Needs you"
import { loadConfig } from "./config";
import { appendLine, files } from "./lib";
import { textOwner } from "./notify";

const cfg = loadConfig(), text = process.argv.slice(2).filter(a => a !== "--dry-run").join(" ").trim();
if (!text) { console.error('usage: notify-owner.ts "<what you need from the owner>" | --resolved'); process.exit(1); }
if (text === "--resolved") {
  appendLine(files(cfg).events, { key: `owner-resolved:${Date.now()}`, at: new Date().toISOString(), type: "owner-resolved", text: "the owner's answer was received", quiet: true });
  console.log("Cleared.");
} else {
  try {
    const sent = await textOwner(cfg, text, "owner-ask", cfg.notify.live && !process.argv.includes("--dry-run"));
    console.log(sent.outcome);
    process.exit(sent.held ? 2 : 0);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
