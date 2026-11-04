# Blade Symphony Duel: standalone server and client

A new, dependency-free reimplementation of duel mode. The Node server runs an authoritative 64-tick
simulation; the browser client renders with WebGPU. All assets and scripts are read at runtime from
your own install, and nothing from the game is copied here except `shared/cvars_all.json`, a table of
cvar names, defaults and help text extracted from `server.dll`.

This does **not** use or connect to the original `client.dll`/`server.dll`, and it can't join official servers.

## Run

    node server/main.mjs --game "<install>" --bot                  # practice against a bot on duel_temple
    node server/main.mjs --game "<install>" --map duel_winter      # no bot: walk around until a second person joins

`<install>` is your Blade Symphony folder, the one holding `berimbau`. You can leave out `--game` only if this repo sits two levels within that folder...ex "./Blade Symphony/some_folder/another_folder/bsdueljs". I should probably fix this but that is where I started relatively speaking as a current working directory and here we are.

Open http://localhost:27015 in a WebGPU browser, pick a character, and confirm. You start out watching: press `R` to join the arena's queue, then click into the window to
capture the mouse. Other options: `--port`, `--host`.
Maps: duel_temple, duel_monastery, duel_castle, duel_district, duel_winter, duel_box, duel_practice_box.

The server listens on all network interfaces by default so a friend on your LAN can join. Anyone who
can reach the port can download files from your game folder. It has no authentication: use
`--host 127.0.0.1` for solo play, and don't expose it to the internet.

Controls: WASD move (also picks the attack direction), Mouse1 attack (hold to charge), Mouse2 block,
1/2/3 fast/balanced/heavy, Space jump, Ctrl roll, Shift shuffle, Q grab (press while grabbed to break free), Alt walk.
E throw, 4 sheathe, B bow, C flourish, V taunt, T sit, R join or leave the queue, M customize, Tab scoreboard, Esc pause menu, mouse wheel next or previous stance. These are the defaults in the game's `cfg/config_default.cfg`, and can be rebound in the pause menu.

## Layout

| path | what |
|---|---|
| `shared/rollback.js`, `simstate.js` | peer to peer rollback, without any networking yet: predicting, rewinding, pacing, desync checks; and the game state as a value to save, restore and hash |
| `shared/snapshot.js` | what clients draw from, built from a world |
| `shared/detmath.js` | math that gives the same bits in every JS engine, used by everything the sim computes |
| `shared/combat.js` | port of a separate C++ rewrite of the combat rules, which isn't in this repo; bit-identical to it |
| `shared/sim.js` | movement, action state machine, sword tracers, duel rounds |
| `shared/bsp.js`, `mdl.js`, `kv.js`, `gamedata.js` | game file formats and script loading |
| `shared/bot.js` | practice bot |
| `server/main.mjs` | HTTP, WebSocket, game loop |
| `client/` | WebGPU renderer, VTF decoding, input, HUD, audio, third person camera (`camera.js`), pause menu (`pausemenu.js`, `settings.js`), a peer to peer match (`p2pgame.js`, `peer.js`) |
| `p2p/relay.mjs` | introduces two peers, and nothing else |
| `tests/` | see below |

## Tests

