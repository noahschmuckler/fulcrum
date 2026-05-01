#!/usr/bin/env node
// Bundle all /cases/*.yaml into public/cases.json (engine-consumable)
// and copy raw source files into public/ so the in-app Library can serve them.
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';

const CASES_DIR = 'cases';
const PACKETS_DIR = 'cases/dm-packets';
const SPEC_DIR = 'spec';
const PUBLIC = 'public';

// Engine-side bundle
const yamlFiles = (await readdir(CASES_DIR)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
const cases = {};
for (const f of yamlFiles) {
  const raw = await readFile(join(CASES_DIR, f), 'utf8');
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== 'object' || !doc.id) {
    console.warn(`Skipping ${f}: no id`);
    continue;
  }
  cases[doc.id] = doc;
}
await mkdir(PUBLIC, { recursive: true });
await writeFile(
  join(PUBLIC, 'cases.json'),
  JSON.stringify({ cases, builtAt: new Date().toISOString() }, null, 2),
);
console.log(`Built ${Object.keys(cases).length} cases → public/cases.json`);

// Library: copy raw source files into /public so they can be served + downloaded
async function copyAll(srcDir, dstDir, predicate) {
  await rm(dstDir, { recursive: true, force: true });
  await mkdir(dstDir, { recursive: true });
  const files = (await readdir(srcDir)).filter(predicate);
  for (const f of files) {
    await copyFile(join(srcDir, f), join(dstDir, f));
  }
  return files;
}

const yamlOut = await copyAll(CASES_DIR, join(PUBLIC, 'cases'), (f) => f.endsWith('.yaml') || f.endsWith('.yml'));
const packetsOut = await copyAll(PACKETS_DIR, join(PUBLIC, 'cases/dm-packets'), (f) => f.endsWith('.md'));
const specsOut = await copyAll(SPEC_DIR, join(PUBLIC, 'spec'), (f) => f.endsWith('.md'));

// Library manifest the SPA fetches
const library = {
  builtAt: new Date().toISOString(),
  cases: yamlOut.map((f) => ({
    file: f,
    path: `/cases/${f}`,
    title: cases[basename(f, '.yaml')]?.title ?? f,
    kind: cases[basename(f, '.yaml')]?.kind ?? 'unknown',
  })),
  dmPackets: packetsOut.map((f) => ({ file: f, path: `/cases/dm-packets/${f}` })),
  specs: specsOut.map((f) => ({ file: f, path: `/spec/${f}` })),
};
await writeFile(join(PUBLIC, 'library.json'), JSON.stringify(library, null, 2));
console.log(`Built library: ${yamlOut.length} cases, ${packetsOut.length} packets, ${specsOut.length} specs`);
