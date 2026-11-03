# Blade Symphony Duel: standalone server and client

A new, dependency-free reimplementation of duel mode. The Node server runs an authoritative 66-tick
simulation; the browser client renders with WebGPU. All assets and scripts are read at runtime from
your own install, and nothing from the game is copied here except `shared/cvars_all.json`, a table of
cvar names, defaults and help text extracted from `server.dll`.

This does **not** use or connect to the original `client.dll`/`server.dll`, and it can't join official servers.

## Run

    node server/main.mjs --bot                  # practice against a bot on duel_temple
    node server/main.mjs --map duel_winter      # wait for a second human

Open http://localhost:27015 in a WebGPU browser, pick a character, and click into the window to
capture the mouse. Options: `--map`, `--port`, `--bot`, `--game <install dir>`, `--host`.
Maps: duel_temple, duel_monastery, duel_castle, duel_district, duel_winter, duel_box, duel_practice_box.

The server listens on all network interfaces by default so a friend on your LAN can join. Anyone who
can reach the port can download files from your game folder. It has no authentication: use
`--host 127.0.0.1` for solo play, and don't expose it to the internet.

Controls: WASD move (also picks the attack direction), Mouse1 attack (hold to charge), Mouse2 block,
1/2/3 fast/balanced/heavy, Space jump, Ctrl roll, Shift shuffle, Q grab (press while grabbed to break free), Alt walk.
These follow the game's `cfg/config_default.cfg`. E is the game's throwing-weapon key; throwing weapons aren't implemented, so it does nothing here.

## Layout

| path | what |
|---|---|
| `shared/combat.js` | port of `../rewrite/combat`; bit-identical to the C++ rules |
| `shared/sim.js` | movement, action state machine, sword tracers, duel rounds |
| `shared/bsp.js`, `mdl.js`, `kv.js`, `gamedata.js` | game file formats and script loading |
| `shared/bot.js` | practice bot |
| `server/main.mjs` | HTTP, WebSocket, game loop |
| `client/` | WebGPU renderer, VTF decoding, input, HUD, audio |
| `tests/` | see below |

## Tests

| command | checks |
|---|---|
| `node tests/combat_diff.mjs 20000` | JS rules vs native C++, all 6 rules, bit for bit |
| `node tests/walk_check.mjs "<install>"` | spawns clear, and paths walkable in every arena of every duel map |
| `node tests/anim_check.mjs "<install>"` | blended root motion matches real movement in 8 directions, every character and stance; stride scales with speed |
| `node tests/move_check.mjs "<install>"` | animation clocks run in real time at the game's playback rate; shuffle, roll and throw timing and travel |
| `node tests/sim_check.mjs "<install>"` | headless duel on real game data |
| `node tests/ragdoll_check.mjs "<install>"` | every character's ragdoll settles on a real map, stays connected and above the floor |
| `node tests/hit_check.mjs "<install>"` | a tapped attack on a stationary fighter lands across one continuous band of ranges, every character and stance |
| `node tests/particle_check.mjs "<install>/berimbau"` | every dispatched effect runs on real data, emits, and finishes |
| `node tests/net_check.mjs "<install>"` | full match between two real WebSocket clients; path traversal rejected |
| `PWDIR=<playwright dir> node tests/browser_match.mjs "<url>?nolock=1" <prefix>` | full match in a browser with real key and mouse events |

## Effects

