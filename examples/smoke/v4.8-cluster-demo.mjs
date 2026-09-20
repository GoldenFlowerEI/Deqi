// v4.8 cluster demo: capability-based RPC dispatch
//
// 1. Read /v1/cluster from the laptop (port 7701) to find a desktop
//    that has the 'deqi-plugin-browser-v2' capability.
// 2. POST a prompt to that desktop's /v1/rpc/run-task.
// 3. Show the response (text + durationMs + session_id).

const LAPTOP = 'http://127.0.0.1:7701';
const TARGET_CAPABILITY = 'deqi-plugin-browser-v2';

async function main() {
  console.log(`==== v4.8 cluster RPC demo ====\n`);

  // 1. Read the cluster
  const clusterRes = await fetch(`${LAPTOP}/v1/cluster`);
  const cluster = await clusterRes.json();
  console.log(`[1] Cluster on laptop: ${cluster.desktops.length} desktop(s) live`);
  for (const d of cluster.desktops) {
    const has = d.capabilities.includes(TARGET_CAPABILITY) ? '✓' : ' ';
    console.log(`    ${has} ${d.name} (port ${d.port}, id ${d.desktop_id}) — ${d.capabilities.length} caps`);
  }

  // 2. Pick by capability
  const target = cluster.desktops.find((d) => d.capabilities.includes(TARGET_CAPABILITY));
  if (!target) {
    console.log(`\nNo desktop has ${TARGET_CAPABILITY}; aborting.`);
    process.exit(1);
  }
  console.log(`\n[2] Picked target by capability: ${target.name} on port ${target.port}`);

  // 3. Dispatch the RPC
  const prompt = 'In one short sentence, what is the deqi-server doing right now?';
  console.log(`\n[3] POST ${target.host}:${target.port}/v1/rpc/run-task`);
  console.log(`    prompt: "${prompt}"`);
  const t0 = Date.now();
  const rpcRes = await fetch(`http://${target.host}:${target.port}/v1/rpc/run-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: 'demo_capability_routing', prompt }),
  });
  const body = await rpcRes.json();
  const elapsed = Date.now() - t0;

  console.log(`\n[4] Response (round-trip ${elapsed}ms, server reports ${body.durationMs}ms):`);
  console.log(`    ok:           ${body.ok}`);
  console.log(`    session_id:   ${body.session_id}`);
  console.log(`    text:         ${body.text}`);
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