| command | checks |
|---|---|
| `node tests/combat_diff.mjs 20000` | JS rules vs native C++, all 6 rules, bit for bit. Needs `clang++` and that C++ rewrite at `../rewrite/combat` beside this repo, so it won't run from a fresh clone |
| `node tests/walk_check.mjs "<install>"` | spawns clear, and paths walkable in every arena of every duel map |
| `node tests/anim_check.mjs "<install>"` | blended root motion matches real movement in 8 directions, every character and stance; stride scales with speed |
| `node tests/move_check.mjs "<install>"` | animation clocks run in real time at the game's playback rate; shuffle, roll and throw timing and travel |
| `node tests/sim_check.mjs "<install>"` | headless duel on real game data |
| `node tests/ragdoll_check.mjs "<install>"` | every character's ragdoll settles on a real map, stays connected and above the floor |
| `node tests/prop_check.mjs "<install>"` | static prop hulls agree with their models' bounds, and traces stop on them |
| `node tests/exposure_check.mjs "<install>"` | auto exposure's direction, the map's limits, and the bright-pixel search |
| `node tests/hit_check.mjs "<install>"` | a tapped attack on a stationary fighter lands across one continuous band of ranges, every character and stance |
| `node tests/particle_check.mjs "<install>/berimbau"` | every dispatched effect runs on real data, emits, and finishes; the effects maps place are implemented and stay finite |
| `node tests/queue_check.mjs "<install>"` | arena queues on a three-arena map: who plays, order after a win, loss and draw, leaving, bots, arenas not touching, and one alone walking around |
| `node tests/sword_check.mjs "<install>"` | every sword in the catalog lies along its grip when posed as it's held |
| `node tests/dash_check.mjs "<install>"` | the charge dash: when it's allowed, what it does, and the vulnerable time after it |
| `node tests/preview_check.mjs "<install>"` | the attack preview: the attack it names, its path, fades and target highlight |
| `node tests/wall_check.mjs "<install>"` | wall run, slide, wall jump and run limit, plus throwables: timing, hits, blocks, cancel and delay |
| `node tests/options_check.mjs "<install>"` | the per-fighter input options: double tap shuffle, attack + block grab, and the input buffer |
| `node tests/detmath_check.mjs` | `shared/detmath.js` stays within 1-3 units in the last place of the engine's own functions, special values included, and uses only what IEEE 754 defines |
| `node tests/rollback_check.mjs "<install>"` | save and restore lose nothing; fights that keep rewinding match straight runs bit for bit; two peers over simulated latency, jitter, loss and a late start agree, and match a replay of their inputs; the deepest rewind fits in a tick |
| `node tests/p2p_check.mjs "<install>" [seconds] [ms] [loss]` | a real match over real WebRTC through the real relay, Chrome against Firefox with added lag and loss, no renderer: rollbacks happen and state hashes agree across engines |
| `PWDIR=<playwright dir> node tests/p2p_match.mjs "<install>" <prefix>` | two full clients with the renderer find each other through the relay and fight with real key and mouse events: same fight, no desync, no page errors |
| `node tests/hosted_check.mjs "<install>"` | `--hosted`: nothing without the token, only the folders the client reads with it, encoded path tricks refused, relay behind the token too |
| `node tests/determinism_check.mjs "<install>"` | seeded fights replay identically in Node, Chrome and Firefox: the whole game state, bit for bit, every eighth tick. Names the first field that differs. What rollback rests on |
| `node tests/gesture_check.mjs "<install>"` | bow, flourish, taunt, sit and sheathe: what starts them, their timing and lockouts, and that the hand ends a sheathe at the attachment the sword moves to |
| `node tests/jiggle_check.mjs "<install>/berimbau"` | jiggle bones hold length and limits, settle the same at any frame rate, and reset after a gap |
| `node tests/net_check.mjs "<install>"` | full match between two real WebSocket clients; path traversal rejected |
| `PWDIR=<playwright dir> node tests/browser_match.mjs "<url>?nolock=1&ready=1" <prefix>` | full match in a browser with real key and mouse events |

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
| attack preview (`TracerPreview`) | the local fighter, alive: the attack the stance, keys and string would start, or the one being charged or swung | read from `client.dll`, `bb_tracer_preview_ps20b`; the part up to an enemy on the path turns orange |
| charge overlay (`bb_charge`) | while charging | ported from shader bytecode; how it fades after release is inferred |

**Approximate:** blending is gamma-space with a correction for additive light, because the renderer has no HDR target or bloom. Particle lighting tint, second sprite sequences and frame blending are skipped. Particles that attach to a model use bone positions rather than hitboxes. The character color is the first `colorlist` entry for both the charge and the trail.

**Map effects:** `info_particle_system` entities that start active or are started by the map's `logic_auto` run from the game's manifest, with `cpointN` as their control points. Effects other map logic starts later don't run. `Oscillate Vector`'s step size and `emit noise`'s noise function are inferred.

**Water:** a port of `water_ps30`'s flow map, fresnel and refraction, plus `Refract` world materials such as the winter waterfall. The live game reflects a second render of the scene; here the reflection is the material's cubemap, so characters and nearby geometry don't appear in it. Underwater fog's distance and the distortion fading with it are inferred, and animated normal maps hold their first frame.

**Not done:** `string_reset`, footstep and slide dust, sword glows (cosmetic), `env_sprite`.

## Arenas and spectating

Each `berimbau_duel` on a map runs its own queue and match at the same time (`Duel` in `shared/sim.js`). Fighters only touch others in their arena. Joining the server spectates; `R` (`vs_ready`) joins or leaves the queue of the arena you're watching. One alone can walk around the arena, with no timer on screen, until a second person queues. A match takes the front two. When it ends the winner goes to the front and the loser to the back, a draw sends both to the back, read from `server.dll`. People don't wait behind bots, and with `--bot` anyone alone in a queue gets one. Add `?ready=1` to the URL to queue on joining.