The client runs the game's own `.pcf` particle definitions and `.vmt` materials (`shared/pcf.js`, `shared/particles.js`, `client/fx.js`). `tools/vcs_dis.py` disassembles the game's compiled shaders (Windows; uses the OS's `d3dcompiler_47.dll`).

| effect | when | source |
|---|---|---|
| `balanced_hit`, `light_hit`, `heavy_hit` | a hit lands, by attacker stance | read from `client.dll` |
| `wallhit_spark` | blocked attack, blade hits a wall | read from `client.dll` |
| `smoke_ring`, `riposte_forward_fx` | intercept | read from `client.dll` |
| `penetrate_fx`, `smoke_ring` | guard break | read from `client.dll` |
| `smoke_ring`, `penetrate_fx` | blades clash | effects read from `client.dll`; that a clash uses this case is inferred |
| `berimbau_player_charge`, `charge_tier3_forward` | charge reaches tier 2; a tier 3 attack releases | read from `server.dll` |
| `blocking_forward` | parry window (jian) | read from `client.dll` |
| swing trail (`trace_map`) | while the swing's tracer script runs | read from `client.dll`; samples per frame, not per `.bst` entry |
| charge overlay (`bb_charge`) | while charging | ported from shader bytecode; how it fades after release is inferred |

**Approximate:** blending is gamma-space with a correction for additive light, because the renderer has no HDR target or bloom. Particle lighting tint, second sprite sequences and frame blending are skipped. Particles that attach to a model use bone positions rather than hitboxes. The character color is the first `colorlist` entry for both the charge and the trail.

**Not done:** the attack preview (`bb_tracerPreview`, `TracerPreview` shader), `guard_fx` and `feint_fx` (no events from the sim yet), `string_reset`, footstep and slide dust, sword glows (cosmetic), water and map ambience.

## How faithful is it?

`shared/sim.js` tags rules in comments: `[V]` verified, `[R addr]` read from `server.dll` at addr but
not differentially tested, `[I]` inferred.

**Verified against the original:** block, parry, clash, combo scaling, damage, hit outcome.

**Recovered from the binary, not differentially tested:** cvar defaults, input priority, attack direction,
charge and swing flow, tracer sampling and its clock, blade pose (move params, pitch aiming through the spine), whole-unit blade ends, blade hit traces (blade and tip sweep, against the bounding box), the blade clash boxes and the clash window after a swing's script ends, world interrupts, locomotion pose blending and walk/run selection, knockback, recovery table, jump, acceleration, round flow and timings, grab and throw, shuffle and roll delays, root motion, playback rates, charge pose timing, charge acceleration, knockdown and the downed state, multi-hit timing.

**Inferred; likely to feel different from the real game:**
* soft collision between fighters (the original feeds a push through move input at strengths that depend on the action; the sim applies one constant push)
* time-up rule (higher health wins)
* max health of 100 (assumed; not found in the binary)
* stance changes, block hold, combo-string reset timing, attacker recoil on a block
* client-side crossfade timing, and walking borrowing the run cycle's upper body
* the move input the charge speed scales (`CHARGE_INPUT` in `sim.js`: the formula is recovered, but this one value is a judgment call)

**Not ported yet in blade collision:** which yaw a blade uses during a rotation lock (the model's, assumed), and the foil guard box's second axis, which the game leaves unset.

**Ragdolls:** bodies, masses, damping and joint limits are the model's `.phy`, but the solver is `shared/ragdoll.js`, not Havok, so how a body falls is approximate, and it collides with the world only, as capsules.

**Not implemented:** collision with static props (fighters walk through them; world brushes and
displacements do collide), client-side prediction (fine on LAN, will feel laggy over the internet), music,
sword and cape models (a blade matching the hit segment is drawn instead), feints, wall moves, throwing weapons, sheathing, water, 3D skybox.

**Shaders:** world surfaces are ported from `lightmappedgeneric_ps30` (bumped and self-shadowed lightmaps, cubemaps, seamless mapping) and the sky from `sky_ps20b`. Still missing on the world: CSM sun shadows, auto exposure (a fixed scale stands in), `$blendmodulatetexture`, `$phong`, `$lightwarptexture` and detail blend modes other than mod2x; unpatched `env_cubemap` uses the map's default cubemap. Static props and characters still use placeholder lighting rather than `phong` and `vertexlit_and_unlit_generic`, and water, `lightmappedreflective` and `refract` surfaces aren't ported.

**Swords:** any character can use any sword type, chosen on the join menu. The menu starts on the sword the game
gives that character (`scripts/items.json`). The type sets damage, charge, multi-hit rate and block tech: longsword and
scimitar block, foil guards, jian parries. Katana's tech is feint, which isn't built, so it blocks for now. Blade
length is the game's default 40 units for all types.
