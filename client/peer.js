// Connects to the other player, through the relay only until there's a direct WebRTC data channel. That channel is unordered with no
// retransmits, which suits inputs: a lost packet is covered by the next, and waiting for it would only add delay.

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
    let pc = null, pending = [], remoteSet = false, info = null;
    const signal = (data) => ws.send(JSON.stringify({ t: 'signal', data }));
    const fail = (why) => { try { ws.close(); pc?.close(); } catch { /* already gone */ } reject(new Error(why)); };
    const open = (dc) => {
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        ws.close();
        const peer = { ...info, send: (b) => { if (dc.readyState === 'open') dc.send(b); }, onPacket: () => {}, onClose: () => {}, close: () => { dc.close(); pc.close(); } };
        dc.onmessage = (e) => peer.onPacket(e.data);
        dc.onclose = () => peer.onClose();
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') peer.onClose(); };
        resolve(peer);
      };
    };
    const onSignal = async (d) => {
      if (d.sdp) {
        await pc.setRemoteDescription(d.sdp);
        remoteSet = true;
        for (const c of pending) await pc.addIceCandidate(c);
        pending = [];
        if (d.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); signal({ sdp: pc.localDescription }); }
      } else if (d.ice) {
        if (remoteSet) await pc.addIceCandidate(d.ice); else pending.push(d.ice);
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room, build, hello }));
    ws.onerror = () => fail('could not reach the relay');
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
        pc.onicecandidate = (ev) => { if (ev.candidate) signal({ ice: ev.candidate }); };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fail('could not connect directly to the other player'); };
        if (m.seat === 0) {
          open(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
          await pc.setLocalDescription(await pc.createOffer());
          signal({ sdp: pc.localDescription });
        } else pc.ondatachannel = (ev) => open(ev.channel);
      } else if (m.t === 'signal') await onSignal(m.data);
    };
  });
}
