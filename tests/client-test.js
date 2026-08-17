/* Client integration test: loads real index.html + app.js in jsdom, stubs WebRTC/WS, drives the full lobby->match->chat->next->stop flow. */
const { JSDOM } = require('jsdom');
const URL = 'http://localhost:' + (process.env.PORT || 8080) + '/';

let failures = 0;
let passed = 0;
function assert(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pageErrors = [];
  const sent = [];
  const peers = [];
  const sockets = [];

  class FakeWS {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeWS.OPEN;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      sockets.push(this);
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
    }
    send(str) { sent.push(JSON.parse(str)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  const dom = await JSDOM.fromURL(URL, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = FakeWS;
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      window.navigator.mediaDevices = {
        getUserMedia: async () => ({
          getAudioTracks: () => [{ enabled: true, stop() {} }],
          getVideoTracks: () => [{ enabled: true, stop() {} }],
          getTracks: () => [{ enabled: true, stop() {} }],
        }),
      };
      window.addEventListener('error', (e) => { pageErrors.push(e.message); });
    },
  });

  await new Promise((r) => setTimeout(r, 1500));
  const w = dom.window;
  const d = w.document;
  function emit(type, msg) {
    const ws = sockets[0];
    if (ws && ws.onmessage) ws.onmessage({ data: JSON.stringify(msg) });
    else throw new Error('no fake ws to emit ' + type);
  }

  console.log('=== CLIENT TEST 1: page boots, connects, no errors ===');
  assert('SimplePeer lib loaded from server', typeof w.SimplePeer === 'function');
  assert('connStatus says LINK ESTABLISHED', (d.getElementById('connStatus').textContent || '').includes('LINK ESTABLISHED'), d.getElementById('connStatus').textContent);
  assert('online LED updated', (d.getElementById('onlineLed').textContent || '').includes('ONLINE'));
  assert('no page errors at boot', pageErrors.length === 0, pageErrors.join('; '));

  console.log('=== CLIENT TEST 1b: server ICE config is adopted ===');
  emit('welcome', { type: 'welcome', id: 'x', online: 1, iceServers: [{ urls: ['stun:custom.example.com:3478'] }, { urls: ['turn:custom.example.com:80'], username: 'u', credential: 'p' }] });
  await sleep(50);

  console.log('=== CLIENT TEST 1c: mode selection screen ===');
  assert('mode screen visible at boot', !d.getElementById('modeScreen').classList.contains('hidden'));
  assert('lobby hidden until mode chosen', d.getElementById('lobby').classList.contains('hidden'));
  d.getElementById('modeGroupBtn').click();
  await sleep(20);
  assert('mode chosen -> lobby visible', !d.getElementById('lobby').classList.contains('hidden'));
  assert('mode label shows group', (d.getElementById('modeLabel').textContent || '').includes('GROUP'), d.getElementById('modeLabel').textContent);

  console.log('=== CLIENT TEST 2: start -> media -> join ===');
  w.SimplePeer = class StubPeer {
    constructor(opts) { this.opts = opts; this.handlers = {}; this.closed = false; peers.push(this); }
    on(evt, cb) { this.handlers[evt] = cb; }
    signal(data) { this.lastSignal = data; }
    destroy() { if (!this.closed) { this.closed = true; if (this.handlers.close) this.handlers.close(); } }
    emit(evt, payload) { if (this.handlers[evt]) this.handlers[evt](payload); }
  };

  d.getElementById('name').value = 'Alice';
  d.getElementById('interests').value = 'music, retro';
  d.getElementById('startBtn').click();
  await sleep(200);
  const joinMsg = sent.find((m) => m.type === 'join');
  assert('join sent with name+interests+mode', joinMsg && joinMsg.name === 'Alice' && joinMsg.interests.includes('music') && joinMsg.mode === 'group', JSON.stringify(joinMsg));
  assert('ready sent before join', sent.findIndex((m) => m.type === 'ready') !== -1 && sent.findIndex((m) => m.type === 'ready') < sent.findIndex((m) => m.type === 'join'));
  assert('lobby hidden, call shown', d.getElementById('lobby').classList.contains('hidden') && !d.getElementById('call').classList.contains('hidden'));

  console.log('=== CLIENT TEST 3: room joined -> peer created ===');
  emit('room', { type: 'room', roomId: 'r1', selfId: 'a1', members: [{ id: 'a1', name: 'Alice' }, { id: 'b1', name: 'Bob' }] });
  await sleep(50);
  assert('peerStatus shows connecting', (d.getElementById('peerStatus').textContent || '').includes('CONNECTING'), d.getElementById('peerStatus').textContent);
  assert('StubPeer created as initiator', peers.length === 1 && peers[0].opts.initiator === true, 'peers=' + peers.length);
  const labels = Array.from(d.querySelectorAll('#videoGrid .video-box .video-label')).map((n) => n.textContent);
  assert('remote label shows Bob', labels.includes('BOB'), labels.join(','));
  assert('peer uses server-provided ICE', peers[0].opts.config.iceServers.length === 2 && peers[0].opts.config.iceServers[0].urls[0] === 'stun:custom.example.com:3478', JSON.stringify(peers[0].opts.config));

  console.log('=== CLIENT TEST 4: signal relay in -> peer.signal called ===');
  emit('signal', { type: 'signal', from: 'b1', data: { sdp: 'x' } });
  await sleep(20);
  assert('peer.signal called with relayed data', peers[0].lastSignal && peers[0].lastSignal.sdp === 'x');

  console.log('=== CLIENT TEST 5: peer connect -> chat input enabled ===');
  peers[0].emit('connect');
  await sleep(20);
  assert('chat input enabled', d.getElementById('chatInput').disabled === false);
  assert('send enabled', d.getElementById('sendBtn').disabled === false);

  console.log('=== CLIENT TEST 6: send + receive chat ===');
  d.getElementById('chatInput').value = 'hello bob';
  d.getElementById('sendBtn').click();
  await sleep(20);
  assert('chat sent to server', sent.some((m) => m.type === 'chat' && m.text === 'hello bob'));
  emit('chat', { type: 'chat', text: 'hi alice', name: 'Bob' });
  await sleep(20);
  assert('incoming chat rendered', (d.getElementById('chatLog').textContent || '').includes('hi alice'));

  console.log('=== CLIENT TEST 7: typing indicator ===');
  emit('typing', { type: 'typing', isTyping: true });
  await sleep(20);
  assert('typing shown', !d.getElementById('typing').classList.contains('hidden'));
  emit('typing', { type: 'typing', isTyping: false });
  await sleep(20);
  assert('typing hidden', d.getElementById('typing').classList.contains('hidden'));

  console.log('=== CLIENT TEST 8: next button ===');
  const before = sent.length;
  d.getElementById('nextBtn').click();
  await sleep(50);
  assert('next sent', sent.length > before && sent[sent.length - 1].type === 'next');
  assert('peers destroyed on next', peers.every((p) => p.closed === true), 'peers=' + peers.length);

  console.log('=== CLIENT TEST 9: member-left -> peer removed, back to waiting ===');
  emit('room', { type: 'room', roomId: 'r2', selfId: 'a1', members: [{ id: 'a1', name: 'Alice' }] });
  await sleep(50);
  assert('remote boxes removed', d.querySelectorAll('#videoGrid .video-box').length === 1);
  assert('chat input disabled when alone', d.getElementById('chatInput').disabled === true);

  console.log('=== CLIENT TEST 10: stop returns to lobby ===');
  d.getElementById('stopBtn').click();
  await sleep(100);
  assert('leave sent', sent[sent.length - 1].type === 'leave');
  assert('lobby visible again', !d.getElementById('lobby').classList.contains('hidden'));
  d.getElementById('changeModeBtn').click();
  await sleep(20);
  assert('change mode returns to mode screen', !d.getElementById('modeScreen').classList.contains('hidden') && d.getElementById('lobby').classList.contains('hidden'));
  assert('no page errors after all flows', pageErrors.length === 0, pageErrors.join('; '));

  console.log('\n=== CLIENT RESULTS: ' + passed + ' passed, ' + failures + ' failed ===');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.log('CLIENT TEST CRASH: ' + (err && err.stack));
  process.exit(1);
});
