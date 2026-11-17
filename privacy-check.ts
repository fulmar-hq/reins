#!/usr/bin/env bun
// Plain-code check that nothing private is about to be published. Scans added lines and commit messages.
//   bun privacy-check.ts                 the staged changes
//   bun privacy-check.ts main..HEAD      every commit in a range (use this before a push)
// Extra private words (names, products, hosts) come from the file named by "privacyTermsFile" in your
// private config, one per line, so the list itself is never published. Exits 1 on a finding.
import { readFileSync } from "node:fs";
import { loadConfig } from "./config";

const PLACEHOLDER = /^(you|your-?name|name|user|username|me|example|runner)$/i;
const RULES: [string, RegExp, (match: string) => boolean][] = [
  ["home-folder path", /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g, m => !PLACEHOLDER.test(m.split("/")[2]!)],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, m => !/^git@|@example\.|noreply/.test(m)],
  ["12-digit account-like number", /(?<![\d.])\d{12}(?![\d.])/g, () => true],
  ["sign-in portal or internal address", /[A-Za-z0-9.-]*awsapps\.com|[A-Za-z0-9-]+\.(?:internal|corp|lan)\b|\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g, m => /[a-z]/i.test(m) || m.split(".").length === 4],
  ["token or key", /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{35}|\d{8,10}:[A-Za-z0-9_-]{35})\b|-----BEGIN [A-Z ]*PRIVATE KEY/g, () => true],
];
/** Findings in one line of text. The suspect text is masked: never echoed in full. */
export function findings(line: string, terms: string[] = []): { kind: string; masked: string }[] {
  const mask = (text: string) => `${text.slice(0, 3)}…(${text.length} characters)`, out: { kind: string; masked: string }[] = [];
  for (const [kind, pattern, real] of RULES) for (const match of line.matchAll(pattern)) if (real(match[0])) out.push({ kind, masked: mask(match[0]) });
  const lower = line.toLowerCase();
  for (const term of terms) if (lower.includes(term)) out.push({ kind: "private word from your list", masked: mask(term) });
  return out;
}

if (import.meta.main) {
  const range = process.argv[2];
  const git = (...args: string[]) => { // fail closed: a git error is never "nothing found"
    const run = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) { console.error(`Privacy check could not run: git ${args[0]} failed (${run.stderr.toString().trim().split("\n")[0]}). Nothing was checked.`); process.exit(2); }
    return run.stdout.toString();
  };
  let terms: string[] = [], found = 0;
  const file = loadConfig().privacyTermsFile; // a broken config stops the check rather than silently dropping your word list
  if (file) terms = readFileSync(file, "utf8").split("\n").map(t => t.trim().toLowerCase()).filter(Boolean);
  const report = (where: string, text: string) => { for (const f of findings(text, terms)) { found++; console.log(`${where}  ${f.kind}: ${f.masked}`); } };
  /** Every added line of one patch, plus (for a commit) the message that precedes it. */
  const scan = (text: string, label: string) => {
    let path = "", line = 0, inPatch = false;
    for (const row of text.split("\n")) {
      if (row.startsWith("diff --git ")) inPatch = true;
      else if (!inPatch) report(`${label} message`, row);
      else if (row.startsWith("+++ ")) path = row.slice(6);
      else if (row.startsWith("@@")) line = Number(row.match(/\+(\d+)/)?.[1] ?? 0);
      else if (row.startsWith("+")) report(`${label}${path}:${line++}`, row.slice(1));
    }
  };
  let scanned = "staged changes";
  if (range) {
    // Patch by patch, so something added in one commit and removed in a later one is still caught: history is published too.
    const commits = git("rev-list", "--reverse", range, "--").split("\n").filter(Boolean);
    for (const sha of commits) scan(git("show", "-m", "--unified=0", "--no-color", "--format=%B", sha, "--"), `${sha.slice(0, 8)} `);
    scanned = `${commits.length} commit${commits.length === 1 ? "" : "s"} in ${range}`;
  } else scan("diff --git \n" + git("diff", "--cached", "--unified=0", "--no-color"), "");
  console.log(found ? `${found} possible private item${found > 1 ? "s" : ""}. Remove them (or move them to your private config) before publishing.` : `Privacy check passed (${scanned}; ${terms.length} private words from your list).`);
  process.exit(found ? 1 : 0);
}
