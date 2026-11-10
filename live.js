/* ===== Voice call mode: Gemini Live bridge team over the simulator =====
   The simulator is the source of truth. The model speaks for lookout, nav and helm,
   reads figures only from tool results, and drives own ship only through tools. */
import { GoogleGenAI, Modality } from './vendor/genai-2.31.0.js';

const KEY_STORE = 'bt.geminiKey', VOICE_STORE = 'bt.voice', MODEL_STORE = 'bt.model';
const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } } };
const el = id => document.getElementById(id);

const SYSTEM = `You are the bridge team on a warship in the Singapore Strait during an officer of the watch (OOW) crossing drill. The user is the OOW. You play three people: the LOOKOUT, the NAVIGATOR ("nav") and the HELMSMAN. You are not an assistant; never break character, never give a debrief, never explain.

GROUND TRUTH
- A simulator runs the ship and all traffic. Every bearing, range, course, speed, CPA, time and bow crossing range you say MUST come from a tool result in this turn or a [SIM] message. Never estimate or invent a figure. If a tool returns a sentence, say that sentence word for word.
- You can only steer or change speed by calling helm_order or set_speed. Then say the helm repeat the tool returns, word for word.

HOW REPORTS WORK
- A report you start yourself opens with a call-up: "OOW sir, lookout" or "OOW sir, nav". Then STOP and wait. Only after the OOW answers "OOW" (or "go ahead", "send") give the report. If no answer, you may repeat the call-up once.
- When the OOW says "nav" (or asks nav anything), nav answers straight away with nav_followup. When the OOW says "lookout", the lookout answers straight away with lookout_bearing.
- Lookout report style: relative bearing then what it is, e.g. "green four five, ferry crossing right to left, bearing drawing left slowly".
- Nav follow-up style: "follow up on last reported, true bearing ..., range ..., tracking ... at ... knots, CPA ... in ... minutes on our port/starboard side, bearing drawing left/right/slowly/steady".
- When the OOW asks for bow crossing range, nav calls bow_crossing.
- When the OOW gives a sitrep ending "check starboard/port, check <course>": lookout calls check_side and says the result; then nav calls check_course and says the result, e.g. "zero one zero clear on blind". Then wait for the OOW's helm order.
- When the OOW asks nav to set a CPA trigger, call set_cpa_trigger.
- Helm orders like "starboard ten, steer two five nine", "port twenty", "midships", "steady", "revolutions for fifteen knots": call helm_order or set_speed and say the repeat.
- For any other question about the picture, call get_situation and answer briefly in bridge style, as the right role.

VOICE
- Short, clipped, brisk, like real bridge comms. No filler, no pleasantries.
- Say numbers digit by digit: "two five nine", "green four five", "one point five miles", "two point five cables". Never say "decimal" or "speed". Use "niner" only if the OOW does.
- Do not label roles in speech except in the call-up ("OOW sir, nav").

[SIM] MESSAGES
- Messages starting with [SIM] come from the simulator, not the OOW. Act on them as instructed, in character. Never read "[SIM]" aloud.`;

