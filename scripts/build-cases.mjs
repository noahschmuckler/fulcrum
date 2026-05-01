#!/usr/bin/env node
// Bundle all /cases/*.yaml into public/cases.json so the static SPA can fetch them.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

const CASES_DIR = 'cases';
const OUT_FILE = 'public/cases.json';

const files = (await readdir(CASES_DIR)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
const cases = {};
for (const f of files) {
  const raw = await readFile(join(CASES_DIR, f), 'utf8');
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== 'object' || !doc.id) {
    console.warn(`Skipping ${f}: no id`);
    continue;
  }
  cases[doc.id] = doc;
}

await mkdir('public', { recursive: true });
await writeFile(OUT_FILE, JSON.stringify({ cases, builtAt: new Date().toISOString() }, null, 2));
console.log(`Built ${Object.keys(cases).length} cases → ${OUT_FILE}`);