Holding `Tab` shows every arena in three columns, each with a live view through its camera (one arena renders per frame, without particles, like the game): who's playing with wins-losses and ping, who's queued, who's watching, with Join and View buttons while you have a cursor. Watching: `Space` opens the controls from `spectator_controls.res` (view, player, arena, join, customize), the arrow keys change arena, and the camera is the arena's `berimbau_spectator_camera` with the game's FOV and easing, or a chase view of a fighter.

**Inferred:** the attack preview restarting the string with `bb_string_reset_time`, its feathering as a plain 50-unit distance, the preview texture's size and where the status line and text rows sit in a scoreboard column, where the "current match" and "up next" panel sits, which camera an arena with two uses (the first), that the duel camera holds the entity's angles, a second person ending a bot match on the spot, and `R` ending a bot match rather than waiting it out. **Not done:** 2v1 and 2v2 arenas, tournament mode (`vs_queue_mode`), and duel replays (`vs_duel_replay_time`).

## Outfits

`client/customize.js` recreates the customization screen as the start menu, and `M` opens it in a match. Its layout is `resource/ui/basemodui/customization.res`, the preview uses that file's camera and lights, and the sword wheel is read from `client.dll`. Everything is unlocked. Choices made in a match take effect at the next round ([I]), and persist in the browser. The backdrop, the fighter's facing and the sword groups (one per type) are inferred; glow, chat color and emblems can be picked or aren't offered but don't render yet, and an outfit color sets the charge, the trail and the tint on materials with the `PlayerTint` proxy.

Skin, mask, cape and one attachment per slot come from `scripts/items.json`, chosen on that screen or with `?skin= ?mask= ?cape= ?arms= ?back= ?chest= ?legs=` (item ids). Attachments are a body group on the fighter or a model of their own, merged by bone name. Capes hang from the fighter's `anim_cape` attachment. Jiggle bones on capes and mask hair are `shared/jiggle.js`, read from `client.dll`, with each model's own parameters.

The fighter models have no heads, so a mask always shows. That the default is `models/masks/default_<character>` is inferred from the names. Masks and capes don't collide with anything, and workshop items aren't loaded.

## Peer to peer rollback (experimental)

Two people play a duel directly, with no server in the fight. Each browser runs the whole sim and sends only inputs. The other player's inputs are guessed until they arrive, and a wrong guess rewinds and plays forward again, so your own moves respond straight away. It's on the `p2p-rollback` branch.

    node p2p/relay.mjs                                           # one of you, or anywhere both can reach; it only introduces you
    node server/main.mjs --game "<install>"                      # each player, from their own install

Then each opens `http://localhost:27015/?p2p=<room>&relay=ws://<relay address>:27016` with the same room name. Across the internet, add `&stun=stun:<host>:<port>`. The connection is direct, so each player learns the other's IP address.

Input delay defaults to 2 ticks (31 ms) and the rollback limit to 8 (125 ms), about the same as Slippi's 2 frames and, from memory, 7 frames at 60 fps. `&delay=` sets a player's own delay, 0 to 8, and `&rollback=` their own limit, 1 to 16; the two players needn't match. Past the limit the game holds still rather than making a larger correction. The client draws the newest tick with no blending, so fighters move at 64 updates a second on any display, while the camera follows each drawn frame.

The relay refuses to pair people whose game files or sim code differ, since those would desync. The sim's math goes through `shared/detmath.js` and its random numbers through `World.random`, because the spec leaves `Math.sin` and friends up to each engine: Firefox and V8 disagree on the last bit, and so do different versions of V8. Anything new in the sim has to keep to that, and `determinism_check` names the field if it doesn't. Anything on a fighter counts as saved and compared state unless `simstate.js` says otherwise.

**Settled by test:** Node, Chrome and Firefox replay fights identically; save and restore lose nothing; Chrome against Firefox over real WebRTC with added lag and loss agree on every state hash; two full clients fight each other. **Not tested:** real networks (everything so far ran on one machine, with Chrome's mDNS hiding switched off and Firefox's equivalent too, so ordinary browsers on a LAN may behave differently), Safari, ARM CPUs, maps other than duel_temple, wall moves in a rollback, and Firefox with the renderer.

**Not done:** a hit taken back by a rollback has already played its sound and sparks, and nothing retracts them, though `takeEvents` reports it. A desync is detected and reported but not repaired. There's no TURN, so some networks can't connect. Loadouts and input options are fixed when the match starts. A match repeats until someone leaves, with no lobby. The other player's tab in the background holds up the game after a quarter of a second.

### Hosting a private test

