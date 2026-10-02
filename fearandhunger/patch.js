//=============================================================================
// patch.js - port compatibility and memory layer for Fear & Hunger
//-----------------------------------------------------------------------------
// NW.js runs this before any script of the game, through "inject_js_start" in
// package.json. Nothing here edits the player's own files: the www/ folder they
// copy in is read exactly as it came off their install.
//
// Four jobs, in order of how much they matter:
//
//   1. Stub greenworks, without which the game dies before the title screen.
//   2. Keep the decoded audio small enough to fit a 1 GB handheld.
//   3. Render into a buffer the size of the panel instead of 816x624.
//   4. Survive, loudly, when the GPU context goes away.
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
        profile:     process.env.FNH_PROFILE === '1'
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
    });
})();
