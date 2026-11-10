/* ===== Claude call: Deepgram ears + voices, Claude brain, simulator as truth =====
   Set orders ("OOW", "nav", "starboard ten steer two five nine") are handled instantly by the
   simulator's own parser. Anything else goes to Claude, which answers as the bridge team using
   simulator tools. Each role speaks with its own Deepgram voice. */
(function () {
const K = { ear: 'bt.ear', mic: 'bt.mic', dg: 'bt.dgKey', cl: 'bt.claudeKey', model: 'bt.claudeModel', vLook: 'bt.vLook', vNav: 'bt.vNav', vHelm: 'bt.vHelm' };
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } } };
const el = id => document.getElementById(id);
const DEF_VOICE = { lookout: 'aura-2-orion-en', nav: 'aura-2-arcas-en', helm: 'aura-2-apollo-en', sys: 'aura-2-arcas-en' };
const KEYTERMS = ['OOW', 'nav', 'lookout', 'starboard', 'port', 'midships', 'steady', 'steer', 'niner', 'green', 'red', 'cables', 'CPA', 'bow crossing range', 'check starboard', 'check port', 'clear on blind', 'revolutions', 'knots', 'follow up', 'say again', 'wheel over', 'CPA trigger', 'meet her', 'ferry', 'tanker', 'bearing drawing', 'sitrep', 'watch-on-deck', 'risk of collision', 'intention'];
const QUESTIONY = /\b(what|which|where|when|why|how|who|say again|repeat|confirm|any|anything|is|are|was|do|does|did|can|could|should|tell|give me|report|status|picture|closest|nearest|time to|ahead of|behind)\b/;

const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.acc=0;this.buf=new Int16Array(1600);this.n=0;this.on=true;this.port.onmessage=e=>{this.on=e.data}}
process(i){const ch=i[0]&&i[0][0];if(!ch)return true;for(let k=0;k<ch.length;k++){this.acc+=1;if(this.acc>=this.r){this.acc-=this.r;let v=this.on?ch[k]:0;v=Math.max(-1,Math.min(1,v));this.buf[this.n++]=v<0?v*32768:v*32767;if(this.n===this.buf.length){this.port.postMessage(this.buf.buffer.slice(0));this.n=0}}}return true}}
registerProcessor('cap',Cap);`;

const SYSTEM = `You are the bridge team on a warship in the Singapore Strait during an officer of the watch (OOW) crossing drill. The user is the OOW. You speak as the LOOKOUT, the NAVIGATOR ("nav") or the HELMSMAN. Never break character, never explain, never debrief.

OUTPUT FORMAT
- Reply with one or more lines, each starting with the speaker: "LOOKOUT: ...", "NAV: ..." or "HELM: ...". Nothing else. If nothing needs saying, reply "NONE".
- Keep it short and clipped like real bridge comms. No filler, no pleasantries.

GROUND TRUTH
- A simulator runs the ship and all traffic. Each message includes the simulator's situation right now, with ready-made report sentences for the followed contact. Answer straight from it: every bearing, range, course, speed, CPA, time and bow crossing range you say MUST come from that situation or a tool result. Never estimate or invent a figure. When a ready-made sentence fits, speak it word for word.
- Call a tool only to act (helm_order, set_speed, set_cpa_trigger, follow_contact), for check_course or check_side, or for a report on a contact other than the followed one. Speed matters: answer in one go whenever you can.
- Steering and speed happen only through helm_order and set_speed. The helmsman's repeat is spoken automatically when you call them, so do NOT write a HELM line for it.

STYLE
- Lookout: relative bearing then description, e.g. "green four five, ferry crossing right to left, bearing drawing left slowly".
- Nav follow-up: "follow up on last reported, true bearing ..., range ..., tracking ... at ... knots, CPA ... in ... minutes on our port/starboard side, bearing drawing ...". Use nav_followup.
- Asked for bow crossing range: nav uses bow_crossing.
- "check starboard/port, check <course>": LOOKOUT line from check_side, then NAV line from check_course.
- Numbers digit by digit ("two five nine", "green four five", "two point five cables"). Never say "decimal" or "speed".
- If the OOW's words are unclear, the right person says "say again".

You will get the recent bridge comms for context, then what the OOW just said. The OOW's words come from speech recognition and may contain small errors; interpret them as a naval officer would.`;

