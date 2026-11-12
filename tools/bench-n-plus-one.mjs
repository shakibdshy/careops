// N+1 receipt (W2-T9): the shipped provider-utilization $lookup pipeline vs a
// naive per-Provider name resolution, measured for wall-ms AND query count.
//
//   bun tools/load-dataset.mjs        # once, against the receipts db
//   bun tools/bench-n-plus-one.mjs
//
// Runs against the THROWAWAY receipts db only, and bypasses the Redis report
// cache on purpose: this isolates the two QUERY STRATEGIES, not the cache (the
// k6 scenario measures the cached HTTP endpoint). Both paths return the same
// rows — the bench asserts that, so the comparison is like-for-like.
//
//   shipped: ONE aggregate — $match -> $group -> $lookup(member) -> $lookup(user)
//            -> $project -> $sort. The joins run server-side, index-served on _id.
//   naive:   ONE $group aggregate, then per Provider a findOne(member) +
//            findOne(user) — 1 + 2N round trips, the N+1 the $lookups remove.
//
// Query counts come from the driver's command monitoring (aggregate/find), so
// they are observed, not asserted from the code shape.

import { writeFileSync, mkdirSync } from 'node:fs';
import { MongoClient, ObjectId } from './lib/mongo.mjs';

const MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0';
const RUNS = Number(process.env.RECEIPTS_BENCH_RUNS ?? 7);
const DAYS = Number(process.env.RECEIPTS_BENCH_DAYS ?? 30); // the dashboard's REPORT_DAYS
const MS_PER_DAY = 86_400_000;
const SLOT_HOLDING = { $nin: ['CANCELLED', 'NO_SHOW'] };

function utcDayWindow(days, now) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(midnight - (days - 1) * MS_PER_DAY),
    end: new Date(midnight + MS_PER_DAY),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const round2 = (n) => Math.round(n * 100) / 100;

// Count only logical query commands; heartbeats (hello/ping) and getMore
// continuations are excluded. At ~43 providers no cursor needs a getMore, and
// the observed counts matching 1 vs 1+2N confirms that.
function commandCounter(client) {
  const state = { count: 0 };
  client.on('commandStarted', (event) => {
    if (event.commandName === 'aggregate' || event.commandName === 'find') state.count += 1;
  });
  return {
    reset: () => (state.count = 0),
    get count() {
      return state.count;
    },
  };
}

// The exact pipeline from apps/api/src/reports/reports.repository.ts.
function utilizationPipeline(org, start, end) {
  return [
    { $match: { organizationId: org, status: SLOT_HOLDING, start: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: '$memberId',
        bookedMinutes: { $sum: '$durationMinutes' },
        appointmentCount: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'member',
        let: { mid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', { $toObjectId: '$$mid' }] } } },
          { $project: { _id: 0, userId: 1 } },
        ],
        as: 'memberDoc',
      },
    },
    { $unwind: '$memberDoc' },
    {
      $lookup: {
        from: 'user',
        let: { uid: '$memberDoc.userId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$uid'] } } },
          { $project: { _id: 0, name: 1 } },
        ],
        as: 'userDoc',
      },
    },
    { $unwind: '$userDoc' },
    {
      $project: {
        _id: 0,
        memberId: '$_id',
        providerName: '$userDoc.name',
        bookedMinutes: 1,
        appointmentCount: 1,
      },
    },
    { $sort: { bookedMinutes: -1 } },
  ];
}

async function runShipped(db, org, start, end) {
  return db
    .collection('appointment')
    .aggregate(utilizationPipeline(org, start, end))
    .toArray();
}

async function runNaive(db, org, start, end) {
  // The unavoidable sum: group appointments by Provider.
  const groups = await db
    .collection('appointment')
    .aggregate([
      { $match: { organizationId: org, status: SLOT_HOLDING, start: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: '$memberId',
          bookedMinutes: { $sum: '$durationMinutes' },
          appointmentCount: { $sum: 1 },
        },
      },
    ])
    .toArray();
  // The N+1: resolve each Provider's display name with two extra round trips.
  const rows = [];
  for (const group of groups) {
    const member = await db
      .collection('member')
      .findOne({ _id: new ObjectId(group._id) }, { projection: { userId: 1 } });
    const user = member
      ? await db.collection('user').findOne({ _id: member.userId }, { projection: { name: 1 } })
      : null;
    rows.push({
      memberId: group._id,
      providerName: user?.name ?? null,
      bookedMinutes: group.bookedMinutes,
      appointmentCount: group.appointmentCount,
    });
  }
  rows.sort((a, b) => b.bookedMinutes - a.bookedMinutes);
  return rows;
}

