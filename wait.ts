#!/usr/bin/env bun
// The coordinator chat's wake. Blocks, using no tokens, until the watcher has news that has not been handed
// over yet, prints it once, and exits. Run it as a background command and start it again after it returns.
// News that arrived while the coordinator was busy is returned at once by the next run; nothing is replayed.
import { writeSync } from "node:fs";
import { loadConfig } from "./config";
import { takeNews } from "./notify";

const cfg = loadConfig();
if (cfg.notify.coordinator.channel !== "file") { console.error('wait.ts is for the "file" coordinator channel; this config uses another one.'); process.exit(1); }
for (;;) {
  if (takeNews(cfg, news => { writeSync(1, news); })) process.exit(0); // written out first, then marked as handed over
  await Bun.sleep(5000);
}