const TOOLS = [
  { name: 'get_situation', description: 'Own ship state and every contact within 6 nm: id, relative and true bearing, range, type, aspect, course, speed, CPA, time to CPA, bearing movement, bow crossing.', input_schema: { type: 'object', properties: {} } },
  { name: 'nav_followup', description: 'Nav follow-up report text. Omit contact_id for the followed contact.', input_schema: { type: 'object', properties: { contact_id: { type: 'integer' } } } },
  { name: 'lookout_bearing', description: 'Lookout report of relative bearing and bearing movement. Omit contact_id for the followed contact.', input_schema: { type: 'object', properties: { contact_id: { type: 'integer' } } } },
  { name: 'bow_crossing', description: 'Bow crossing range text. Omit contact_id for the followed contact.', input_schema: { type: 'object', properties: { contact_id: { type: 'integer' } } } },
  { name: 'check_side', description: 'Lookout: nearest object on one side.', input_schema: { type: 'object', properties: { side: { type: 'string', enum: ['port', 'starboard'] } }, required: ['side'] } },
  { name: 'check_course', description: 'Nav: is a new course clear on blind.', input_schema: { type: 'object', properties: { course: { type: 'integer' } }, required: ['course'] } },
  { name: 'helm_order', description: 'Execute a helm order (repeat is spoken automatically). starboard 10 steer 259 -> side starboard, rudder 10, course 259. Port 20 -> side port, rudder 20. Midships -> midships true. Steady -> steady true.', input_schema: { type: 'object', properties: { side: { type: 'string', enum: ['port', 'starboard'] }, rudder: { type: 'integer' }, course: { type: 'integer' }, midships: { type: 'boolean' }, steady: { type: 'boolean' } } } },
  { name: 'set_speed', description: 'Ordered speed in knots (repeat is spoken automatically).', input_schema: { type: 'object', properties: { knots: { type: 'number' } }, required: ['knots'] } },
  { name: 'set_cpa_trigger', description: 'Set nav CPA trigger in cables (0 cancels). Returns text for NAV to say.', input_schema: { type: 'object', properties: { cables: { type: 'number' } }, required: ['cables'] } },
  { name: 'follow_contact', description: 'Make a contact the one nav and lookout follow up on.', input_schema: { type: 'object', properties: { contact_id: { type: 'integer' } }, required: ['contact_id'] } }
];
TOOLS[TOOLS.length - 1].cache_control = { type: 'ephemeral' };

function b64(buf) { return buf; }
const earOn = () => store.get(K.ear) !== '0'; // earphones: the mic stays open while the team talks
// Long lines are spoken phrase by phrase, so the first words start sooner.
function splitForSpeech(text) {
  const parts = text.split(/(?<=[,.;])\s+/), out = [];
  for (const p of parts) { if (out.length && (out[out.length - 1].length < 28 || p.length < 12)) out[out.length - 1] += ' ' + p; else out.push(p); }
  return out;
}
window.splitForSpeech = splitForSpeech;
const r1 = x => Math.round(x * 10) / 10;

