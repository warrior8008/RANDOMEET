/* CHATKRO client */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    modeScreen: $('modeScreen'),
    mode2pBtn: $('mode2pBtn'),
    modeGroupBtn: $('modeGroupBtn'),
    modeLabel: $('modeLabel'),
    changeModeBtn: $('changeModeBtn'),
    modeChip: $('modeChip'),
    lobby: $('lobby'),
    call: $('call'),
    name: $('name'),
    interests: $('interests'),
    enableVideo: $('enableVideo'),
    startBtn: $('startBtn'),
    lobbyMsg: $('lobbyMsg'),
    callMsg: $('callMsg'),
    videoGrid: $('videoGrid'),
    localVideo: $('localVideo'),
    localPlaceholder: $('localPlaceholder'),
    peerStatus: $('peerStatus'),
    typing: $('typing'),
    chatLog: $('chatLog'),
    chatInput: $('chatInput'),
    sendBtn: $('sendBtn'),
    micBtn: $('micBtn'),
    camBtn: $('camBtn'),
    switchCamBtn: $('switchCamBtn'),
    nextBtn: $('nextBtn'),
    reportBtn: $('reportBtn'),
    stopBtn: $('stopBtn'),
    connStatus: $('connStatus'),
    onlineLed: $('onlineLed'),
    ticker: $('ticker'),
    themeBtn: $('themeBtn'),
    overlay: $('overlay'),
    overlayTitle: $('overlayTitle'),
    overlayText: $('overlayText'),
    overlayOk: $('overlayOk'),
  };

  const DEFAULT_ICE = [
    { urls: ['stun:openrelay.metered.ca:80', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:cloudflare.com:3478'] },
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  let ws = null;
  let chatMode = null;        // '2p' | 'group'
  let localStream = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let manualClose = false;
  let selfId = null;
  let roomId = null;
  const peers = {};          // memberId -> SimplePeer
  const peerBoxes = {};      // memberId -> { box, video, ph, label }
  let connectedPeers = 0;

  const state = {
    name: '',
    interests: [],
    mode: 'offline',   // offline | idle | searching | connecting | chatting
    hasMedia: false,
    micOn: true,
    camOn: true,
    facingMode: 'user',   // user (front) | environment (rear)
    iceServers: null,
    autoRejoin: false,
    typingTimer: null,
  };

  /* ---------------- WebSocket ---------------- */

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host;
  }

  function connect() {
    manualClose = false;
    setConn('CONNECTING…');
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      reconnectAttempts = 0;
      setConn('LINK ESTABLISHED');
      if (state.autoRejoin) rejoinSession();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServer(msg);
    };

    ws.onclose = () => {
      setConn('LINK LOST');
      destroyAllPeers();
      if (state.mode === 'idle' || state.mode === 'offline') return;
      if (manualClose) return;
      scheduleReconnect();
    };

    ws.onerror = () => { ws.close(); };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts++), 8000);
    setStatusBar('LINK LOST - RETRYING IN ' + (delay / 1000) + 'S...', true);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (state.mode !== 'offline' && state.mode !== 'idle') state.autoRejoin = true;
      connect();
    }, delay);
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /* ---------------- Server messages ---------------- */

  function handleServer(msg) {
    switch (msg.type) {
      case 'welcome':
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) state.iceServers = msg.iceServers;
        updateOnline(msg.online);
        break;
      case 'online':
        updateOnline(msg.online);
        break;
      case 'status':
        break;
      case 'room':
        onRoom(msg);
        break;
      case 'signal':
        routeSignal(msg);
        break;
      case 'chat':
        appendChat(msg.name || 'Stranger', msg.text, false);
        break;
      case 'typing':
        showTyping(msg.isTyping);
        break;
      case 'member-left':
        break;
      case 'error':
        showOverlay('SYSTEM ERROR', msg.message || 'Unknown server error.');
        break;
      default:
        break;
    }
  }

  /* ---------------- Group rooms & peers ---------------- */

  function iceConfig() {
    return (state.iceServers && state.iceServers.length) ? state.iceServers : DEFAULT_ICE;
  }

  function addPeerBox(member) {
    const box = document.createElement('div');
    box.className = 'video-box';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = 'CONNECTING TO ' + (member.name || 'STRANGER').toUpperCase() + '...';
    const label = document.createElement('span');
    label.className = 'video-label';
    label.textContent = (member.name || 'STRANGER').toUpperCase();
    box.appendChild(video);
    box.appendChild(ph);
    box.appendChild(label);
    els.videoGrid.appendChild(box);
    return { box, video, ph, label };
  }

  function removePeerBox(id) {
    const ref = peerBoxes[id];
    if (ref) {
      ref.box.remove();
      delete peerBoxes[id];
    }
  }

  function createPeer(member) {
    const ref = addPeerBox(member);
    peerBoxes[member.id] = ref;
    let p;
    try {
      p = new SimplePeer({
        initiator: selfId < member.id,
        trickle: true,
        stream: outgoingStream() || undefined,
        config: { iceServers: iceConfig() },
      });
    } catch (e) {
      removePeerBox(member.id);
      setStatusBar('COULD NOT CONNECT TO ' + (member.name || 'STRANGER').toUpperCase() + ': ' + e.message, true);
      return;
    }
    peers[member.id] = p;

    p.on('signal', (data) => {
      wsSend({ type: 'signal', to: member.id, data });
    });

    p.on('connect', () => {
      ref.ph.textContent = '';
      connectedPeers++;
      updatePeerStatus();
      updateChatInput();
      capPeerBitrate(p);
    });

    p.on('stream', (stream) => {
      ref.video.srcObject = stream;
      ref.video.play().catch(() => {});
      ref.ph.classList.add('hidden');
    });

    p.on('error', (err) => {
      setStatusBar('P2P ERROR WITH ' + (member.name || 'STRANGER').toUpperCase() + ': ' + (err.message || err.code || 'unknown'), true);
    });

    p.on('close', () => {
      if (!peers[member.id]) return;
      delete peers[member.id];
      if (connectedPeers > 0) connectedPeers--;
      removePeerBox(member.id);
      updatePeerStatus();
      updateChatInput();
    });
  }

  function destroyPeer(id) {
    const p = peers[id];
    if (!p) return;
    delete peers[id];
    if (connectedPeers > 0) connectedPeers--;
    try { p.destroy(); } catch (e) {}
    removePeerBox(id);
  }

  function capPeerBitrate(peer) {
    try {
      const pc = peer._pc;
      if (!pc || typeof pc.getSenders !== 'function') return;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (!sender || typeof sender.setParameters !== 'function') return;
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      for (const enc of params.encodings) {
        enc.maxBitrate = 600000;
        enc.maxFramerate = 24;
      }
      sender.setParameters(params).catch(() => {});
    } catch (e) {}
  }

  function destroyAllPeers() {
    for (const id of Object.keys(peers)) destroyPeer(id);
    connectedPeers = 0;
  }

  function routeSignal(msg) {
    const p = peers[msg.from];
    if (p) {
      try { p.signal(msg.data); } catch (e) { setStatusBar('INVALID SIGNALING DATA.', true); }
    }
  }

  function onRoom(msg) {
    selfId = msg.selfId;
    roomId = msg.roomId;
    const members = Array.isArray(msg.members) ? msg.members : [];
    const known = new Set(members.map((m) => m.id));

    for (const id of Object.keys(peers)) {
      if (!known.has(id)) destroyPeer(id);
    }
    for (const m of members) {
      if (m.id === selfId) continue;
      if (peers[m.id]) {
        const ref = peerBoxes[m.id];
        if (ref) ref.label.textContent = (m.name || 'STRANGER').toUpperCase();
      } else {
        createPeer(m);
      }
    }

    const others = members.length - 1;
    setMode(others > 0 ? 'chatting' : 'searching');
    updateModeChip(members.length);
    updatePeerStatus();
    updateChatInput();
  }

  function updateModeChip(count) {
    if (chatMode === '2p') {
      els.modeChip.textContent = '2P CALL';
      els.modeChip.className = 'mode-chip call-chip chip-2p';
    } else {
      els.modeChip.textContent = 'GROUP ' + (count || 0) + '/5';
      els.modeChip.className = 'mode-chip call-chip chip-group';
    }
  }

  function updatePeerStatus() {
    const aloneText = chatMode === '2p'
      ? 'WAITING FOR A STRANGER TO JOIN YOUR CALL...'
      : 'WAITING FOR STRANGERS TO JOIN YOUR GROUP...';
    if (state.mode === 'searching') {
      setPeerStatus(aloneText + ' PRESS [NEXT] TO SKIP.');
      return;
    }
    const total = Object.keys(peers).length;
    if (total === 0) {
      setPeerStatus(aloneText);
    } else if (connectedPeers > 0) {
      setPeerStatus(connectedPeers + ' OF ' + total + ' CONNECTION' + (total > 1 ? 'S' : '') + ' ESTABLISHED.');
    } else {
      setPeerStatus('CONNECTING TO ' + total + ' OTHER' + (total > 1 ? 'S' : '') + '...');
    }
  }

  function updateChatInput() {
    const active = state.mode === 'chatting' && Object.keys(peers).length > 0;
    els.chatInput.disabled = !active;
    els.sendBtn.disabled = !active;
    if (active) els.chatInput.focus();
  }

  /* ---------------- Media ---------------- */

  function isInsecureContext() {
    if (typeof window.isSecureContext === 'boolean') return !window.isSecureContext;
    return location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  }

  async function acquireMedia(withVideo) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return handleMediaError({ name: 'NoMediaAPI' });
    }
    if (isInsecureContext()) {
      return handleMediaError({ name: 'InsecureContext' });
    }

    const attempts = [];
    if (withVideo) {
      attempts.push({
        video: { facingMode: state.facingMode === 'environment' ? 'environment' : 'user' },
        audio: true,
      });
      attempts.push({ video: true, audio: true });
      attempts.push({ video: true, audio: false });
    } else {
      attempts.push({ audio: true });
    }

    let lastErr = null;
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        localStream = stream;
        state.hasMedia = true;
        refreshLocalVideo();
        els.localPlaceholder.classList.add('hidden');
        updateCamLabel();
        applyTrackStates();
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    localStream = null;
    state.hasMedia = false;
    return handleMediaError(lastErr);
  }

  function handleMediaError(err) {
    const e = err || {};
    let text;
    if (isInsecureContext() || e.name === 'InsecureContext') {
      text = 'CAMERA/MIC BLOCKED: THIS PAGE IS NOT SECURE (HTTPS).\n\n' +
        'MOBILE BROWSERS ONLY ALLOW CAMERA/MIC ON HTTPS OR LOCALHOST. ' +
        'OPEN THE PUBLIC HTTPS LINK, OR RUN ON YOUR OWN COMPUTER VIA LOCALHOST.';
    } else if (e.name === 'NoMediaAPI') {
      text = 'YOUR BROWSER DOES NOT SUPPORT CAMERA/MIC ACCESS.';
    } else {
      const map = {
        NotFoundError: 'NO CAMERA OR MICROPHONE DETECTED.',
        NotAllowedError: 'CAMERA/MIC PERMISSION DENIED. ALLOW ACCESS IN THE BROWSER (SEE THE PERMISSION LOCK/ICON).',
        NotReadableError: 'CAMERA OR MIC IS ALREADY IN USE BY ANOTHER APP.',
        OverconstrainedError: 'REQUESTED CAMERA/MIC SETUP NOT SUPPORTED ON THIS DEVICE.',
        SecurityError: 'CAMERA/MIC BLOCKED BY THE BROWSER (SECURE CONTEXT REQUIRED - USE HTTPS).',
        AbortError: 'CAMERA/MIC ACCESS ABORTED.',
      };
      text = map[e.name] || ('MEDIA ACCESS FAILED: ' + (e.name || 'unknown') + (e.message ? ' - ' + e.message : ''));
    }
    showOverlay('CAMERA ERROR', text + '\n\nYOU CAN STILL CONTINUE IN TEXT-ONLY MODE.', 'CONTINUE TEXT-ONLY');
    return new Promise((resolve) => {
      els.overlayOk.onclick = () => {
        hideOverlay();
        resolve(false);
      };
    });
  }

  function applyTrackStates() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
    localStream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
  }

  function outgoingStream() {
    return localStream;
  }

  function refreshLocalVideo() {
    els.localVideo.srcObject = localStream;
    if (localStream) els.localVideo.play().catch(() => {});
  }

  function stopMedia() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    state.hasMedia = false;
    els.localPlaceholder.classList.remove('hidden');
    state.micOn = state.camOn = true;
    els.micBtn.textContent = '\uD83C\uDFA4 Mic: On';
    els.camBtn.textContent = '\uD83D\uDCF7 Cam: On';
    updateCamLabel();
  }

  /* ---------------- Call lifecycle ---------------- */

  function sendJoin() {
    if (!wsSend({ type: 'join', name: state.name, interests: state.interests, mode: chatMode })) return;
    setMode('searching');
    setPeerStatus(chatMode === '2p' ? 'SEARCHING FOR A STRANGER...' : 'SEARCHING FOR A GROUP...');
    destroyAllPeers();
  }

  function onRoomChange(reason) {
    const is2p = chatMode === '2p';
    if (reason === 'reported') {
      setPeerStatus(is2p ? 'REPORTED. MOVING TO A NEW PARTNER...' : 'GROUP REPORTED. MOVING TO A NEW GROUP...');
    } else if (reason === 'next') {
      setPeerStatus(is2p ? 'MOVING TO A NEW PARTNER...' : 'MOVING TO A NEW GROUP...');
    } else if (reason === 'disconnected') {
      setPeerStatus('SOMEONE DISCONNECTED. UPDATING YOUR CALL...');
    }
  }

  function rejoinSession() {
    if (state.mode === 'offline' || state.mode === 'idle') return;
    wsSend({ type: 'ready' });
    sendJoin();
  }

  /* ---------------- Modes & UI ---------------- */

  function setMode(m) {
    state.mode = m;
    if (m === 'idle' || m === 'offline') {
      els.lobby.classList.remove('hidden');
      els.call.classList.add('hidden');
      els.startBtn.disabled = m === 'offline';
    } else {
      els.lobby.classList.add('hidden');
      els.call.classList.remove('hidden');
    }
    if (m === 'idle') els.lobbyMsg.textContent = '';
  }

  function updateModeLabel() {
    if (chatMode === '2p') {
      els.modeLabel.textContent = 'MODE: 2-PERSON';
      els.modeLabel.className = 'mode-chip chip-2p';
    } else if (chatMode === 'group') {
      els.modeLabel.textContent = 'MODE: GROUP (MAX 5)';
      els.modeLabel.className = 'mode-chip chip-group';
    } else {
      els.modeLabel.textContent = 'MODE: --';
      els.modeLabel.className = 'mode-chip';
    }
  }

  function selectMode(m) {
    chatMode = m;
    els.modeScreen.classList.add('hidden');
    updateModeLabel();
    setMode('idle');
  }

  function showModeScreen() {
    chatMode = null;
    els.lobby.classList.add('hidden');
    els.call.classList.add('hidden');
    els.modeScreen.classList.remove('hidden');
    updateModeLabel();
  }

  function setConn(text) { els.connStatus.textContent = text; }

  function setPeerStatus(text) { els.peerStatus.textContent = text; }

  function setStatusBar(text, flash) {
    els.ticker.textContent = text;
    if (flash) {
      flashUntil = Date.now() + 3000;
      els.ticker.classList.add('flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        if (Date.now() >= flashUntil) els.ticker.classList.remove('flash');
      }, 3000);
    }
  }

  function updateOnline(n) {
    const num = Number(n);
    els.onlineLed.textContent = (Number.isFinite(num) && num >= 0 ? num.toLocaleString() : '0') + ' PEOPLE ONLINE';
  }

  function appendChat(name, text, isMe) {
    const row = document.createElement('div');
    row.className = 'msg' + (isMe ? ' me' : '');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = (isMe ? 'You' : (name || 'Stranger')) + ': ';
    const body = document.createElement('span');
    body.textContent = text;
    row.appendChild(who);
    row.appendChild(body);
    els.chatLog.appendChild(row);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function showTyping(on) {
    if (on) els.typing.classList.remove('hidden');
    else els.typing.classList.add('hidden');
  }

  function showOverlay(title, text, okLabel) {
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text;
    els.overlayOk.textContent = okLabel ? '[ ' + okLabel + ' ]' : '[ OK ]';
    els.overlay.classList.remove('hidden');
  }

  function hideOverlay() { els.overlay.classList.add('hidden'); }

  /* ---------------- Actions ---------------- */

  async function onStart() {
    if (state.mode === 'searching' || state.mode === 'connecting' || state.mode === 'chatting') return;
    if (!chatMode) { showModeScreen(); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      els.lobbyMsg.textContent = 'ERROR: NO CONNECTION TO SERVER. RETRYING...';
      connect();
      return;
    }
    state.name = els.name.value.trim().slice(0, 32) || 'Stranger';
    state.interests = els.interests.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8);
    els.startBtn.disabled = true;
    els.lobbyMsg.textContent = 'INITIALIZING...';

    stopMedia();

    if (els.enableVideo.checked) {
      const ok = await acquireMedia(true);
      if (!ok) {
        setMode('idle');
        els.startBtn.disabled = false;
        els.lobbyMsg.textContent = 'CONTINUING IN TEXT-ONLY MODE. UNCHECK "ENABLE CAMERA & MIC" TO SKIP.';
        return;
      }
    }

    state.autoRejoin = true;
    wsSend({ type: 'ready' });
    sendJoin();
  }

  function onNext() {
    destroyAllPeers();
    els.chatLog.innerHTML = '';
    showTyping(false);
    wsSend({ type: 'next' });
    setPeerStatus(chatMode === '2p' ? 'SKIPPING THIS STRANGER...' : 'SKIPPING THIS GROUP...');
  }

  function onStop() {
    destroyAllPeers();
    els.chatLog.innerHTML = '';
    showTyping(false);
    wsSend({ type: 'leave' });
    stopMedia();
    state.autoRejoin = false;
    selfId = null;
    roomId = null;
    setMode('idle');
    els.startBtn.disabled = !ws || ws.readyState !== WebSocket.OPEN;
    els.lobbyMsg.textContent = 'STANDBY. PRESS [START CHAT] WHEN READY.';
  }

  function onReport() {
    destroyAllPeers();
    els.chatLog.innerHTML = '';
    showTyping(false);
    wsSend({ type: 'report' });
    setPeerStatus(chatMode === '2p' ? 'REPORT SENT. MOVING TO A NEW PARTNER...' : 'REPORT SENT. MOVING TO A NEW GROUP...');
  }

  function onMic() {
    state.micOn = !state.micOn;
    applyTrackStates();
    els.micBtn.textContent = state.micOn ? '\uD83C\uDFA4 Mic: On' : '\uD83C\uDFA4 Mic: Off';
  }

  function onCam() {
    state.camOn = !state.camOn;
    applyTrackStates();
    els.camBtn.textContent = state.camOn ? '\uD83D\uDCF7 Cam: On' : '\uD83D\uDCF7 Cam: Off';
    if (state.camOn) els.localPlaceholder.classList.add('hidden');
    else els.localPlaceholder.classList.remove('hidden');
  }

  function updateCamLabel() {
    els.switchCamBtn.textContent = state.facingMode === 'environment' ? '\uD83D\uDD04 Rear' : '\uD83D\uDD04 Front';
    els.localVideo.classList.toggle('mirror', state.facingMode !== 'environment');
  }

  function currentCameraId() {
    if (!localStream) return null;
    const track = localStream.getVideoTracks()[0];
    if (!track) return null;
    try { return track.getSettings().deviceId || null; } catch (e) { return null; }
  }

  function isFacingEnvironment(track) {
    if (!track) return false;
    let fm = null;
    try { fm = track.getSettings().facingMode; } catch (e) {}
    if (fm === 'environment' || fm === 'left' || fm === 'right') return true;
    if (fm === 'user') return false;
    const label = (track.label || '').toLowerCase();
    return /(back|rear|environment|secondary|trilateration)/i.test(label);
  }

  async function enumerateCameras() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
    } catch (e) {
      return [];
    }
  }

  async function acquireVideoTrackByDevice(deviceId) {
    const strategies = [];
    if (deviceId) {
      strategies.push({ video: { deviceId: { exact: deviceId } }, audio: false });
    }
    strategies.push({ video: true, audio: false });
    for (const constraints of strategies) {
      try {
        const vs = await navigator.mediaDevices.getUserMedia(constraints);
        const track = vs.getVideoTracks()[0];
        if (track) {
          vs.getTracks().forEach((t) => { if (t !== track) t.stop(); });
          return track;
        }
      } catch (e) {
        /* try next strategy */
      }
    }
    return null;
  }

  async function onSwitchCam() {
    if (!localStream || !localStream.getVideoTracks().length) return;
    const cams = await enumerateCameras();
    if (cams.length <= 1) {
      setStatusBar('ONLY ONE CAMERA AVAILABLE - CANNOT SWITCH', true);
      return;
    }

    const oldTrack = localStream.getVideoTracks()[0];
    const micTrack = localStream.getAudioTracks()[0];
    const currentId = currentCameraId();
    let idx = cams.findIndex((c) => c.deviceId === currentId);
    if (idx === -1) idx = 0;
    const next = cams[(idx + 1) % cams.length];

    setStatusBar('SWITCHING CAMERA...', true);
    els.switchCamBtn.disabled = true;
    els.localVideo.srcObject = null;
    if (state.camOn) els.localPlaceholder.classList.remove('hidden');

    localStream.removeTrack(oldTrack);
    oldTrack.stop();

    let newTrack = await acquireVideoTrackByDevice(next.deviceId);
    if (!newTrack) newTrack = await acquireVideoTrackByDevice(cams[0].deviceId);

    if (!newTrack) {
      const restored = await acquireVideoTrackByDevice(currentId);
      if (restored) {
        localStream.addTrack(restored);
        refreshLocalVideo();
        await replaceTracksOnAllPeers(oldTrack, restored);
        setStatusBar('CAMERA SWITCH UNAVAILABLE - KEPT CURRENT', true);
      }
    } else {
      localStream.addTrack(newTrack);
      state.facingMode = isFacingEnvironment(newTrack) ? 'environment' : 'user';
      refreshLocalVideo();
      updateCamLabel();
      await replaceTracksOnAllPeers(oldTrack, newTrack);
    }
    applyTrackStates();
    if (micTrack && !localStream.getAudioTracks().length) localStream.addTrack(micTrack);
    if (state.camOn && localStream.getVideoTracks().length) els.localPlaceholder.classList.add('hidden');
    els.switchCamBtn.disabled = false;
  }

  async function replaceTracksOnAllPeers(oldTrack, newTrack) {
    let anyFailed = false;
    for (const id of Object.keys(peers)) {
      try {
        await peers[id].replaceTrack(oldTrack, newTrack, outgoingStream());
      } catch (e) {
        anyFailed = true;
      }
    }
    if (anyFailed) setStatusBar('CAMERA SWITCHED FOR LOCAL PREVIEW ONLY', true);
  }

  function onSend() {
    const text = els.chatInput.value.trim();
    if (!text || state.mode !== 'chatting') return;
    if (wsSend({ type: 'chat', text: text.slice(0, 1000) })) {
      appendChat('YOU', text, true);
    }
    els.chatInput.value = '';
  }

  function onTyping() {
    if (state.mode !== 'chatting') return;
    wsSend({ type: 'typing', isTyping: true });
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      wsSend({ type: 'typing', isTyping: false });
    }, 1500);
  }

  /* ---------------- Theme ---------------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    els.themeBtn.textContent = theme === 'dark' ? '\uD83C\uDF1E' : '\uD83C\uDF19';
    try { localStorage.setItem('chatkaro-theme', theme); } catch (e) {}
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('chatkaro-theme'); } catch (e) {}
    if (!saved) {
      saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    applyTheme(saved === 'dark' ? 'dark' : 'light');
  }

  function onTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  /* ---------------- Ticker ---------------- */

  const bootLines = [
    'Ready when you are.',
    'Video is end-to-end encrypted.',
    'Your video only reaches your current partner.',
    'Be nice. Report abuse with the Report button.',
    'Camera requires HTTPS - use the public link.',
  ];
  let tickerIdx = 0;
  let flashUntil = 0;
  let flashTimer = null;
  setInterval(() => {
    if (Date.now() < flashUntil) return;
    els.ticker.textContent = bootLines[tickerIdx % bootLines.length];
    tickerIdx++;
  }, 5000);

  /* ---------------- Wire up ---------------- */

  els.startBtn.addEventListener('click', onStart);
  els.mode2pBtn.addEventListener('click', () => selectMode('2p'));
  els.modeGroupBtn.addEventListener('click', () => selectMode('group'));
  els.changeModeBtn.addEventListener('click', showModeScreen);
  els.nextBtn.addEventListener('click', onNext);
  els.stopBtn.addEventListener('click', onStop);
  els.reportBtn.addEventListener('click', onReport);
  els.micBtn.addEventListener('click', onMic);
  els.camBtn.addEventListener('click', onCam);
  els.switchCamBtn.addEventListener('click', onSwitchCam);
  els.sendBtn.addEventListener('click', onSend);
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSend();
  });
  els.chatInput.addEventListener('input', onTyping);
  els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') onStart(); });
  els.interests.addEventListener('keydown', (e) => { if (e.key === 'Enter') onStart(); });
  els.overlayOk.addEventListener('click', hideOverlay);
  els.themeBtn.addEventListener('click', onTheme);
  window.addEventListener('beforeunload', () => { manualClose = true; });

  initTheme();

  if (!window.SimplePeer) {
    showOverlay('FATAL', 'SimplePeer library failed to load. Check network / vendor file.');
  } else {
    connect();
  }
})();