async function measure(fn, counter) {
  await fn(); // warm-up: connection + planner cache, not recorded
  const samples = [];
  let queryCount = null;
  let result = null;
  for (let i = 0; i < RUNS; i += 1) {
    counter.reset();
    const t0 = performance.now();
    result = await fn();
    samples.push(performance.now() - t0);
    queryCount = counter.count;
  }
  return { wallMsMedian: round2(median(samples)), runs: samples.map(round2), queryCount, result };
}

// Same providers, same booked minutes, same names — proves like-for-like work.
function resultsMatch(shipped, naive) {
  const key = (rows) =>
    [...rows]
      .sort((a, b) => (a.memberId < b.memberId ? -1 : 1))
      .map((r) => `${r.memberId}:${r.providerName}:${r.bookedMinutes}:${r.appointmentCount}`)
      .join('|');
  return key(shipped) === key(naive);
}

async function main() {
  // monitorCommands defaults to false in driver 7.x; opt in so the query-count
  // receipt is observed from commandStarted events, not asserted from code.
  const client = new MongoClient(MONGODB_URI, { monitorCommands: true });
  await client.connect();
  const db = client.db();
  const counter = commandCounter(client);

  // Demo org from the patient collection (stable; appointment.findOne({}) could
  // land on the synthetic noise tenant load-dataset adds for the list receipt).
  const org = (await db.collection('patient').findOne({}, { projection: { organizationId: 1 } }))
    .organizationId;
  const { start, end } = utcDayWindow(DAYS, new Date());

  const shipped = await measure(() => runShipped(db, org, start, end), counter);
  const naive = await measure(() => runNaive(db, org, start, end), counter);
  const providers = shipped.result.length;
  const match = resultsMatch(shipped.result, naive.result);
  if (!match) throw new Error('Shipped and naive results differ — bench is not like-for-like.');

  const receipt = {
    generatedAt: new Date().toISOString(),
    database: db.databaseName,
    organizationId: org,
    window: { days: DAYS, start: start.toISOString(), end: end.toISOString() },
    providers,
    runsPerPath: RUNS,
    cacheBypassed: true,
    resultsMatch: match,
    shipped: {
      strategy: 'one aggregate with two server-side $lookups',
      queryCount: shipped.queryCount,
      wallMsMedian: shipped.wallMsMedian,
      runs: shipped.runs,
    },
    naive: {
      strategy: 'one $group aggregate + findOne(member) + findOne(user) per Provider',
      queryCount: naive.queryCount,
      queryCountFormula: `1 + 2 * ${providers} = ${1 + 2 * providers}`,
      wallMsMedian: naive.wallMsMedian,
      runs: naive.runs,
    },
    queryReduction: round2(naive.queryCount / shipped.queryCount),
    speedup: round2(naive.wallMsMedian / shipped.wallMsMedian),
  };

  mkdirSync(new URL('./receipts/', import.meta.url), { recursive: true });
  const outPath = new URL('./receipts/n-plus-one.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');

  console.log('N+1 receipt (provider utilization, %d-day window, %d Providers):', DAYS, providers);
  console.log('  results identical :', match);
  console.log(
    '  shipped ($lookup) : %d query,  median %s ms  %j',
    shipped.queryCount,
    shipped.wallMsMedian,
    shipped.runs,
  );
  console.log(
    '  naive (per-row)   : %d queries, median %s ms  %j',
    naive.queryCount,
    naive.wallMsMedian,
    naive.runs,
  );
  console.log(
    '  reduction         : %sx fewer queries, %sx faster (median wall)',
    receipt.queryReduction,
    receipt.speedup,
  );
  console.log('Wrote', outPath.pathname);

  await client.close();
}

main()
  .catch((error) => {
    console.error('bench-n-plus-one failed:', error.message);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