const VOICE = window.VOICE = {
  active: false, ctx: null, node: null, stream: null, stt: null, tts: {}, muted: false, playEnd: 0, sources: [],
  words: '', heardTimer: null, thinking: 0, warned: {},

  wanted() { return !!el('optCall') && el('optCall').checked && !!store.get(K.dg); },
  hasClaude() { return !!store.get(K.cl); },
  status(t, cls) { const p = el('callPill'); if (!p) return; p.textContent = t; p.className = 'callpill ' + (cls || ''); p.hidden = false; },
  heard(t) { const h = el('heard'); if (h) { h.textContent = t; h.hidden = !t; } },

  start() {
    this.active = true; this.muted = false; document.body.classList.add('incall');
    this.status('Connecting…', 'wait');
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume();
    this.boot();
  },
  async boot() {
    try {
      const want = await pickMic();
      const cons = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
      if (want) cons.deviceId = { exact: want };
      try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: cons }); }
      catch (e) { if (want) { delete cons.deviceId; this.stream = await navigator.mediaDevices.getUserMedia({ audio: cons }); } else throw e; }
      const tr = this.stream.getAudioTracks()[0]; this.micLabel = tr ? tr.label : '';
      fillMics();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      try { await this.ctx.resume(); } catch (e) { }
      this.ctx.onstatechange = () => { if (this.active && this.ctx.state !== 'running') this.ctx.resume().catch(() => { }); };
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.an = this.ctx.createAnalyser(); this.an.fftSize = 512; src.connect(this.an);
      this.node = new AudioWorkletNode(this.ctx, 'cap');
      this.node.port.onmessage = e => { this.chunks = (this.chunks || 0) + 1; if (this.stt && this.stt.readyState === 1) { this.stt.send(e.data); this.sent = (this.sent || 0) + 1; } };
      const sink = this.ctx.createGain(); sink.gain.value = 0;
      src.connect(this.node); this.node.connect(sink); sink.connect(this.ctx.destination);
    } catch (e) { this.fail('Microphone not available (' + (e.message || e.name) + '). Allow the microphone for this site and start again.'); return; }
    this.openSTT();
    ['lookout', 'nav', 'helm'].forEach(r => this.openTTS(r));
    this.gate = setInterval(() => { const open = earOn() || !this.playing(); if (this.node) this.node.port.postMessage(open && !this.muted); }, 80);
    this.diagT = setInterval(() => this.diag(), 250);
  },

  /* ---------- ears ---------- */
  openSTT() {
    const q = new URLSearchParams({ model: 'nova-3', language: 'en', encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', smart_format: 'false', punctuate: 'true' });
    let url = 'wss://api.deepgram.com/v1/listen?' + q.toString();
    for (const k of KEYTERMS) url += '&keyterm=' + encodeURIComponent(k);
    const ws = new WebSocket(url, ['token', store.get(K.dg)]);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => { opened = true; this.sttFails = 0; this.status(this.muted ? 'Call on · muted' : 'Call on · listening', 'ok'); };
    ws.onmessage = e => { try { this.onSTT(JSON.parse(e.data)); } catch (err) { } };
    ws.onclose = ev => {
      this.sttClose = (ev.code || '') + (ev.reason ? ' ' + ev.reason : '');
      if (!this.active) return;
      this.sttFails = (this.sttFails || 0) + 1;
      if (!opened && this.sttFails >= 2) { this.fail('Deepgram refused the connection. Check the Deepgram key on the start screen.'); return; }
      this.status('Reconnecting…', 'wait'); setTimeout(() => this.active && this.openSTT(), 500 * this.sttFails);
    };
    this.stt = ws;
  },
  onSTT(m) {
    this.msgs = (this.msgs || 0) + 1;
    if (this.playing() && !earOn()) { if (m.type === 'Results' && m.is_final) { tr('stt_dropped', { text: this.words }); this.words = ''; } return; }
    if (m.type === 'Results') {
      const t = (m.channel && m.channel.alternatives && m.channel.alternatives[0] && m.channel.alternatives[0].transcript) || '';
      if (m.is_final && t) { this.words += (this.words ? ' ' : '') + t; tr('stt_final', { text: t, speech_final: !!m.speech_final, team_talking: this.playing() }); }
      this.heard('Heard: ' + (this.words + (m.is_final ? '' : ' ' + t)).trim());
      if (m.speech_final) this.endUtterance();
    } else if (m.type === 'UtteranceEnd') { tr('stt_utterance_end'); this.endUtterance(); }
  },
  endUtterance() {
    this.tHeard = performance.now();
    const t = this.words.trim(); this.words = '';
    if (!t) return;
    this.route(t);
  },
  route(text) {
    if (sitrepFilter(text)) return; // sitrep words are logged, never answered
    const cmds = parseCommand(text);
    const bare = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const simple = cmds.length && !(QUESTIONY.test(bare) && !cmds.every(c => c.k === 'ack'));
    tr('route', { text, to: simple || !this.hasClaude() ? 'local' : 'claude' });
    if (simple || !this.hasClaude()) handleUtterance(text, true);
    else { addLog('oow', text); this.ask(text); }
  },

  /* ---------- brain ---------- */
  async ask(text) {
    this.thinking++; this.status('Bridge team thinking…', 'wait');
    const recent = S.log.slice(-14).map(l => `${ROLE[l.who] || l.who}: ${l.text}`).join('\n');
    const now = situation(), f = S.navTarget && !S.navTarget.gone ? S.navTarget : null;
    if (f) now.followed_contact_reports = { nav_followup: navReport(), bow_crossing: bcrReport(), lookout: lookoutBearing(f) };
    const messages = [{ role: 'user', content: `Situation now:\n${JSON.stringify(now)}\n\nRecent bridge comms:\n${recent}\n\nThe OOW now says: "${text}"` }];
    try {
      for (let step = 0; step < 5; step++) {
        const t0 = performance.now(); tr('claude_req', { step });
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': store.get(K.cl), 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: store.get(K.model) || 'claude-haiku-5-5', max_tokens: 400, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], tools: TOOLS, messages })
        });
        const data = await res.json();
        tr('claude_res', { step, took_ms: Math.round(performance.now() - t0), stop: data.stop_reason, tools: (data.content || []).filter(b => b.type === 'tool_use').map(b => b.name), text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(' | ') });
        if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
        messages.push({ role: 'assistant', content: data.content });
        const uses = data.content.filter(b => b.type === 'tool_use');
        if (!uses.length || data.stop_reason !== 'tool_use') { this.speakLines(data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')); break; }
        messages.push({ role: 'user', content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(this.tool(u.name, u.input || {})) })) });
      }
    } catch (e) {
      tr('claude_error', { msg: String(e.message || e) });
      addLog('sys', 'Claude unavailable: ' + e.message + '. Set orders still work.');
    } finally {
      this.thinking--; if (this.active) this.status(this.muted ? 'Call on · muted' : 'Call on · listening', 'ok');
      if (window.renderContacts) renderContacts();
    }
  },
  speakLines(txt) {
    const items = [];
    for (const raw of txt.split('\n')) {
      const m = raw.trim().match(/^(LOOKOUT|NAV|HELM)\s*:\s*(.+)$/i);
      if (m) items.push({ who: m[1].toLowerCase(), text: m[2].trim() });
    }
    if (!items.length && txt.trim() && !/^NONE$/i.test(txt.trim())) items.push({ who: 'nav', text: txt.trim() });
    for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; Q.unshift({ who: it.who, call: false, body: () => it.text }); }
    pump();
  },
  pick(id) { if (id == null) return S.navTarget; const c = S.contacts.find(x => x.id === +id); if (c) S.navTarget = c; return c || null; },
  tool(name, a) {
    switch (name) {
      case 'get_situation': return situation();
      case 'nav_followup': if (a.contact_id != null && !this.pick(a.contact_id)) return { error: 'no such contact' }; return navReport();
      case 'lookout_bearing': return lookoutBearing(this.pick(a.contact_id));
      case 'bow_crossing': if (a.contact_id != null && !this.pick(a.contact_id)) return { error: 'no such contact' }; return bcrReport();
      case 'check_side': return checkSide(a.side === 'port' ? 'port' : 'starboard');
      case 'check_course': return checkCourse(((Math.round(+a.course) % 360) + 360) % 360);
      case 'follow_contact': return this.pick(a.contact_id) ? 'following' : { error: 'no such contact' };
      case 'helm_order': {
        const o = a.midships ? { mid: true, rud: 0 } : a.steady ? { steady: true } : { side: a.side || null, rud: a.rudder != null ? Math.min(35, Math.max(0, +a.rudder)) : null, crs: a.course != null ? ((Math.round(+a.course) % 360) + 360) % 360 : null };
        if (!o.mid && !o.steady && o.side == null && o.crs == null) return { error: 'need a side or a course' };
        helmOrder(o); return 'done, helmsman repeated the order';
      }
      case 'set_speed': { const v = Math.max(0, Math.min(30, +a.knots)); closeLoop(); S.own.tgtSpd = v; say('helm', `Revolutions for ${v} knots`); return 'done, helmsman repeated the order'; }
      case 'set_cpa_trigger': { const v = +a.cables; S.trigger = v > 0 ? v / 10 : null; S.contacts.forEach(x => x.trigAlerted = false); return v > 0 ? `CPA trigger set, ${cableWords(v / 10)}` : 'CPA trigger cancelled'; }
    }
    return { error: 'unknown tool' };
  },

  /* ---------- voices ---------- */
  voiceFor(who) { return store.get(who === 'lookout' ? K.vLook : who === 'helm' ? K.vHelm : K.vNav) || DEF_VOICE[who] || DEF_VOICE.nav; },
  openTTS(who) {
    const q = new URLSearchParams({ model: this.voiceFor(who), encoding: 'linear16', sample_rate: '24000', speed: '1.2' });
    const ws = new WebSocket('wss://api.deepgram.com/v1/speak?' + q.toString(), ['token', store.get(K.dg)]);
    ws.binaryType = 'arraybuffer'; ws.pending = []; ws.carry = null; ws.ok = false;
    ws.onopen = () => { ws.ok = true; };
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'Flushed') {
          const it = ws.pending.shift(), parts = ws.parts || []; ws.parts = []; ws.carry = null;
          if (it) { clearTimeout(it.guard); this.playUtterance(parts, it.done); }
        }
        return;
      }
      (ws.parts = ws.parts || []).push(e.data);
    };
    ws.onclose = () => { ws.ok = false; ws.pending.splice(0).forEach(it => { clearTimeout(it.guard); it.done(); }); if (this.active) setTimeout(() => this.active && this.openTTS(who), 800); };
    this.tts[who] = ws;
  },
  say(who, text, done, tries) {
    const role = who === 'sys' ? 'nav' : who, ws = this.tts[role];
    if ((!ws || ws.readyState === 0) && this.active && (tries || 0) < 25) { setTimeout(() => this.say(who, text, done, (tries || 0) + 1), 200); return; }
    if (!ws || !ws.ok || ws.readyState !== 1) { this.browserSay(who, text, done); return; }
    const pieces = splitForSpeech(text);
    pieces.forEach((piece, k) => {
      const fin = k === pieces.length - 1 ? done : () => { };
      const it = { done: fin }; it.guard = setTimeout(() => { const i = ws.pending.indexOf(it); if (i >= 0) ws.pending.splice(i, 1); fin(); }, 4000 + piece.length * 120);
      ws.pending.push(it);
      ws.send(JSON.stringify({ type: 'Speak', text: piece })); ws.send(JSON.stringify({ type: 'Flush' }));
    });
  },
  browserSay(who, text, done) {
    if (!('speechSynthesis' in window)) { setTimeout(done, 400 + text.length * 50); return; }
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.35; u.onend = done; u.onerror = done;
    let f = false; const fin = () => { if (f) return; f = true; this.browserSpeaking = false; done(); };
    this.browserSpeaking = true; u.onend = fin; u.onerror = fin; setTimeout(fin, 2500 + text.length * 110);
    speechSynthesis.speak(u);
  },
  playUtterance(parts, done) {
    // join the whole line first, so network gaps can't chop it up
    let n = 0; for (const p of parts) n += p.byteLength;
    let u8 = new Uint8Array(n), o = 0; for (const p of parts) { u8.set(new Uint8Array(p), o); o += p.byteLength; }
    if (u8.length >= 44 && u8[0] === 82 && u8[1] === 73 && u8[2] === 70 && u8[3] === 70) u8 = u8.subarray(44);
    if (u8.length % 2) u8 = u8.subarray(0, u8.length - 1);
    if (!u8.length) { done(); return; }
    const pcm = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length));
    const buf = this.ctx.createBuffer(1, pcm.length, 24000), ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    // 6 ms fade in/out removes clicks at the edges
    const f = Math.min(144, pcm.length >> 2); for (let i = 0; i < f; i++) { ch[i] *= i / f; ch[pcm.length - 1 - i] *= i / f; }
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.03, this.playEnd + 0.04); s.start(t); this.playEnd = t + buf.duration;
    tr('audio_start', { in_ms: Math.round((t - this.ctx.currentTime) * 1000), dur_ms: Math.round(buf.duration * 1000) });
    if (this.tHeard) { this.lastLag = (performance.now() - this.tHeard) / 1000 + (t - this.ctx.currentTime); this.tHeard = null; }
    setTimeout(done, (this.playEnd - this.ctx.currentTime) * 1000 + 20);
  },
  playing() { return !!this.browserSpeaking || (!!this.ctx && this.playEnd > 0 && this.playEnd + 0.35 > this.ctx.currentTime); },
  diag() {
    const d = document.getElementById('diag'); if (!d || !this.active) return;
    let lvl = 0;
    if (this.an) { const a = new Uint8Array(this.an.fftSize); this.an.getByteTimeDomainData(a); let m = 0; for (const v of a) m = Math.max(m, Math.abs(v - 128)); lvl = Math.min(8, Math.round(m / 8)); }
    const bars = '\u2588'.repeat(lvl) + '\u2591'.repeat(8 - lvl);
    const stt = !this.stt ? 'off' : ['connecting', 'connected', 'closing', 'closed ' + (this.sttClose || '')][this.stt.readyState];
    const tts = ['lookout', 'nav', 'helm'].filter(r => this.tts[r] && this.tts[r].readyState === 1).length;
    d.textContent = `Mic ${bars} (${(this.micLabel || '?').replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 28)}) · Audio ${this.ctx ? this.ctx.state : 'none'} · Ears ${stt} (${this.sent || 0} sent, ${this.msgs || 0} back) · Voices ${tts}/3${this.lastLag != null ? ' · Last reply ' + this.lastLag.toFixed(1) + ' s' : ''}${this.playing() ? ' · team talking' : ''}${this.muted ? ' · muted' : ''}`;
  },

  setMute(m) { this.muted = m; const b = el('bCallMute'); if (b) { b.setAttribute('aria-pressed', m); b.textContent = m ? 'Unmute' : 'Mute'; } if (this.active) this.status(m ? 'Call on · muted' : 'Call on · listening', 'ok'); },
  fail(msg) { addLog('sys', msg); this.stop(); this.status('Call off', 'bad'); },
  stop() {
    if (!this.active) return;
    this.active = false; clearInterval(this.gate); clearInterval(this.diagT);
    try { this.stt && this.stt.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { }
    try { this.stt && this.stt.close(); } catch (e) { }
    Object.values(this.tts).forEach(ws => { try { ws.close(); } catch (e) { } }); this.tts = {};
    try { this.node && this.node.disconnect(); } catch (e) { } this.node = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null;
    document.body.classList.remove('incall'); this.status('Call ended', ''); this.heard('');
  }
};

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
    drill_time: fmtT(S.t), cpa_trigger_cables: S.trigger != null ? r1(S.trigger * 10) : null, margins: { cpa_cables: 2.5, bow_crossing_cables: 8 }, contacts
  };
}

