// Index receipt (W2-T9): explain("executionStats") for the two appointment
// query shapes, BEFORE the serving index exists and AFTER it is restored.
//
//   bun tools/load-dataset.mjs        # once, against the receipts db
//   bun tools/explain-index.mjs
//
// Runs against the THROWAWAY receipts db only. The "before" plan is captured by
// dropping indexes locally and restoring them immediately — nothing broken
// ships, and the demo `careops` db is never touched.
//
//   overlap (Conflict check): {organizationId, memberId, status:$nin,
//            start:$lt, end:$gt}  — served by {organizationId, memberId, start}
//   list (cursor page):       {organizationId} sort {_id:-1} limit 21
//            — served by {organizationId, _id}
//
// The overlap baseline drops every compound index, so the planner falls back to
// a true COLLSCAN. The list baseline drops only the cursor index: the _id index
// always exists, so the planner walks _id newest-first across the noise tenant
// instead of seeking this org's page — an O(collection) walk vs an O(page) seek.

import { writeFileSync, mkdirSync } from 'node:fs';
import { MongoClient } from './lib/mongo.mjs';

const MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0';
const RUNS = Number(process.env.RECEIPTS_EXPLAIN_RUNS ?? 7);
const PAGE = 21; // limit + 1, exactly as OrgScopedRepository.findPage fetches

// Named exactly as tools/load-dataset.mjs creates them (and as the API schema
// declares them), so drop/restore by name is stable across runs.
const INDEX_SPECS = [
  { key: { organizationId: 1, memberId: 1, start: 1 }, name: 'org_member_start' },
  { key: { organizationId: 1, _id: 1 }, name: 'org_id_cursor' },
  { key: { organizationId: 1, start: 1 }, name: 'org_start' },
  { key: { organizationId: 1, status: 1, start: 1 }, name: 'org_status_start' },
];
const ALL_COMPOUND = INDEX_SPECS.map((i) => i.name);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Walk the classic stage tree (inputStage / inputStages) into a readable chain
// and pull out the index name + whether a collection scan happened.
function describePlan(plan) {
  const stages = [];
  let indexName = null;
  let collscan = false;
  const root = plan?.queryPlan ?? plan;
  (function walk(node) {
    if (!node) return;
    stages.push(node.stage);
    if (node.stage === 'COLLSCAN') collscan = true;
    if (node.stage === 'IXSCAN' && node.indexName) indexName = node.indexName;
    if (node.inputStage) walk(node.inputStage);
    if (Array.isArray(node.inputStages)) node.inputStages.forEach(walk);
  })(root);
  return { stages: stages.join(' -> '), indexName, collscan };
}

async function capture(collection, buildCursor) {
  const samples = [];
  let stats = null;
  let plan = null;
  for (let i = 0; i < RUNS; i += 1) {
    const explained = await buildCursor(collection).explain('executionStats');
    const s = explained.executionStats;
    samples.push(s.executionTimeMillis);
    stats = {
      nReturned: s.nReturned,
      totalDocsExamined: s.totalDocsExamined,
      totalKeysExamined: s.totalKeysExamined,
    };
    plan = describePlan(explained.queryPlanner.winningPlan);
  }
  return { ...stats, executionTimeMillisMedian: median(samples), runs: samples, ...plan };
}

async function dropNamed(collection, names) {
  for (const name of names) {
    await collection.dropIndex(name);
  }
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();
  const collection = db.collection('appointment');

  // Demo org from the patient collection (stable across runs; the appointment
  // collection also holds the synthetic noise tenant used for the list receipt).
  const org = (await db.collection('patient').findOne({}, { projection: { organizationId: 1 } }))
    .organizationId;
  const sample = await collection.findOne({
    organizationId: org,
    status: { $nin: ['CANCELLED', 'NO_SHOW'] },
  });
  if (!sample) throw new Error('No appointment found — run tools/load-dataset.mjs first.');

  const overlapFilter = {
    organizationId: org,
    memberId: sample.memberId,
    status: { $nin: ['CANCELLED', 'NO_SHOW'] },
    start: { $lt: sample.end },
    end: { $gt: sample.start },
  };
  const buildOverlap = (c) => c.find(overlapFilter);
  const buildList = (c) => c.find({ organizationId: org }).sort({ _id: -1 }).limit(PAGE);

  // --- overlap: AFTER (all indexes) then BEFORE (no compound index -> COLLSCAN)
  const overlapAfter = await capture(collection, buildOverlap);
  await dropNamed(collection, ALL_COMPOUND);
  const overlapBefore = await capture(collection, buildOverlap);
  await collection.createIndexes(INDEX_SPECS);

  // --- list: AFTER (cursor index) then BEFORE (cursor index dropped -> _id walk)
  const listAfter = await capture(collection, buildList);
  await collection.dropIndex('org_id_cursor');
  const listBefore = await capture(collection, buildList);
  await collection.createIndex({ organizationId: 1, _id: 1 }, { name: 'org_id_cursor' });

  const receipt = {
    generatedAt: new Date().toISOString(),
    database: db.databaseName,
    organizationId: org,
    collectionCounts: {
      demoOrg: await collection.countDocuments({ organizationId: org }),
      total: await collection.countDocuments({}),
    },
    runsPerPlan: RUNS,
    overlap: { filter: overlapFilter, before: overlapBefore, after: overlapAfter },
    list: { before: listBefore, after: listAfter },
  };

  mkdirSync(new URL('./receipts/', import.meta.url), { recursive: true });
  const outPath = new URL('./receipts/index-explain.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');

  const row = (label, p) =>
    `  ${label.padEnd(7)} ${p.stages.padEnd(26)} index=${String(p.indexName).padEnd(16)} ` +
    `docsExamined=${String(p.totalDocsExamined).padStart(6)} keysExamined=${String(p.totalKeysExamined).padStart(6)} ` +
    `nReturned=${String(p.nReturned).padStart(3)} medianMs=${p.executionTimeMillisMedian}`;
  console.log('Index receipt (explain executionStats, median of %d runs):', RUNS);
  console.log('overlap (Conflict check):');
  console.log(row('before', overlapBefore));
  console.log(row('after', overlapAfter));
  console.log('list (cursor page, newest first):');
  console.log(row('before', listBefore));
  console.log(row('after', listAfter));
  console.log('Wrote', outPath.pathname);

  await client.close();
}

main()
  .catch((error) => {
    console.error('explain-index failed:', error.message);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