One server can give a few people everything, so they only need a link: `node server/main.mjs --hosted --game <install> --map duel_temple`. It runs no fights. It serves the page and only the game folders the client reads, and introduces peers on `/relay`. Everything needs the token, printed at startup, or set with `--token` or `BSDUEL_TOKEN`. The link carries it once, and a cookie after that.

This hands out the game's files, so it's for private testing: don't post the link. WebGPU needs HTTPS, so it stays on localhost behind a proxy. On a VPS with a domain:

    steamcmd +force_install_dir /srv/bladesymphony +login <steam account> +app_update 225600 validate +quit
    node server/main.mjs --hosted --game /srv/bladesymphony --map duel_temple

    # /etc/caddy/Caddyfile: Caddy gets the certificate itself, and passes WebSockets through
    your.domain {
      encode gzip
      reverse_proxy localhost:27015
    }

The steamcmd download may need the Windows depot on Linux (`+@sSteamCmdForcePlatformType windows` before the login). That and the login are untested.

## Pause menu and options

`Esc` opens `client/pausemenu.js`, built at runtime from the game's `ingamemainmenu_mp.res`, `keyboardmouse.res`, `keybindings` (`scripts/kb_act.lst`), `video.res`, `advancedvideo.res`, `berimbaugameoptions.res` and `cameraoptions.res`, with the game's strings and slider ranges. Settings keep their cvar names and persist in the browser (`client/settings.js`), with defaults read from `client.dll`. There's no pausing, since it's a live match. Options with nothing behind them here stay on screen, turned off, and a token no string table has (`GameUI_KeyboardMouse`) reads as its own words [I].

**Camera:** `client/camera.js` ports `client.dll`'s third person camera step by step: offsets, the roll and shuffle ease, jump trail and tilt, ground lead and FOV, hitstop push, action bank, body motion from the `chest` attachment, lag, and the eased floor and wall collision. The server gets the camera's angles plus `bb_cam_thirdperson_pitch_viewoffset`, so the view sits 20 degrees below the aim. FOV is Source's width of a 4:3 view. **Inferred:** the eye at 64 units, from Source's default view vectors. **Not ported:** a clamp that keeps the point the camera looks from within two bounds read from the fighter (180280065, the `0xac0` and `0xac8` virtuals), which weren't identified. If they're the 72-unit hull, Camera Height above +8 does nothing in the live game and does here. Also `bb_cam_master_turn_animation_speed`'s turn animation, and every other camera mode.

**Input:** sensitivity, `m_yaw`, `m_pitch` (reverse mouse), `m_customaccel` 3 with its exponent, and raw input as the browser's `unadjustedMovement` where it has it. Double tap shuffle (`bb_sde`) and attack + block grab (`bb_gae`) and `bb_ibt` go to the server per fighter, as the game's do. Bots and tests default to no double tap. Next and previous stance run fast, balanced, heavy and wrap [I: the button handling is read, the order isn't].

**Video:** brightness is an SVG filter applying x^(2.2 / `mat_monitorgamma`) [I: Source's usual ramp, not read from shaderapi]. Resolution sets the render size and the aspect ratio filters that list [I: the list is common modes, not the display's]. Display mode is the browser's fullscreen, without a borderless entry. `cl_csm_enabled_user` turns the cascades off. Filtering is `mat_forceaniso` and takes effect on reload, since materials bind their sampler as they load. **Off, nothing behind them:** power savings, motion blur, ambient occlusion, tonemapping (`bb_fancy_tonemapping` isn't ported), antialiasing, vsync, multicore, shader, effect and model detail, paged pool, streaming, audio, controller, developer console. Model detail's `gpu_mem_level` lives in encrypted `.ekv` files.

**Game options:** attack preview, input buffer, and camera options work. FFA and duel outlines, health bars, the summary screen, spray and workshop are off.

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
* stance changes, block hold, attacker recoil on a block
* client-side crossfade timing, and walking borrowing the run cycle's upper body
* the move input the charge speed scales (`CHARGE_INPUT` in `sim.js`: the formula is recovered, but this one value is a judgment call)

