/* Same-machine (BroadcastChannel) path — exercises the REAL ChannelTransport
   from modulus-online.html using Node's global BroadcastChannel.
   Run:  node test-local.js  */
const fs = require('fs');
const M = require('./core.js');
const html = fs.readFileSync(require('path').join(__dirname, 'modulus-online.html'), 'utf8');
const startTag = '<script>'; const idx = html.lastIndexOf(startTag);
const js = html.slice(idx + startTag.length, html.indexOf('</script>', idx));
const src = js.slice(js.indexOf('function ChannelTransport'), js.indexOf('/* ---------------- client wiring'));
const ChannelTransport = new Function(src + '; return ChannelTransport;')();

const scripted = (seed) => { let s = seed >>> 0; return (r, st) => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s % st.cfg.N; }; };
const room = 'LOCALTEST'; const results = {}; let ended = 0; let pass = true;
const log = (ok, l, x) => { pass = pass && ok; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '  — ' + x : ''}`); };

function mk(seed, tag) {
  return new M.ProtocolClient(ChannelTransport(room, 11), {
    getMove: scripted(seed),
    onEnd: async (result, transcript, role) => { results[tag] = { role, result, audit: await M.audit(11, transcript), transcript }; if (++ended === 2) finish(); }
  });
}
function finish() {
  const A = results.p1, B = results.p2;
  console.log('\n=== MODULUS same-machine (BroadcastChannel) test ===\n');
  log(A && B, 'both peers finished');
  log(A.result.winner === B.result.winner, 'both peers agree on winner', A.result.winner);
  log(A.role !== B.role, 'peers assigned distinct roles', `${A.role} vs ${B.role}`);
  const id = JSON.stringify(A.transcript.map(x => [x.mA, x.mB, x.Ahp, x.Bhp])) === JSON.stringify(B.transcript.map(x => [x.mA, x.mB, x.Ahp, x.Bhp]));
  log(id, 'transcripts byte-identical (deterministic)');
  log(A.audit.ok && B.audit.ok, 'both independent audits verify');
  console.log(`\n=== ${pass ? 'ALL LOCAL TESTS PASSED' : 'SOME FAILED'} ===\n`);
  process.exit(pass ? 0 : 1);
}
mk(0xA11CE, 'p1'); setTimeout(() => mk(0xB0B, 'p2'), 60);
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
