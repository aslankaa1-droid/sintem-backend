#!/usr/bin/env node
// Seed KV PROMPTS namespace with the 5 wedge-agent system prompts.
// Sources expected in: ../../sprint/week3_agents/01..05_*.md (when sprint/week3_agents
// is finalized and merged into the repo).
//
// Usage:
//   node scripts/seed-prompts.mjs            # uses --remote
//   node scripts/seed-prompts.mjs --local    # uses --local

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../prompts');
const LOCAL = process.argv.includes('--local');
const FLAG = LOCAL ? '--local' : '--remote';

const AGENT_FILES = {
  mp_card_doctor: 'mp_card_doctor.md',
  mp_review_responder: 'mp_review_responder.md',
  mp_competitor_scout: 'mp_competitor_scout.md',
  mp_abc_xyz_analyst: 'mp_abc_xyz_analyst.md',
  mp_unit_economics: 'mp_unit_economics.md',
};

function readAgentPrompt(filename) {
  // Files live in ./prompts/ (extracted from sprint/week3_agents/ via the parent commit).
  const local = join(PROMPTS_DIR, filename);
  try {
    return readFileSync(local, 'utf-8');
  } catch {
    console.warn(`⚠ prompt not found: ${filename} — using placeholder`);
    return `# Placeholder for ${filename}\n\nReplace with the real system prompt before going live.`;
  }
}

console.log(`Seeding KV PROMPTS (${LOCAL ? 'local' : 'remote'})...`);
for (const [agentId, filename] of Object.entries(AGENT_FILES)) {
  const text = readAgentPrompt(filename);
  const key = `prompt:${agentId}`;
  try {
    // Use stdin to avoid shell-escaping issues.
    execSync(`wrangler kv:key put --binding=PROMPTS ${FLAG} ${JSON.stringify(key)}`, {
      input: text,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log(`  ✓ ${key}`);
  } catch (e) {
    console.error(`  ✗ ${key}: ${e.message}`);
  }
}

console.log('\nVerify:');
console.log(`  wrangler kv:key list --binding=PROMPTS ${FLAG}`);