**Not ported yet in blade collision:** which yaw a blade uses during a rotation lock (the model's, assumed), and the foil guard box's second axis, which the game leaves unset.

**Wall moves:** running, the transition, sliding and both wall jumps follow `server.dll`. Only the first trace of the wall run's normal is ported (the game refines it with two more), that the ground clears the run count is inferred, and so is a slide or flip ending on landing.

**Charge dash:** roll while charging an attack past tier 2 on the ground dashes instead (`AirDash`), dropping the charge. It ignores the roll's cooldown, and has its own of `bb_dash_delay`, 3.25s. For all of that you take `bb_dash_damage_multiplier`, 1.5x, from swords, grabs and throwables, can't block throwables, and a rim beats on you (`$CHARGEEXTRARIMLIGHT*`). Its color is 255 79 79, far past 1, so on the backbuffer format it clamps to a pale rim [I: not compared with live]. Its strength is 0.75 or 1.5 by a game mode check that wasn't identified [I: 0.75].

**Throwables:** `E` throws the character's type from `scripts/throwabletypes.txt`. Flight, homing, damage and blocks follow `server.dll`; the star's lead on a moving target is a simple estimate, and blades don't deflect it in the air yet (`bounds_tracer`). It plays the model's own `ACT_FLY` tumble at the model's size, since the game never reads the script's `scale` key. That its +X points along the flight is inferred, and decals aren't drawn.

**Gestures:** bow, flourish, taunt and sit follow `server.dll`: they start once no lock is running and repeat while held, flourish and taunt play the stance's animation, and sitting holds the sit down's last frame until a move key or one of the buttons the game lists (not roll, shuffle or throw, which act from the seat as they would from standing). Bow, flourish and taunt lock movement and turning. Taunt and bow leave a sword sheathed; flourish draws it at once.

**Sheathing:** `4` puts the sword away or draws it, as an upper layer, so you can keep moving. The time is always the back animation's, on any sword, and a hip sword's animation is fitted to it, which follows a remote client's view; the live game may predict the local fighter's differently [I]. During it you can't roll, grab, wall run, block, throw or gesture, though you can shuffle. An attack or feint draws at once, cutting it off. Sheathed you can't block, and run on the plain `ACT_IDLE`, `ACT_WALK` and `ACT_RUN` cycles. That the duel isn't one of the two modes with the sprint cycle and sheathed damage multiplier is inferred from their help text. The item's `scabbard_attach_hip` picks the fighter's `anim_sheathe_hip` or `anim_sheathe_back`. The scabbard's `anim_sheathe` always sits there, and the sword's `sword_grip` does too once it's all the way in; the animations end there, within a unit. Three swords play their own sheathe sequences, timed by the fighter's layer here [I]. `custom_sheathe_sound` isn't played.

**Ragdolls:** bodies, masses, damping and joint limits are the model's `.phy`, but the solver is `shared/ragdoll.js`, not Havok, so how a body falls is approximate, and it collides with the world only, as capsules.

**Not implemented:** client-side prediction (fine on LAN, will feel laggy over the internet), music,
ledge climbing and vaulting, 3D skybox.

**Shaders:** world surfaces are ported from `lightmappedgeneric_ps30` (bumped and self-shadowed lightmaps, cubemaps, seamless mapping) and the sky from `sky_ps20b`. Exposure follows the game's histogram rule (`shared/exposure.js`), with each map's `env_tonemap_controller` limits. Sun shadows are the game's cascaded shadow maps (three cascades to 400 units, split as in `client.dll`), which take the sun's share out of the lightmap using the per-page bytes each map stores. How a cascade blends at its edge, fade distance and bias are approximate. Still missing on the world: bloom, `$blendmodulatetexture`, `$phong`, `$lightwarptexture` and detail blend modes other than mod2x; unpatched `env_cubemap` uses the map's default cubemap. Characters use `phong_ps30` with the map's ambient cubes and world lights; static props use their baked `.vhv` colors with `phong_ps30` or `vertexlit_and_unlit_generic_bump_ps30`. Which lights a model keeps follows Source's usual rules rather than a read of the engine. `lightmappedreflective` surfaces aren't ported.

**Swords:** any character can use any sword from the game's catalog (`scripts/items.json`), chosen on the join menu, which starts on the one the game
gives that character. The sword and its scabbard are the item's own models and skin. The sword follows the fighter's `sword_grip`, with any other bones at the first frame of the model's first sequence [I]; a scabbard always stays on the body, on the mount under Sheathing, and additive parts such as glows aren't drawn. The type sets damage, charge, multi-hit rate and block tech: longsword and
scimitar block, foil guards, jian intercepts. Katana feints: the block button charges the swing the stance and string would give, and letting go plays it with no tracer on a cut lock. It can also cut off a swing before its second blade sample or just after its last, which carries on the same animation with the time spent taken off that cut lock. Every feint restarts the string. Blade
length is the game's default 40 units for all types.

## License

MIT, see [LICENSE](LICENSE). That covers the code in this repo. Blade Symphony and its files belong to their owners, and you need your own copy of the game to run this.