/* ---------- microphone choice ---------- */
async function listMics() { try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch (e) { return []; } }
async function pickMic() {
  const mics = await listMics(), saved = store.get(K.mic);
  if (saved && mics.some(m => m.deviceId === saved)) return saved;
  const built = mics.find(m => /built-?in|macbook|internal/i.test(m.label));
  return built ? built.deviceId : '';
}
async function fillMics() {
  const sel = el('inMic'); if (!sel) return;
  const mics = await listMics(), cur = await pickMic();
  sel.innerHTML = '';
  if (!mics.length || !mics.some(m => m.label)) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Default microphone (names appear after first use)'; sel.appendChild(o); return; }
  for (const m of mics) { const o = document.createElement('option'); o.value = m.deviceId; o.textContent = m.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/i, ''); if (m.deviceId === cur) o.selected = true; sel.appendChild(o); }
}

/* ---------- setup UI ---------- */
function initUI() {
  const box = el('callSetup'); if (!box) return;
  box.hidden = false;
  const refresh = () => {
    const dg = !!store.get(K.dg), cl = !!store.get(K.cl);
    el('dgState').textContent = dg ? 'saved' : 'not set'; el('clState').textContent = cl ? 'saved' : 'not set';
    el('dgState').className = 'kstate ' + (dg ? 'ok' : ''); el('clState').className = 'kstate ' + (cl ? 'ok' : '');
    el('optCall').disabled = !dg; if (!dg) el('optCall').checked = false;
  };
  el('optCall').checked = !!store.get(K.dg);
  el('bSaveDg').onclick = () => { const v = el('inDg').value.trim(); if (v) { store.set(K.dg, v); el('inDg').value = ''; el('optCall').checked = true; refresh(); } };
  el('bSaveCl').onclick = () => { const v = el('inCl').value.trim(); if (v) { store.set(K.cl, v); el('inCl').value = ''; refresh(); } };
  el('bClearKeys').onclick = () => { [K.dg, K.cl].forEach(k => store.set(k, '')); refresh(); };
  const sel = [['inModel', K.model], ['inVLook', K.vLook], ['inVNav', K.vNav], ['inVHelm', K.vHelm]];
  for (const [id, k] of sel) { const s = el(id); if (store.get(k)) s.value = store.get(k); s.onchange = () => store.set(k, s.value); }
  el('bCallMute').onclick = () => VOICE.setMute(!VOICE.muted);
  if (el('optEar')) { el('optEar').checked = earOn(); el('optEar').onchange = () => store.set(K.ear, el('optEar').checked ? '1' : '0'); }
  fillMics(); el('inMic').onchange = () => store.set(K.mic, el('inMic').value);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', fillMics);
  refresh();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();
})();
