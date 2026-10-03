//=============================================================================
// patch.js - port compatibility and memory layer for Fear & Hunger
//-----------------------------------------------------------------------------
// NW.js runs this before any script of the game, through "inject_js_start" in
// package.json. Nothing here edits the player's own files: the www/ folder they
// copy in is read exactly as it came off their install.
//
// Five jobs, in order of how much they matter:
//
//   1. Stub greenworks, without which the game dies before the title screen.
//   2. Keep the decoded audio small enough to fit a 1 GB handheld.
//   3. Render into a buffer the size of the panel instead of 816x624.
//   4. Survive, loudly, when the GPU context goes away.
//   5. Spend the frame on what the player can actually see.
//
// Every knob can be overridden from the launcher with an environment variable,
// which is how a tester narrows down a problem without editing this file.
//=============================================================================

(function () {
    'use strict';

    var GAME_WIDTH  = 816;
    var GAME_HEIGHT = 624;

    var CFG = {
        // Fraction of 816x624 to render into. Measured on a Mali-G31 at 640x480:
        // matching the panel exactly (0.77 here) ran the dungeons at 13-18 fps, while
        // 0.55 held 60. The game puts a fullscreen additive fog layer over 138 of its
        // maps and that is what the GPU chokes on, so this is the biggest single knob
        // on these devices. 0 means match the panel: sharpest, and slowest.
        renderScale: parseFloat(process.env.FNH_RENDER_SCALE || '0.6'),
        // Decoded audio costs duration x rate x channels x 4 bytes. 0 leaves it alone.
        audioHz:     parseInt(process.env.FNH_AUDIO_HZ || '22050', 10),
        // ImageCache limit in megapixels. The game ships 10 (40 MB of RGBA). Cutting
        // this to save memory backfires: every eviction is a fresh read from the SD
        // card, and the card is far more expensive than the RAM saved.
        cacheMp:     parseFloat(process.env.FNH_CACHE_MP || '12'),
        // The intro is 33s of 816x624 VP9, decoded in software on these devices.
        skipVideo:   process.env.FNH_SKIP_VIDEO === '1',
        // Reload at the title screen if the GPU context dies, instead of drawing garbage.
        reloadOnContextLoss: process.env.FNH_NO_GL_RELOAD !== '1',
        // PIXI drops any texture unused for this many frames. rpg_core.js sets it to 1,
        // which means every window, menu and message box is thrown off the GPU the
        // moment it stops being drawn and uploaded again the next time it appears.
        // PIXI's own default is 3600 frames.
        textureGcIdle: parseInt(process.env.FNH_TEXTURE_GC || '600', 10),
        verbose:     process.env.FNH_VERBOSE === '1',
        // Counts and times the three things MV spends its time on when a window opens.
        profile:     process.env.FNH_PROFILE === '1',
        // Logic steps the fixed timestep may run per rendered frame. The game ships
        // TDDP_FluidTimestep, which replaces SceneManager.updateMain with a 1/60
        // accumulator drained in a while loop. The moment a frame costs more than
        // 16.6 ms that loop runs the whole of the map logic twice, which makes the
        // frame longer again, which asks for a third step. It is a cliff with a 0.25 s
        // floor, so up to 15 logic steps can land in one pass, and it is the best
        // explanation anyone has for both the dungeon frame rate and the stalls when
        // a window opens. 1 means never catch up: under load the game runs slower
        // instead of freezing. 0 leaves the plugin's own loop alone.
        maxSteps:    parseInt(process.env.FNH_MAX_STEPS || '1', 10),
        // 0 none, 1 sprites only, 2 sprites and event logic. See section 5.
        cull:        parseInt(process.env.FNH_CULL || '2', 10),
        // Smallest gap in ms between two full page condition refreshes. Hunger and
        // sanity tick constantly here, and every tick re-evaluates the pages of every
        // event on the map. 0 refreshes as shipped.
        refreshMs:   parseInt(process.env.FNH_REFRESH_MS || '50', 10)
    };

    // Counters the frame profiler reads. They live out here because the frame rate
    // work installs on window load, after the plugins, while the profiler installs
    // on DOMContentLoaded.
    var perf = {
        steps: 0, frames: 0, culledEv: 0, seenEv: 0, culledSpr: 0, refreshSkipped: 0,
        keep: null
    };

    var fs = null, logPath = null;
    try {
        fs = require('fs');
        logPath = require('path').join(process.cwd(), 'log-game.txt');
        fs.writeFileSync(logPath, '');
    } catch (e) { /* logging is a nicety, never a reason to fail */ }

    function log(msg) {
        var line = '[' + (performance.now() / 1000).toFixed(1) + 's] ' + msg;
        try { console.log(line); } catch (e) {}
        try { if (fs && logPath) fs.appendFileSync(logPath, line + '\n'); } catch (e) {}
    }

    log('patch.js  nw=' + process.versions.nw + '  chromium=' + process.versions.chromium +
        '  arch=' + process.arch + '  cfg=' + JSON.stringify(CFG));

    //-------------------------------------------------------------------------
    // 1. greenworks
    //
    // js/plugins/Archeia_Steamworks.js is enabled and requires js/libs/greenworks
    // at the top level of the file. That module only ships .node binaries for
    // win32, win64 and macOS, so on aarch64 it resolves to undefined and the next
    // property assignment inside it throws - before the title screen, every time.
    //
    // Handing the plugin an inert object is enough. initAPI() returns undefined,
    // so SceneManager.steamworksInitialized() is false and every SteamManager
    // call short circuits for the rest of the run. The 205 achievement triggers
    // in the game's event data are plugin commands, and MV ignores plugin
    // commands it does not recognise, so nothing else notices. Achievements are
    // the only casualty, and there is no Steam client here to receive them.
    //-------------------------------------------------------------------------
    var steamStub = new Proxy({}, {
        get: function (target, prop) {
            if (prop in target) return target[prop];
            return function () { return undefined; };
        }
    });

    var realRequire = window.require;
    if (typeof realRequire === 'function') {
        window.require = function (id) {
            if (typeof id === 'string' && id.indexOf('greenworks') !== -1) {
                log('greenworks stubbed (' + id + ')');
                return steamStub;
            }
            return realRequire.apply(this, arguments);
        };
    } else {
        log('WARNING: no require() at inject time, the Steamworks plugin will throw');
    }

    //-------------------------------------------------------------------------
    // Failures go to the log rather than to a console nobody is watching.
    //-------------------------------------------------------------------------
    window.addEventListener('error', function (e) {
        // physical_attack_animation.js throws a SyntaxError here on every platform,
        // Windows included: it asks PluginManager for parameters under a name it is
        // not registered with, gets {}, and evals "[object Object]". Upstream bug,
        // harmless, and not worth alarming a tester over.
        // The error is reported against index.html, so the plugin's name only shows
        // up in the stack.
        var where = (e.filename || '') + ' ' + ((e.error && e.error.stack) || '');
        var benign = where.indexOf('physical_attack_animation') !== -1;
        log((benign ? 'known upstream error: ' : 'JS ERROR: ') + (e.message || '?') +
            ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
    });
    window.addEventListener('unhandledrejection', function (e) {
        log('unhandled rejection: ' + e.reason);
    });

    document.addEventListener('DOMContentLoaded', function () {
        if (typeof Graphics === 'undefined' || typeof WebAudio === 'undefined') {
            log('FATAL: engine globals are missing, is www/ really an MV game?');
            return;
        }
        log('engine ' + Utils.RPGMAKER_VERSION + ', webgl=' + Graphics.hasWebGL());

        //---------------------------------------------------------------------
        // 2. Audio memory
        //
        // MV decodes every track to a float32 PCM buffer and holds BGM, BGS and
        // ME at once; shouldUseHtml5Audio() is hardcoded false in 1.6.0, so there
        // is no streaming path to fall back on. The game's longest ambience track
        // is 299 seconds of 48 kHz stereo, which is 109 MB on its own.
        //
        // Chromium decodes to the AudioContext's sample rate, so asking for a
        // lower one shrinks every buffer without touching a single file. Measured
        // on the three longest tracks at once: 292 MB of PCM as shipped, 67 MB
        // with this plus the mono re-encode from tools/optimize_audio.py. Neither
        // half does the job alone - the rate here, the channel count there.
        //---------------------------------------------------------------------
        if (CFG.audioHz) {
            WebAudio._createContext = function () {
                try {
                    this._context = new AudioContext({ sampleRate: CFG.audioHz });
                } catch (e) {
                    log('AudioContext(' + CFG.audioHz + ') refused: ' + e + ', using the default');
                    try { this._context = new AudioContext(); } catch (e2) { this._context = null; }
                }
                log('AudioContext at ' + (this._context ? this._context.sampleRate : 'none') + ' Hz');
            };
        }

        //---------------------------------------------------------------------
        // 3. Render resolution
        //
        // The game is 816x624 and the panel is smaller, so MV is already shrinking
        // the frame on its way to the screen. Rendering straight into a buffer the
        // size of the panel removes that waste: on 640x480 it is 40% fewer pixels
        // for a frame that is, pixel for pixel, the one the player was seeing.
        //
        // _centerElement has to come along, because it sizes the CSS box from
        // element.width, which is no longer the logical width.
        //---------------------------------------------------------------------
        var scale = CFG.renderScale;
        if (!scale) {
            scale = Math.min(window.innerWidth / GAME_WIDTH, window.innerHeight / GAME_HEIGHT);
        }
        scale = Math.max(0.5, Math.min(1, scale));

        if (Math.abs(scale - 1) > 0.01) {
            Graphics._createRenderer = function () {
                PIXI.dontSayHello = true;
                var options = { view: this._canvas, resolution: scale, autoResize: false };
                try {
                    switch (this._rendererType) {
                    case 'canvas':
                        // Kept for completeness. The software renderer core dumps on this
                        // game, so a device that cannot give us WebGL cannot run the port.
                        this._renderer = new PIXI.CanvasRenderer(this._width, this._height, options);
                        break;
                    case 'webgl':
                        this._renderer = new PIXI.WebGLRenderer(this._width, this._height, options);
                        break;
                    default:
                        this._renderer = PIXI.autoDetectRenderer(this._width, this._height, options);
                        break;
                    }
                    if (this._renderer && this._renderer.textureGC) {
                        this._renderer.textureGC.maxIdle = CFG.textureGcIdle;
                    }
                } catch (e) {
                    this._renderer = null;
                    log('renderer creation failed: ' + e);
                }
            };
            Graphics._updateCanvas = function () {
                this._canvas.width = Math.round(this._width * scale);
                this._canvas.height = Math.round(this._height * scale);
                this._canvas.style.zIndex = 1;
                this._centerElement(this._canvas);
            };
            Graphics._centerElement = function (element) {
                element.style.position = 'absolute';
                element.style.margin = 'auto';
                element.style.top = 0;
                element.style.left = 0;
                element.style.right = 0;
                element.style.bottom = 0;
                element.style.width = (this._width * this._realScale) + 'px';
                element.style.height = (this._height * this._realScale) + 'px';
            };
            log('rendering at ' + Math.round(GAME_WIDTH * scale) + 'x' + Math.round(GAME_HEIGHT * scale) +
                ' for a ' + window.innerWidth + 'x' + window.innerHeight + ' screen');
        } else {
            log('rendering at native 816x624');
        }

        // Even when the renderer is left at native scale, the GC setting still applies.
        if (CFG.textureGcIdle && Graphics._renderer && Graphics._renderer.textureGC) {
            Graphics._renderer.textureGC.maxIdle = CFG.textureGcIdle;
        }

        // Where the time actually goes when a menu opens: drawing the text on the CPU,
        // pushing the result to the GPU, or rebuilding a window's nine background parts.
        if (CFG.profile) {
            var stats = { text: [0, 0], upload: [0, 0], parts: [0, 0] };
            function timed(obj, name, slot) {
                var orig = obj[name];
                if (!orig) return;
                obj[name] = function () {
                    var t0 = performance.now();
                    var r = orig.apply(this, arguments);
                    stats[slot][0]++;
                    stats[slot][1] += performance.now() - t0;
                    return r;
                };
            }
            timed(Bitmap.prototype, 'drawText', 'text');
            timed(Bitmap.prototype, 'checkDirty', 'upload');
            if (typeof Window !== 'undefined' && Window.prototype) {
                timed(Window.prototype, '_refreshAllParts', 'parts');
            }
            setInterval(function () {
                log('profile  drawText=' + stats.text[0] + ' calls/' + stats.text[1].toFixed(0) + 'ms' +
                    '  textureUpload=' + stats.upload[0] + '/' + stats.upload[1].toFixed(0) + 'ms' +
                    '  windowParts=' + stats.parts[0] + '/' + stats.parts[1].toFixed(0) + 'ms');
                stats = { text: [0, 0], upload: [0, 0], parts: [0, 0] };
            }, 10000);
            log('profiler on');
        }

        // FNH_FRAMEPROF=1: where a frame actually goes. Measuring only, nothing is
        // changed in how anything renders.
        //
        // The dungeons carry 328 to 464 events each against 7 on the first outdoor map,
        // and MV updates every event on the map every frame whether or not it is on
        // screen. So the question is whether the dungeons are slow because of map logic,
        // because of the sprites that follow it, or because of drawing - and spikes on a
        // single action are a different thing again, usually one frame's worth of
        // loading. This separates the three and names what loaded during a long frame.
        if (process.env.FNH_FRAMEPROF === '1') {
            var acc = { map: 0, sprites: 0, render: 0 };
            var loads = [];
            var frames = 0, slow = 0;

            function wrap(obj, name, slot) {
                if (!obj || !obj[name]) return;
                var orig = obj[name];
                obj[name] = function () {
                    var t0 = performance.now();
                    var r = orig.apply(this, arguments);
                    acc[slot] += performance.now() - t0;
                    return r;
                };
            }
            if (typeof Game_Map !== 'undefined') wrap(Game_Map.prototype, 'update', 'map');
            if (typeof Spriteset_Map !== 'undefined') wrap(Spriteset_Map.prototype, 'update', 'sprites');
            wrap(Graphics, 'render', 'render');

            // One level down: how much of the map's time is the events themselves, how
            // much of the sprite time is characters, and how many of those characters
            // are nowhere near the screen. On a 90x70 map with 344 events the answer
            // decides whether anything can be skipped.
            // Everything here is measured once per frame. Wrapping Game_Event.update or
            // Sprite_Character.update instead would mean 666 timer calls a frame on a map
            // with 333 events, which costs more than the thing being measured - that
            // mistake is why the frame rate fell with every profiled run.
            acc.events = 0; acc.common = 0; acc.refresh = 0; acc.interp = 0; acc.light = 0;
            var refreshes = 0, offscreenPct = 0;

            if (typeof Game_Map !== 'undefined') {
                wrap(Game_Map.prototype, 'updateEvents', 'events');
                wrap(Game_Map.prototype, 'updateInterpreter', 'interp');
                var _refresh = Game_Map.prototype.refresh;
                Game_Map.prototype.refresh = function () {
                    refreshes++;
                    var t0 = performance.now();
                    var r = _refresh.apply(this, arguments);
                    acc.refresh += performance.now() - t0;
                    return r;
                };
            }
            if (typeof Lightmask !== 'undefined' && Lightmask.prototype.update) {
                wrap(Lightmask.prototype, 'update', 'light');
            }

            if (typeof ImageManager !== 'undefined' && ImageManager.loadNormalBitmap) {
                var _loadBmp = ImageManager.loadNormalBitmap;
                ImageManager.loadNormalBitmap = function (path, hue) {
                    var cached = this._imageCache && this._imageCache.get && this._imageCache.get(path + ':' + hue);
                    if (!cached && loads.length < 12) loads.push('img ' + path.split('/').slice(-2).join('/'));
                    return _loadBmp.apply(this, arguments);
                };
            }
            if (typeof AudioManager !== 'undefined' && AudioManager.playSe) {
                var _playSe = AudioManager.playSe;
                AudioManager.playSe = function (se) {
                    if (se && se.name && loads.length < 12) loads.push('se ' + se.name);
                    return _playSe.apply(this, arguments);
                };
            }

            var last = performance.now(), window10 = last;
            (function frameTick() {
                var now = performance.now();
                var dt = now - last;
                last = now;
                frames++;

                if (dt > 100) {
                    slow++;
                    log('SLOW FRAME ' + dt.toFixed(0) + 'ms  map=' + acc.map.toFixed(0) +
                        ' sprites=' + acc.sprites.toFixed(0) + ' render=' + acc.render.toFixed(0) +
                        '  other=' + Math.max(0, dt - acc.map - acc.sprites - acc.render).toFixed(0) +
                        (loads.length ? '  loaded: ' + loads.join(', ') : '') +
                        '  map#' + (($gameMap && $gameMap.mapId && $gameMap.mapId()) || 0) +
                        ' events=' + (($gameMap && $gameMap.events && $gameMap.events().length) || 0));
                }

                if (now - window10 >= 10000) {
                    var secs = (now - window10) / 1000;
                    log('frame budget over ' + secs.toFixed(0) + 's: ' + (frames / secs).toFixed(1) + ' fps' +
                        '  map=' + (acc.map / frames).toFixed(1) + 'ms' +
                        ' (events=' + (acc.events / frames).toFixed(1) + 'ms)' +
                        ' sprites=' + (acc.sprites / frames).toFixed(1) + 'ms' +
                        ' (' + offscreenPct + '% of events offscreen)' +
                        ' render=' + (acc.render / frames).toFixed(1) + 'ms' +
                        '  [refresh=' + (acc.refresh / frames).toFixed(1) + 'ms x' + refreshes +
                        ' interp=' + (acc.interp / frames).toFixed(1) + 'ms' +
                        ' light=' + (acc.light / frames).toFixed(1) + 'ms]' +
                        '  steps=' + ((perf.steps / Math.max(perf.frames || frames, 1)).toFixed(2)) + '/frame' +
                        ' culled=' + (perf.seenEv ? Math.round(perf.culledEv / perf.seenEv * 100) : 0) + '%' +
                        ' sprites=' + perf.culledSpr +
                        ' refreshSkipped=' + perf.refreshSkipped +
                        '  slowframes=' + slow +
                        '  map#' + (($gameMap && $gameMap.mapId && $gameMap.mapId()) || 0) +
                        ' events=' + (($gameMap && $gameMap.events && $gameMap.events().length) || 0));
                    // Which reason kept each event that was not skipped. If anything but
                    // screen is large, the whitelist is doing real work and is not just
                    // a position test.
                    if (perf.keep) {
                        log('  kept: ' + Object.keys(perf.keep).map(function (k) {
                            return k + '=' + perf.keep[k];
                        }).join(' '));
                        Object.keys(perf.keep).forEach(function (k) { perf.keep[k] = 0; });
                    }
                    perf.steps = perf.frames = 0;
                    perf.culledEv = perf.seenEv = perf.culledSpr = perf.refreshSkipped = 0;
                    // Sampled once per window rather than per sprite per frame.
                    try {
                        var evs = ($gameMap && $gameMap.events && $gameMap.events()) || [];
                        var off = 0;
                        for (var k = 0; k < evs.length; k++) {
                            if (evs[k].isNearTheScreen && !evs[k].isNearTheScreen()) off++;
                        }
                        offscreenPct = Math.round(off / Math.max(evs.length, 1) * 100);
                    } catch (e) { offscreenPct = -1; }
                    acc.map = acc.sprites = acc.render = acc.events = 0;
                    acc.refresh = acc.interp = acc.light = 0; refreshes = 0;
                    frames = 0; slow = 0; window10 = now;
                }
                loads.length = 0;
                requestAnimationFrame(frameTick);
            })();
            log('frame profiler on');
        }

        if (CFG.skipVideo) {
            Graphics.playVideo = function () { log('video skipped'); };
        }

        //---------------------------------------------------------------------
        // 4. GPU context loss
        //
        // PIXI 4.5.4 does not recover from a lost WebGL context: the game keeps
        // running and keeps drawing, but what reaches the screen is garbage, often
        // a vertically mirrored frame. On a handheld the context goes away when
        // the device sleeps. Reloading lands back at the title screen with saves
        // intact, which beats a game that looks broken and is not.
        //---------------------------------------------------------------------
        var canvas = document.getElementById('GameCanvas') || Graphics._canvas;
        if (canvas && canvas.addEventListener) {
            canvas.addEventListener('webglcontextlost', function (e) {
                e.preventDefault();
                log('WebGL context lost' + (CFG.reloadOnContextLoss ? ', reloading' : ''));
                if (CFG.reloadOnContextLoss) setTimeout(function () { location.reload(); }, 500);
            }, false);
            canvas.addEventListener('webglcontextrestored', function () {
                log('WebGL context restored');
            }, false);
        }

        if (CFG.verbose) {
            var frames = 0, worst = 0, last = performance.now(), lastReport = last;
            (function tick() {
                var now = performance.now(), dt = now - last;
                last = now; frames++;
                if (dt > worst) worst = dt;
                if (now - lastReport >= 10000) {
                    var m = performance.memory || {};
                    log('fps=' + (frames * 1000 / (now - lastReport)).toFixed(1) +
                        ' worst=' + worst.toFixed(0) + 'ms' +
                        ' heap=' + ((m.usedJSHeapSize || 0) / 1048576).toFixed(0) + 'MB' +
                        ' scene=' + (SceneManager._scene && SceneManager._scene.constructor.name));
                    frames = 0; worst = 0; lastReport = now;
                }
                requestAnimationFrame(tick);
            })();
        }
    });

    window.addEventListener('load', function () {
        if (CFG.cacheMp && typeof ImageCache !== 'undefined') {
            // Community_Basic sets this from the game's own parameter when its plugin
            // loads, which happens before window load, so this lands after it.
            ImageCache.limit = CFG.cacheMp * 1000 * 1000;
            log('ImageCache.limit = ' + CFG.cacheMp + ' Mpx (' + (CFG.cacheMp * 4) + ' MB of RGBA)');
        }

        //---------------------------------------------------------------------
        // 5. Frame rate
        //
        // Everything here installs on window load rather than on DOMContentLoaded,
        // because PluginManager has run by then. That ordering is the whole point: a
        // wrapper installed last sits outermost, so an update it decides to skip skips
        // the plugins' own aliases with it. Four of the enabled plugins alias the two
        // methods below (FilterController, YEP_FootstepSounds, VE_FogAndOverlay and
        // YEP_SaveEventLocations), and TDDP_FluidTimestep owns updateMain.
        //---------------------------------------------------------------------

        // 5a. Cap the fixed timestep's catch up.
        if (CFG.maxSteps > 0 && typeof SceneManager !== 'undefined' &&
                typeof SceneManager._accumulator === 'number') {
            SceneManager.updateMain = function () {
                var newTime = this.getTimeInMs();
                var frameTime = (newTime - this._currentTime) / 1000;
                if (frameTime > 0.25) frameTime = 0.25;
                this._currentTime = newTime;
                this._accumulator += frameTime;
                var steps = 0;
                while (this._accumulator >= this._dt && steps < CFG.maxSteps) {
                    this.updateInputData();
                    this.changeScene();
                    this.updateScene();
                    this._accumulator -= this._dt;
                    this._t += this._dt;
                    steps++;
                }
                // Drop the debt instead of carrying it. A frame that has already
                // overrun is the last one that should owe the next one a logic step,
                // and carrying it is what turns one slow frame into a stall.
                if (this._accumulator >= this._dt) this._accumulator = 0;
                perf.steps += steps;
                perf.frames++;
                this.renderScene();
                this.requestUpdate();
            };
            log('timestep capped at ' + CFG.maxSteps + ' logic step(s) per rendered frame');
        } else if (CFG.maxSteps > 0) {
            log('no fixed timestep plugin here, SceneManager left alone');
        }

        // With the cap off the plugin's own loop runs, and the interesting number is
        // how many logic steps it puts in one rendered frame. Count them either way,
        // so FNH_MAX_STEPS=0 and =1 can be compared on the same scene.
        if (!(CFG.maxSteps > 0 && typeof SceneManager !== 'undefined' &&
                typeof SceneManager._accumulator === 'number') && typeof SceneManager !== 'undefined') {
            var _updateScene = SceneManager.updateScene;
            SceneManager.updateScene = function () {
                perf.steps++;
                return _updateScene.apply(this, arguments);
            };
        }

        // 5b. Off screen sprites.
        //
        // A sprite outside the view has nothing to show. The only states that outlive
        // the view are a requested animation and a balloon, so those keep updating.
        if (CFG.cull >= 1 && typeof Sprite_Character !== 'undefined') {
            var _spriteUpdate = Sprite_Character.prototype.update;
            Sprite_Character.prototype.update = function () {
                var c = this._character;
                if (c && $gameMap && !c.isNearTheScreen() && !c.animationId() && !c.balloonId() &&
                        !this.isAnimationPlaying() && !this.isBalloonPlaying()) {
                    perf.culledSpr++;
                    return;
                }
                return _spriteUpdate.apply(this, arguments);
            };
            log('off screen sprite updates skipped');
        }

        // 5c. Off screen event logic.
        //
        // What vanilla MV does to an off screen event is updateStop (which counts
        // frames and drives a forced move route), updateMove if it is mid step,
        // updateAnimation, checkEventTriggerAuto and updateParallel. Game_Event's own
        // updateSelfMovement is already gated on isNearTheScreen in rpg_objects.js, so
        // random, approach and custom route events do not walk off screen in the
        // original game either. That leaves five states that are observable from
        // outside the view, and each is a reason to update below: a forced move route
        // (this game issues 16042 of them at other events), a running interpreter, an
        // autorun or parallel page, a step in progress, and a requested animation or
        // balloon. _stopCount is credited by hand so an event that comes back into
        // view is exactly as ready to move as it would have been.
        //
        // isNearTheScreen is generous: it is a box one whole screen out in every
        // direction, so an event has a screen of warning before it matters.
        if (CFG.cull >= 2 && typeof Game_Map !== 'undefined') {
            var keep = { screen: 0, forced: 0, moving: 0, page: 0, interp: 0, busy: 0, anim: 0 };
            perf.keep = keep;
            var needsUpdate = function (ev) {
                if (ev.isNearTheScreen()) { keep.screen++; return true; }
                if (ev._moveRouteForcing) { keep.forced++; return true; }
                if (ev.isMoving() || ev.isJumping()) { keep.moving++; return true; }
                if (ev._trigger === 3 || ev._trigger === 4) { keep.page++; return true; }
                if (ev._interpreter && ev._interpreter.isRunning()) { keep.interp++; return true; }
                if (ev._locked || ev.isStarting()) { keep.busy++; return true; }
                if (ev.animationId() || ev.balloonId()) { keep.anim++; return true; }
                return false;
            };
            Game_Map.prototype.updateEvents = function () {
                var evs = this.events();
                for (var i = 0; i < evs.length; i++) {
                    var ev = evs[i];
                    if (needsUpdate(ev)) {
                        ev.update();
                    } else {
                        ev._stopCount++;
                        perf.culledEv++;
                    }
                }
                perf.seenEv += evs.length;
                // Common events are the map's parallel processes. There are a handful
                // of them and none of them has a position, so they always run.
                var ce = this._commonEvents;
                for (var j = 0; j < ce.length; j++) {
                    ce[j].update();
                }
            };
            log('off screen event updates skipped');
        }

        // 5d. Page condition refreshes.
        //
        // Game_Map.refresh re-evaluates the page conditions of every event on the map,
        // and any switch or variable change asks for one. Hunger and sanity tick
        // constantly here, so the profiler saw it run 320 times in ten seconds. The
        // work is deferred rather than dropped: _needsRefresh stays set, and
        // Game_Map.update asks again on the next frame.
        if (CFG.refreshMs > 0 && typeof Game_Map !== 'undefined') {
            var lastRefresh = -1e9;
            var _mapRefresh = Game_Map.prototype.refresh;
            Game_Map.prototype.refresh = function () {
                var now = performance.now();
                if (now - lastRefresh < CFG.refreshMs) {
                    this._needsRefresh = true;
                    perf.refreshSkipped++;
                    return;
                }
                lastRefresh = now;
                return _mapRefresh.apply(this, arguments);
            };
            var _mapSetup = Game_Map.prototype.setup;
            Game_Map.prototype.setup = function () {
                // A map that has just loaded refreshes at once, whatever the clock says.
                lastRefresh = -1e9;
                return _mapSetup.apply(this, arguments);
            };
            log('page condition refresh limited to one per ' + CFG.refreshMs + ' ms');
        }
    });
})();