const T = { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN' };
const TOOLS = [{ functionDeclarations: [
  { name: 'get_situation', description: 'Current own ship state and every contact within 6 nm: id, relative bearing, true bearing, range, type, aspect, course, speed, CPA, time to CPA, bearing movement, bow crossing. Use for any question about the picture.' },
  { name: 'get_report', description: 'Get the exact text of a report the simulator asked you to give (by ref). Call only after the OOW has acknowledged the call-up.', parameters: { type: T.OBJECT, properties: { ref: { type: T.INTEGER } }, required: ['ref'] } },
  { name: 'nav_followup', description: 'Nav follow-up report on a contact. Omit contact_id for the last reported or currently followed contact.', parameters: { type: T.OBJECT, properties: { contact_id: { type: T.INTEGER } } } },
  { name: 'lookout_bearing', description: 'Lookout report of a contact\'s relative bearing and bearing movement. Omit contact_id for the currently followed contact.', parameters: { type: T.OBJECT, properties: { contact_id: { type: T.INTEGER } } } },
  { name: 'bow_crossing', description: 'Bow crossing range for a contact (own ship crossing her bow). Omit contact_id for the followed contact.', parameters: { type: T.OBJECT, properties: { contact_id: { type: T.INTEGER } } } },
  { name: 'check_side', description: 'Lookout check of the nearest object on one side.', parameters: { type: T.OBJECT, properties: { side: { type: T.STRING, enum: ['port', 'starboard'] } }, required: ['side'] } },
  { name: 'check_course', description: 'Nav check whether a new course is clear on blind.', parameters: { type: T.OBJECT, properties: { course: { type: T.INTEGER, description: 'True course 0-359' } }, required: ['course'] } },
  { name: 'helm_order', description: 'Execute a helm order. Examples: starboard 10 steer 259 -> side starboard, rudder 10, course 259. Port 20 -> side port, rudder 20. Midships -> midships true. Steady -> steady true. Steer 180 -> course 180.', parameters: { type: T.OBJECT, properties: { side: { type: T.STRING, enum: ['port', 'starboard'] }, rudder: { type: T.INTEGER, description: 'Rudder angle in degrees, 5-35' }, course: { type: T.INTEGER }, midships: { type: T.BOOLEAN }, steady: { type: T.BOOLEAN } } } },
  { name: 'set_speed', description: 'Ordered speed in knots.', parameters: { type: T.OBJECT, properties: { knots: { type: T.NUMBER } }, required: ['knots'] } },
  { name: 'set_cpa_trigger', description: 'Set nav\'s CPA trigger in cables, or cancel with cables 0.', parameters: { type: T.OBJECT, properties: { cables: { type: T.NUMBER } }, required: ['cables'] } }
] }];

/* ---------- audio ---------- */
const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.acc=0;this.buf=new Int16Array(1600);this.n=0;this.on=true;this.port.onmessage=e=>{this.on=e.data}}
process(i){const ch=i[0]&&i[0][0];if(!ch)return true;for(let k=0;k<ch.length;k++){this.acc+=1;if(this.acc>=this.r){this.acc-=this.r;let v=this.on?ch[k]:0;v=Math.max(-1,Math.min(1,v));this.buf[this.n++]=v<0?v*32768:v*32767;if(this.n===this.buf.length){this.port.postMessage(this.buf.buffer.slice(0));this.n=0}}}return true}}
registerProcessor('cap',Cap);`;
function b64FromBuf(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function bufFromB64(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }

const LIVE = window.LIVE = {
  active: false, session: null, ctx: null, node: null, stream: null, muted: false,
  playEnd: 0, sources: [], handle: null, closing: false, reconnects: 0, setupDone: false, lite: false,
  refs: new Map(), nextRef: 1, outbox: [], lastUserAt: 0, turnOpen: false, outText: '', inText: '', capture: null,

  wanted() { return !!el('optCall') && el('optCall').checked && !!store.get(KEY_STORE); },
  busy(who) { for (const r of this.refs.values()) if (r.who === who && !r.done && performance.now() - r.at < 60000) return true; return this.outbox.some(o => o.who === who); },

  status(t, cls) { const p = el('callPill'); if (!p) return; p.textContent = t; p.className = 'callpill ' + (cls || ''); p.hidden = false; },

  async start() {
    this.active = true; this.closing = false; this.reconnects = 0; this.handle = null; this.refs.clear(); this.outbox = []; this.lite = false;
    document.body.classList.add('incall');
    this.status('Connecting…', 'wait'); setPaused(true);
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      await this.ctx.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'cap');
      this.node.port.onmessage = e => { if (this.session && this.setupDone) { try { this.session.sendRealtimeInput({ audio: { data: b64FromBuf(e.data), mimeType: 'audio/pcm;rate=16000' } }); } catch (err) { } } };
      const mute = this.ctx.createGain(); mute.gain.value = 0;
      src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    } catch (e) {
      this.fail('Microphone not available: ' + (e.message || e.name) + '. Allow the microphone for this site and start again.'); return;
    }
    await this.connect();
    this.tick = setInterval(() => this.flush(), 400);
  },

  config() {
    const voice = store.get(VOICE_STORE) || 'Charon';
    const c = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: SYSTEM,
      tools: TOOLS,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      inputAudioTranscription: {}, outputAudioTranscription: {},
      sessionResumption: this.handle ? { handle: this.handle } : {},
      contextWindowCompression: { slidingWindow: {} }
    };
    if (!this.lite) c.thinkingConfig = { thinkingLevel: 'MINIMAL' };
    return c;
  },

  async connect() {
    this.setupDone = false;
    const ai = new GoogleGenAI({ apiKey: store.get(KEY_STORE) });
    const model = store.get(MODEL_STORE) || DEFAULT_MODEL;
    try {
      this.session = await ai.live.connect({ model, config: this.config(), callbacks: {
        onopen: () => { },
        onmessage: m => this.onMessage(m),
        onerror: e => { console.warn('live error', e); },
        onclose: e => this.onClose(e)
      } });
    } catch (e) { this.fail('Could not connect: ' + (e.message || e)); }
  },

  onClose(e) {
    const why = (e && e.reason) || '';
    this.session = null;
    if (!this.active || this.closing) return;
    if (!this.setupDone && !this.lite && !/api key|permission|denied|unauth|quota|billing/i.test(why)) { this.lite = true; this.connect(); return; }
    if (/api key|permission|denied|unauth|quota|billing|not found/i.test(why) || this.reconnects > 4) { this.fail('Call ended: ' + (why || 'connection closed') + '.'); return; }
    this.reconnects++; this.status('Reconnecting…', 'wait');
    setTimeout(() => this.active && this.connect(), 600 * this.reconnects);
  },

  fail(msg) {
    this.stopAudio(); this.active = false; this.session = null; clearInterval(this.tick);
    document.body.classList.remove('incall');
    this.status('Call off', 'bad');
    addLog('sys', msg);
  },

  onMessage(m) {
    this.lastServerAt = performance.now();
    if (m.setupComplete) {
      const first = !this.setupDone && this.reconnects === 0 && !this.handle;
      this.setupDone = true; this.status(this.muted ? 'Call on · muted' : 'Call on · listening', 'ok');
      if (first) setPaused(false);
      if (first) this.push({ who: 'sys', text: '[SIM] Drill start. Say exactly: "Drill start. Own ship course one eight zero, twelve knots." Then wait.' });
    }
    if (m.sessionResumptionUpdate && m.sessionResumptionUpdate.resumable && m.sessionResumptionUpdate.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) { try { this.session && this.session.close(); } catch (e) { } }
    if (m.toolCall && m.toolCall.functionCalls) this.runTools(m.toolCall.functionCalls);
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) this.stopPlayback();
    if (sc.inputTranscription && sc.inputTranscription.text) { this.inText += sc.inputTranscription.text; this.lastUserAt = performance.now(); clearTimeout(this.inTimer); this.inTimer = setTimeout(() => this.flushIn(), 900); }
    if (sc.modelTurn && sc.modelTurn.parts) {
      this.turnOpen = true;
      if (this.inText) this.flushIn();
      for (const p of sc.modelTurn.parts) if (p.inlineData && /audio/.test(p.inlineData.mimeType || 'audio')) this.play(p.inlineData.data);
    }
    if (sc.outputTranscription && sc.outputTranscription.text) this.outText += sc.outputTranscription.text;
    if (sc.turnComplete || sc.interrupted) { this.turnOpen = false; this.flushOut(); }
  },

  flushIn() { const t = this.inText.trim(); this.inText = ''; if (t) addLog('oow', t); },
  flushOut() {
    const t = this.outText.trim(); this.outText = '';
    if (!t) return;
    const m = t.match(/^(OOW sir,\s*)?(lookout|nav)\b/i);
    addLog(m ? m[2].toLowerCase() : (/^(starboard|port|midships|steady|revolutions|wheel)/i.test(t) ? 'helm' : 'nav'), t);
  },

  play(b64) {
    const pcm = new Int16Array(bufFromB64(b64)); if (!pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, 24000), ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.03, this.playEnd); s.start(t); this.playEnd = t + buf.duration;
    this.sources.push(s); s.onended = () => { this.sources = this.sources.filter(x => x !== s); };
  },
  stopPlayback() { for (const s of this.sources) { try { s.stop(); } catch (e) { } } this.sources = []; this.playEnd = 0; },
  speaking() { const playing = this.ctx && this.playEnd > this.ctx.currentTime; if (this.turnOpen && !playing && performance.now() - (this.lastServerAt || 0) > 6000) this.turnOpen = false; return this.turnOpen || playing; },

  /* sim -> model */
  event(item) {
    const ref = this.nextRef++;
    this.refs.set(ref, { who: item.who, body: item.body, at: performance.now(), done: false });
    if (item.call) this.push({ who: item.who, text: `[SIM] The ${item.who === 'nav' ? 'navigator' : 'lookout'} has a report (ref ${ref}). As ${item.who}, say only "OOW sir, ${item.who}" and wait. When the OOW answers, call get_report with ref ${ref} and say the result word for word.` });
    else { const t = item.body(); this.refs.get(ref).done = true; if (t) this.push({ who: item.who, text: `[SIM] As ${item.who}, say exactly now: "${t}"` }); }
  },
  say(who, text) {
    if (this.capture) { this.capture.push(text); return; }
    this.push({ who, text: `[SIM] As ${who === 'helm' ? 'helmsman' : who}, say exactly now: "${text}"` });
  },
  push(o) { this.outbox.push(o); this.flush(); },
  flush() {
    if (!this.session || !this.setupDone || !this.outbox.length) return;
    if (this.speaking() || performance.now() - this.lastUserAt < 1200) return;
    const o = this.outbox.shift();
    try { this.session.sendRealtimeInput({ text: o.text }); this.turnOpen = true; this.lastServerAt = performance.now(); } catch (e) { this.outbox.unshift(o); }
  },
  userText(text) {
    addLog('oow', text);
    if (this.session && this.setupDone) { try { this.session.sendRealtimeInput({ text }); } catch (e) { } }
  },

  /* tools */
  runTools(calls) {
    const responses = calls.map(fc => {
      let result;
      try { result = this.tool(fc.name, fc.args || {}); } catch (e) { result = { error: String(e.message || e) }; }
      return { id: fc.id, name: fc.name, response: typeof result === 'string' ? { say: result } : result };
    });
    try { this.session && this.session.sendToolResponse({ functionResponses: responses }); } catch (e) { }
    if (window.renderContacts) renderContacts();
  },
  pick(id) { if (id == null) return S.navTarget; const c = S.contacts.find(x => x.id === +id); if (c) S.navTarget = c; return c || null; },
  tool(name, a) {
    switch (name) {
      case 'get_situation': return situation();
      case 'get_report': { const r = this.refs.get(+a.ref); if (!r) return { error: 'unknown ref' }; r.done = true; const t = r.body(); return t || 'nothing further'; }
      case 'nav_followup': { if (a.contact_id != null && !this.pick(a.contact_id)) return { error: 'no such contact' }; return navReport(); }
      case 'lookout_bearing': { const c = this.pick(a.contact_id); return lookoutBearing(c); }
      case 'bow_crossing': { if (a.contact_id != null && !this.pick(a.contact_id)) return { error: 'no such contact' }; return bcrReport(); }
      case 'check_side': return checkSide(a.side === 'port' ? 'port' : 'starboard');
      case 'check_course': return checkCourse(((Math.round(+a.course) % 360) + 360) % 360);
      case 'helm_order': {
        this.capture = [];
        const o = a.midships ? { mid: true, rud: 0 } : a.steady ? { steady: true } : { side: a.side || null, rud: a.rudder != null ? Math.min(35, Math.max(0, +a.rudder)) : null, crs: a.course != null ? ((Math.round(+a.course) % 360) + 360) % 360 : null };
        if (!o.mid && !o.steady && o.side == null && o.crs == null) { this.capture = null; return { error: 'need a side or a course' }; }
        helmOrder(o); const t = this.capture.join('. '); this.capture = null; return t;
      }
      case 'set_speed': { const v = Math.max(0, Math.min(30, +a.knots)); S.own.tgtSpd = v; return `Revolutions for ${v} knots`; }
      case 'set_cpa_trigger': { const v = +a.cables; S.trigger = v > 0 ? v / 10 : null; S.contacts.forEach(x => x.trigAlerted = false); return v > 0 ? `CPA trigger set, ${cableWords(v / 10)}` : 'CPA trigger cancelled'; }
    }
    return { error: 'unknown tool' };
  },

  setMute(m) { this.muted = m; if (this.node) this.node.port.postMessage(!m); const b = el('bCallMute'); if (b) { b.setAttribute('aria-pressed', m); b.textContent = m ? 'Unmute' : 'Mute'; } if (this.setupDone) this.status(m ? 'Call on · muted' : 'Call on · listening', 'ok'); },
  stopAudio() { this.stopPlayback(); try { this.node && this.node.disconnect(); } catch (e) { } this.node = null; if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null; },
  stop() {
    if (!this.active) return;
    this.closing = true; this.active = false; clearInterval(this.tick);
    try { this.session && this.session.close(); } catch (e) { }
    this.session = null; this.stopAudio(); document.body.classList.remove('incall'); this.status('Call ended', '');
  }
};

function r1(x) { return Math.round(x * 10) / 10; }
function situation() {
  const o = S.own;
  const contacts = S.contacts.filter(c => !c.gone && !c.waiting).map(c => ({ c, ri: relInfo(o, c) })).filter(x => x.ri.range < 6).sort((a, b) => a.ri.range - b.ri.range).slice(0, 12).map(({ c, ri }) => {
    const b = c.moving ? bowCross(o, c) : { kind: 'none' };
    return {
      id: c.id, followed: c === S.navTarget, reported: !!c.reported, type: TYPES[c.type].name,
      relative_bearing: relWords(ri.rb), true_bearing: Math.round(ri.tb), range_nm: r1(ri.range),
      aspect: aspectWords(o, c), course: c.moving ? Math.round(c.course) : null, speed_kn: Math.round(c.speed),
      cpa_cables: isFinite(ri.tcpa) && ri.tcpa > 0 ? r1(ri.cpa * 10) : null, tcpa_min: isFinite(ri.tcpa) && ri.tcpa > 0 ? r1(ri.tcpa) : null,
      cpa_side: ri.cpaSide, bearing_movement: driftWords(ri.drift, 'steady'),
      bow_crossing_cables: b.kind === 'bow' ? r1(b.dist * 10) : null, crosses_her_stern: b.kind === 'stern'
    };
  });
  return {
    own_ship: { heading: Math.round(o.hdg) % 360, speed_kn: r1(o.spd), ordered_course: o.tgt, rudder: o.rud, leg: S.cues.wo ? 'westbound ITZ, planned course 259' : 'southbound 180 to wheel over onto 259' },
    drill_time: fmtT(S.t), visibility: S.tod, cpa_trigger_cables: S.trigger != null ? r1(S.trigger * 10) : null,
    margins: { cpa_cables: 2.5, bow_crossing_cables: 8 }, contacts
  };
}

/* ---------- UI ---------- */
function initUI() {
  const box = el('callSetup'); if (!box) return;
  box.hidden = false;
  const k = el('inKey'), v = el('inVoice');
  const has = !!store.get(KEY_STORE);
  el('keyState').textContent = has ? 'Key saved on this device.' : 'No key yet.';
  el('optCall').checked = has; el('optCall').disabled = !has;
  if (store.get(VOICE_STORE)) v.value = store.get(VOICE_STORE);
  el('bSaveKey').onclick = () => {
    const val = k.value.trim(); if (!val) return;
    store.set(KEY_STORE, val); k.value = '';
    el('keyState').textContent = 'Key saved on this device.'; el('optCall').disabled = false; el('optCall').checked = true;
  };
  el('bClearKey').onclick = () => { store.set(KEY_STORE, ''); el('keyState').textContent = 'Key removed.'; el('optCall').checked = false; el('optCall').disabled = true; };
  v.onchange = () => store.set(VOICE_STORE, v.value);
  el('bCallMute').onclick = () => LIVE.setMute(!LIVE.muted);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();
