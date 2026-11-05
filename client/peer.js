// Connects to the other player, through the relay only until there's a direct WebRTC data channel. That channel is unordered with no
// retransmits, which suits inputs: a lost packet is covered by the next, and waiting for it would only add delay.

// How long to try for. Longer than the 15 seconds a browser takes to report that the addresses it tried didn't answer, so that gets to say so first.
const CONNECT_MS = 20000;

/**
 * @param {object} o Options.
 * @param {string} o.relay The relay's WebSocket address.
 * @param {string} o.room The room two people agreed on.
 * @param {string} o.build A hash of this peer's game files and sim code.
 * @param {object} [o.hello] What the other peer needs to know, such as a character and sword.
 * @param {Array} [o.iceServers] STUN or TURN servers. Without any, only peers that can reach each other directly can connect.
 * @param {function(string): void} [o.onStatus] Told what's going on, for showing.
 * @returns {Promise<object>} seat, seed, other (their hello), send(ArrayBuffer), onPacket (set this), onClose (set this), close().
 */
export function connectPeer({ relay, room, build, hello = null, iceServers = [], onStatus = () => {} }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay);
    let pc = null, pending = [], remoteSet = false, info = null, settled = false, timer = null;
    // The kinds of address each side put forward, for saying why it didn't connect. A hidden local address ends in .local.
    const offered = new Set(), received = new Set();
    const kind = (c) => { const p = String(c?.candidate ?? '').split(' '); return `${p[p.indexOf('typ') + 1] || '?'}${/\.local$/.test(p[4] ?? '') ? ' (hidden)' : ''}`; };
    const signal = (data) => ws.send(JSON.stringify({ t: 'signal', data }));
    const fail = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); pc?.close(); } catch { /* already gone */ }
      reject(new Error(why));
    };
    // Both see the reason, since the one that gives up first leaving looks like them walking away to the other
    const noRoute = () => {
      const list = (s) => [...s].join(', ') || 'none';
      const why = `could not connect directly to the other player (one side offered: ${list(offered)}; received: ${list(received)})${iceServers.length ? '' : '. No STUN server is set, so this only works if the browsers can reach each other on a local network or VPN'}`;
      if (ws.readyState === 1) signal({ failed: why });
      fail(why);
    };
    const open = (dc) => {
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        settled = true;
        clearTimeout(timer);
        // Leaving the relay now isn't leaving the fight, and the other peer may be a moment from connecting
        ws.send(JSON.stringify({ t: 'linked' }));
        ws.close();
        const peer = { ...info, send: (b) => { if (dc.readyState === 'open') dc.send(b); }, onPacket: () => {}, onClose: () => {}, close: () => { dc.close(); pc.close(); } };
        dc.onmessage = (e) => peer.onPacket(e.data);
        dc.onclose = () => peer.onClose();
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') peer.onClose(); };
        resolve(peer);
      };
    };
    const onSignal = async (d) => {
      if (d.failed) fail(String(d.failed));
      else if (d.sdp) {
        await pc.setRemoteDescription(d.sdp);
        remoteSet = true;
        for (const c of pending) await pc.addIceCandidate(c);
        pending = [];
        if (d.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); signal({ sdp: pc.localDescription }); }
      } else if (d.ice) {
        received.add(kind(d.ice));
        if (remoteSet) await pc.addIceCandidate(d.ice); else pending.push(d.ice);
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room, build, hello }));
    ws.onerror = () => fail('could not reach the relay');
    // Once there's a connection under way it may not need the relay any more, and the timer covers it if it did
    ws.onclose = () => { if (!pc) fail('lost the relay while waiting for the other player'); };
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'waiting') onStatus('Waiting for the other player...');
      else if (m.t === 'full') fail('that room already has two players');
      else if (m.t === 'mismatch') fail(`your game files or sim code differ from the other player's (${m.yours} and ${m.theirs})`);
      else if (m.t === 'gone') fail('the other player left');
      else if (m.t === 'paired') {
        onStatus('Connecting...');
        info = { seat: m.seat, seed: m.seed, other: m.other };
        pc = new RTCPeerConnection({ iceServers });
        // ICE only reports failure if it had an address to try. With none, such as a hidden local address from another network, it waits forever.
        timer = setTimeout(noRoute, CONNECT_MS);
        pc.onicecandidate = (ev) => { if (ev.candidate) { offered.add(kind(ev.candidate)); signal({ ice: ev.candidate }); } };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') noRoute(); };
        try {
          if (m.seat === 0) {
            open(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
            await pc.setLocalDescription(await pc.createOffer());
            signal({ sdp: pc.localDescription });
          } else pc.ondatachannel = (ev) => open(ev.channel);
        } catch (err) { fail(`could not set up the connection: ${err.message}`); }
      } else if (m.t === 'signal') {
        // A step that throws here would otherwise leave both peers waiting on an answer that's never coming
        try { await onSignal(m.data); } catch (err) { fail(`could not set up the connection: ${err.message}`); }
      }
    };
  });
}
