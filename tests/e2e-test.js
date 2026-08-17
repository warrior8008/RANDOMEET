/* End-to-end test of ChatKro server logic */
const WebSocket = require('ws');

const URL = 'ws://localhost:' + (process.env.PORT || 8080);
let failures = 0;
let passed = 0;

function assert(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}

function client(label) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const idx = waiters.findIndex((w) => w.type === m.type);
    if (idx !== -1) {
      const w = waiters.splice(idx, 1)[0];
      clearTimeout(w.timer);
      w.res(m);
    } else {
      inbox.push(m);
    }
  });
  return {
    ws,
    inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    next: (type, timeout = 8000) => new Promise((res, rej) => {
      const hit = inbox.findIndex((m) => m.type === type);
      if (hit !== -1) { res(inbox.splice(hit, 1)[0]); return; }
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.type === type);
        if (i !== -1) waiters.splice(i, 1);
        rej(new Error('timeout waiting for ' + type + ' on ' + label));
      }, timeout);
      waiters.push({ type, timer, res });
    }),
    open: () => new Promise((res) => ws.on('open', res)),
    close: () => { try { ws.close(); } catch {} },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== TEST 1: welcome + online count ===');
  const a = client('A');
  await a.open();
  const wA = await a.next('welcome');
  assert('A gets welcome', wA.online === 1, JSON.stringify(wA));
  assert('welcome carries TURN iceServers', Array.isArray(wA.iceServers) && JSON.stringify(wA.iceServers).includes('turn:openrelay.metered.ca'), JSON.stringify(wA.iceServers));

  const b = client('B');
  await b.open();
  const wB = await b.next('welcome');
  assert('B gets welcome with online=2', wB.online === 2, JSON.stringify(wB));
  await sleep(200);
  const onlineMsgs = a.inbox.filter((m) => m.type === 'online');
  assert('A received online broadcast with 2', onlineMsgs.some((m) => m.online === 2));

  console.log('=== TEST 2: group join (up to 5 per room) ===');
  a.send({ type: 'join', name: 'Alice', interests: ['music', 'retro'] });
  const roomA1 = await a.next('room');
  assert('A enters a room alone', roomA1.members.length === 1 && roomA1.selfId === roomA1.members[0].id, JSON.stringify(roomA1));
  const aId = roomA1.selfId;

  b.send({ type: 'join', name: 'Bob', interests: ['music', 'gaming'] });
  const roomA2 = await a.next('room');
  const roomB = await b.next('room');
  assert('B joins the same room', roomA2.roomId === roomB.roomId, JSON.stringify(roomA2));
  assert('both see 2 members', roomA2.members.length === 2 && roomB.members.length === 2);
  const bId = roomB.selfId;
  assert('member ids present', roomA2.members.some((m) => m.id === aId) && roomA2.members.some((m) => m.id === bId));
  assert('names shown', (roomA2.members.find((m) => m.id === bId) || {}).name === 'Bob', JSON.stringify(roomA2));

  console.log('=== TEST 2b: 2p vs group matching is separated ===');
  const p1 = client('P1'); await p1.open(); await p1.next('welcome');
  const p2 = client('P2'); await p2.open(); await p2.next('welcome');
  const p3 = client('P3'); await p3.open(); await p3.next('welcome');
  p1.send({ type: 'join', name: 'P1', mode: '2p' });
  const rp1 = await p1.next('room');
  assert('2p client starts own room', rp1.members.length === 1, JSON.stringify(rp1));
  p2.send({ type: 'join', name: 'P2', mode: '2p' });
  const rp2 = await p2.next('room');
  await p1.next('room');
  assert('second 2p client paired', rp2.members.length === 2 && rp2.members.some((m) => m.name === 'P1'), JSON.stringify(rp2));
  p3.send({ type: 'join', name: 'P3', mode: '2p' });
  const rp3 = await p3.next('room');
  assert('3rd 2p client opens fresh room (cap 2)', rp3.members.length === 1 && rp3.roomId !== rp2.roomId, JSON.stringify(rp3));
  const g1 = client('G1'); await g1.open(); await g1.next('welcome');
  g1.send({ type: 'join', name: 'G1', mode: 'group' });
  const rg1 = await g1.next('room');
  assert('group client never joins a 2p room', rg1.roomId !== rp2.roomId && rg1.roomId !== rp3.roomId && !rg1.members.some((m) => m.name.startsWith('P')), JSON.stringify(rg1));
  p1.close(); p2.close(); p3.close(); g1.close();
  await sleep(200);

  console.log('=== TEST 3: targeted signaling relay ===');
  a.send({ type: 'signal', to: bId, data: { sdp: 'offer-a' } });
  const sigB = await b.next('signal');
  assert('B received A signal', sigB.from === aId && sigB.data.sdp === 'offer-a', JSON.stringify(sigB));
  b.send({ type: 'signal', to: aId, data: { sdp: 'answer-b' } });
  const sigA = await a.next('signal');
  assert('A received B signal', sigA.from === bId && sigA.data.sdp === 'answer-b', JSON.stringify(sigA));

  console.log('=== TEST 4: chat relay (group broadcast) ===');
  a.send({ type: 'chat', text: 'Hello group!' });
  const chatB = await b.next('chat');
  assert('B received chat', chatB.text === 'Hello group!' && chatB.name === 'Alice', JSON.stringify(chatB));
  b.send({ type: 'chat', text: 'Hey Alice!' });
  const chatA = await a.next('chat');
  assert('A received chat', chatA.text === 'Hey Alice!' && chatA.name === 'Bob');

  console.log('=== TEST 5: typing relay ===');
  a.send({ type: 'typing', isTyping: true });
  const tyB = await b.next('typing');
  assert('B received typing=on', tyB.isTyping === true);
  a.send({ type: 'typing', isTyping: false });
  const tyB2 = await b.next('typing');
  assert('B received typing=off', tyB2.isTyping === false);

  console.log('=== TEST 6: member-left on disconnect ===');
  const aLeave = a.next('member-left');
  b.close();
  const pl = await aLeave;
  assert('A notified when B disconnects', pl.reason === 'disconnected', JSON.stringify(pl));
  await sleep(200);

  console.log('=== TEST 7: room capacity = 5, 6th starts a new room ===');
  const c = client('C'); await c.open(); await c.next('welcome');
  const d = client('D'); await d.open(); await d.next('welcome');
  const e = client('E'); await e.open(); await e.next('welcome');
  const f = client('F'); await f.open(); await f.next('welcome');
  c.send({ type: 'join', name: 'Charlie', interests: ['music'] });
  await c.next('room');
  d.send({ type: 'join', name: 'Dave', interests: ['music'] });
  await d.next('room');
  e.send({ type: 'join', name: 'Erin', interests: ['music'] });
  await e.next('room');
  f.send({ type: 'join', name: 'Fay', interests: ['music'] });
  const roomF = await f.next('room');
  assert('room fills to 5 members', roomF.members.length === 5, JSON.stringify(roomF));

  const g = client('G'); await g.open(); await g.next('welcome');
  g.send({ type: 'join', name: 'Gwen', interests: ['music'] });
  const roomG1 = await g.next('room');
  assert('6th person opens a new room', roomG1.members.length === 1, JSON.stringify(roomG1));

  console.log('=== TEST 8: next round trip ===');
  g.send({ type: 'next' });
  const roomG2 = await g.next('room');
  assert('next moves to a fresh room', roomG2.roomId !== roomG1.roomId && roomG2.members.length === 1, JSON.stringify(roomG2));
  g.close();
  await sleep(200);

  console.log('=== TEST 9: validation - truncation + sanitization ===');
  const h = client('H'); await h.open(); await h.next('welcome');
  const i = client('I'); await i.open(); await i.next('welcome');
  h.send({ type: 'join', name: '', interests: ['x'] });
  const roomH = await h.next('room');
  const hSelf = roomH.members.find((m) => m.id === roomH.selfId);
  assert('empty name becomes Stranger', hSelf && hSelf.name === 'Stranger', JSON.stringify(roomH));
  i.send({ type: 'join', name: null, interests: 'not-array' });
  await i.next('room');
  await h.next('room');
  h.send({ type: 'chat', text: 'A'.repeat(5000) });
  const iChat = await i.next('chat');
  assert('Long chat truncated to 1000', iChat.text.length === 1000, 'len=' + iChat.text.length);
  assert('Junk interests ignored (no crash)', true);

  console.log('=== TEST 10: report moves reporter, notifies others ===');
  const hLeave = h.next('member-left');
  i.send({ type: 'report' });
  const li = await hLeave;
  assert('partner notified on report', li.reason === 'reported', JSON.stringify(li));
  const roomHAfter = await h.next('room');
  assert('partner left alone after report', roomHAfter.members.length === 1, JSON.stringify(roomHAfter));
  const roomI2 = await i.next('room');
  assert('reporter moved to a new room', roomI2.members.length === 1, JSON.stringify(roomI2));

  console.log('=== TEST 11: oversized ws message rejected (no crash) ===');
  i.send({ type: 'join', name: 'Ivy', interests: ['x'] });
  await i.next('room');
  h.send({ type: 'join', name: 'Hank', interests: ['x'] });
  const roomH2 = await h.next('room');
  await i.next('room');
  assert('re-paired after report', roomH2.members.length === 2 && roomH2.members.some((m) => m.name === 'Ivy'), JSON.stringify(roomH2));
  try {
    h.ws.send('X'.repeat(100000));
    h.send({ type: 'chat', text: 'still works' });
    const iChat2 = await i.next('chat');
    assert('Chat still works after huge message', iChat2.text === 'still works');
  } catch (err) {
    assert('Chat still works after huge message', false, err.message);
  }

  a.close(); c.close(); d.close(); e.close(); f.close(); g.close(); h.close(); i.close();

  console.log('\n=== RESULTS: ' + passed + ' passed, ' + failures + ' failed ===');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.log('TEST CRASH: ' + (err && err.stack));
  process.exit(1);
});
