#target illustrator

/* ==========================================================================
   BATCH COLOR SWAP for Adobe Illustrator                              v1.0
   --------------------------------------------------------------------------
   Find any fill/stroke color and replace it with any other color, across a
   whole folder of PDF / AI / EPS files.

   - Build a list of rules (FIND color -> REPLACE color). First match wins.
   - FIND by CMYK, RGB, Grayscale values (with tolerance) or by spot/swatch
     name ("contains" or "is exactly", comma-separate several names).
   - REPLACE with CMYK, RGB, Grayscale, a Spot color, or None (remove).
   - Save each brand's rules as a preset; share preset .json files with
     teammates via Import.
   - Optional: spot targets only for files whose name contains a keyword
     (e.g. "_SPOT"); other files get the spot's CMYK equivalent.
   - Covers paths, compound paths, grouped art, live text, gradient stops,
     locked/hidden layers and objects.
   - Writes a CSV log, backs up originals, resumes interrupted runs,
     dry-run mode, and "Test on Open Document" before you batch.

   Install: File > Scripts > Other Script... and pick this file, or copy it
   into Illustrator's Presets/<language>/Scripts folder and restart.
   ========================================================================== */

var BCS = {
    VERSION: "1.1",
    library: null,
    libraryPath: "",
    APP_FOLDER_NAME: "BatchColorSwap",
    BACKUP_FOLDER: "_ORIGINALS",
    FAILED_FOLDER: "FAILED_FILES",
    RESUME_FILE: "_colorswap_resume.txt",
    RETRY_LIMIT: 1,
    FIND_TYPES: ["CMYK", "RGB", "GRAY", "SPOT"],
    FIND_LABELS: ["CMYK values", "RGB values", "Grayscale value", "Spot / swatch name"],
    DST_TYPES: ["CMYK", "RGB", "GRAY", "SPOT", "NONE"],
    DST_LABELS: ["CMYK (process)", "RGB", "Grayscale", "Spot color", "None (remove)"],
    ARROW: " \u2192 ",
    DASH: " \u2014 "
};

// ==========================================================================
// SMALL UTILITIES (ExtendScript is ES3: no JSON, trim, indexOf on arrays...)
// ==========================================================================
function bcsTrim(s) { return String(s === undefined || s === null ? "" : s).replace(/^\s+|\s+$/g, ""); }
function bcsNum(v, def) { var n = parseFloat(v); return isNaN(n) ? def : n; }
function bcsClamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
function bcsNear(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= tol + 1e-9; }
function bcsRound(n, d) { var p = Math.pow(10, d || 0); return Math.round(Number(n) * p) / p; }

function bcsClone(o) {
    if (o === null || typeof o !== "object") return o;
    var c = (o instanceof Array) ? [] : {};
    for (var k in o) { if (o.hasOwnProperty(k)) c[k] = bcsClone(o[k]); }
    return c;
}

function bcsInArray(arr, v) {
    for (var i = 0; i < arr.length; i++) { if (arr[i] === v) return i; }
    return -1;
}

function bcsSplitList(s) {
    var parts = String(s || "").split(","), out = [];
    for (var i = 0; i < parts.length; i++) {
        var p = bcsTrim(parts[i]);
        if (p) out.push(p);
    }
    return out;
}

function bcsQuote(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}

function bcsStringify(v, indent) {
    indent = indent || "";
    var next = indent + "  ", i, parts;
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return bcsQuote(v);
    if (v instanceof Array) {
        if (!v.length) return "[]";
        var simple = true;
        for (i = 0; i < v.length; i++) { if (v[i] !== null && typeof v[i] === "object") simple = false; }
        parts = [];
        for (i = 0; i < v.length; i++) parts.push((simple ? "" : next) + bcsStringify(v[i], next));
        return simple ? "[" + parts.join(", ") + "]" : "[\n" + parts.join(",\n") + "\n" + indent + "]";
    }
    parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(next + bcsQuote(k) + ": " + bcsStringify(v[k], next));
    }
    if (!parts.length) return "{}";
    return "{\n" + parts.join(",\n") + "\n" + indent + "}";
}

// Minimal, safe JSON parser (no eval, so shared preset files can't run code).
function bcsParse(text) {
    var s = String(text), i = 0;
    function fail(m) { throw new Error("Not valid JSON (" + m + " at character " + i + ")"); }
    function ws() { while (i < s.length && " \t\r\n\uFEFF".indexOf(s.charAt(i)) >= 0) i++; }
    function str() {
        i++;
        var out = "";
        while (i < s.length) {
            var c = s.charAt(i++);
            if (c === '"') return out;
            if (c === "\\") {
                var e = s.charAt(i++);
                if (e === "n") out += "\n";
                else if (e === "r") out += "\r";
                else if (e === "t") out += "\t";
                else if (e === "b") out += "\b";
                else if (e === "f") out += "\f";
                else if (e === "u") { out += String.fromCharCode(parseInt(s.substr(i, 4), 16)); i += 4; }
                else out += e;
            } else out += c;
        }
        fail("unterminated string");
    }
    function arr() {
        i++;
        var a = [];
        ws();
        if (s.charAt(i) === "]") { i++; return a; }
        while (true) {
            a.push(val());
            ws();
            var c = s.charAt(i++);
            if (c === "]") return a;
            if (c !== ",") fail("expected , or ]");
        }
    }
    function obj() {
        i++;
        var o = {};
        ws();
        if (s.charAt(i) === "}") { i++; return o; }
        while (true) {
            ws();
            if (s.charAt(i) !== '"') fail("expected a key");
            var k = str();
            ws();
            if (s.charAt(i++) !== ":") fail("expected :");
            o[k] = val();
            ws();
            var c = s.charAt(i++);
            if (c === "}") return o;
            if (c !== ",") fail("expected , or }");
        }
    }
    function val() {
        ws();
        var c = s.charAt(i);
        if (c === "{") return obj();
        if (c === "[") return arr();
        if (c === '"') return str();
        if (s.substr(i, 4) === "true") { i += 4; return true; }
        if (s.substr(i, 5) === "false") { i += 5; return false; }
        if (s.substr(i, 4) === "null") { i += 4; return null; }
        var m = /^-?\d+(\.\d+)?([eE][+\-]?\d+)?/.exec(s.substr(i, 40));
        if (m) { i += m[0].length; return parseFloat(m[0]); }
        fail("unexpected '" + c + "'");
    }
    var result = val();
    ws();
    if (i < s.length) fail("extra characters");
    return result;
}

function bcsReadText(f) {
    f.encoding = "UTF-8";
    if (!f.exists || !f.open("r")) return null;
    var t = f.read();
    f.close();
    return t;
}

function bcsWriteText(f, text) {
    f.encoding = "UTF-8";
    if (!f.open("w")) return false;
    f.write(text);
    f.close();
    return true;
}

function bcsAppendLine(f, line) {
    f.encoding = "UTF-8";
    if (!f.open("a")) return false;
    f.writeln(line);
    f.close();
    return true;
}

function bcsEnsureFolder(folder) {
    if (!folder) return false;
    if (folder.exists) return true;
    if (folder.parent && !folder.parent.exists) bcsEnsureFolder(folder.parent);
    return folder.create();
}

function bcsTimestamp(forFile) {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    var date = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    var time = p(d.getHours()) + (forFile ? "" : ":") + p(d.getMinutes()) + (forFile ? "" : ":") + p(d.getSeconds());
    return forFile ? date + "_" + time : date + " " + time;
}

function bcsCsv(v) {
    var s = String(v === undefined || v === null ? "" : v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function bcsSafeFileName(n) { return bcsTrim(n).replace(/[\\\/:\*\?"<>\|]/g, "_"); }

// ==========================================================================
// RULES & SETTINGS (data model)
// ==========================================================================
function bcsDefaultRule() {
    return {
        name: "",
        enabled: true,
        fill: true,
        stroke: true,
        fileFilter: "",
        src: { type: "CMYK", v: [0, 100, 0, 0], spotName: "", spotMatch: "contains", tol: 0.5, matchGlobal: true },
        dst: { type: "CMYK", v: [0, 0, 0, 0], spotName: "", alt: [0, 0, 0, 0], tint: 100, keepTint: true }
    };
}

function bcsNumArray(a, def) {
    var out = [];
    for (var i = 0; i < def.length; i++) out.push(a && a.length > i ? bcsNum(a[i], def[i]) : def[i]);
    return out;
}

function bcsNormalizeRule(r) {
    var d = bcsDefaultRule();
    if (!r || typeof r !== "object") return d;
    var src = r.src || {}, dst = r.dst || {};
    return {
        name: r.name ? String(r.name) : "",
        enabled: r.enabled !== false,
        fill: r.fill !== false,
        stroke: r.stroke !== false,
        fileFilter: r.fileFilter ? String(r.fileFilter) : "",
        src: {
            type: bcsInArray(BCS.FIND_TYPES, src.type) >= 0 ? src.type : "CMYK",
            v: bcsNumArray(src.v, [0, 0, 0, 0]),
            spotName: src.spotName ? String(src.spotName) : "",
            spotMatch: src.spotMatch === "exact" ? "exact" : "contains",
            tol: bcsClamp(bcsNum(src.tol, 0.5), 0, 50),
            matchGlobal: src.matchGlobal !== false
        },
        dst: {
            type: bcsInArray(BCS.DST_TYPES, dst.type) >= 0 ? dst.type : "CMYK",
            v: bcsNumArray(dst.v, [0, 0, 0, 0]),
            spotName: dst.spotName ? String(dst.spotName) : "",
            alt: bcsNumArray(dst.alt, [0, 0, 0, 0]),
            tint: bcsClamp(bcsNum(dst.tint, 100), 0, 100),
            keepTint: dst.keepTint !== false
        }
    };
}

function bcsMakeRule(name, src, dst, fileFilter) {
    var r = bcsDefaultRule();
    r.name = name;
    for (var k in src) { if (src.hasOwnProperty(k)) r.src[k] = src[k]; }
    for (var j in dst) { if (dst.hasOwnProperty(j)) r.dst[j] = dst[j]; }
    r.fileFilter = fileFilter || "";
    return r;
}

// Example preset created on first run, to show how a brand change is set up.
// The CMYK numbers are placeholders: replace them with your own builds, or
// use a reference swatch file so the official Pantone definition is used.
function bcsExampleRules() {
    var p534 = { type: "SPOT", spotName: "PANTONE 534 C", alt: [100, 82, 22, 9], tint: 100, keepTint: true };
    return [
        bcsMakeRule("Old brand blue (spot) -> PANTONE 534 C", { type: "SPOT", spotName: "PANTONE 289 C", spotMatch: "exact" }, p534, ""),
        bcsMakeRule("Old brand blue (CMYK build) -> PANTONE 534 C", { type: "CMYK", v: [100, 64, 0, 60] }, p534, "")
    ];
}

function bcsDefaultSettings() {
    return {
        rules: [],
        lastPreset: "",
        rootFolder: "",
        includeSubfolders: true,
        typePDF: true,
        typeAI: false,
        typeEPS: false,
        doText: true,
        doGradients: false,
        includeLocked: true,
        outputMode: "overwrite",
        backupOriginals: true,
        outputFolder: "",
        copyUnchanged: true,
        pdfPreset: "[Illustrator Default]",
        preserveEditability: true,
        spotKeyword: "",
        hideLayers: "",
        maxPaths: 0,
        removeMatchedSpots: true,
        dryRun: false,
        swatchLibrary: "",
        updateExistingSwatches: false
    };
}

function bcsNormalizeSettings(s) {
    var d = bcsDefaultSettings();
    if (!s || typeof s !== "object") return d;
    for (var k in d) {
        if (!d.hasOwnProperty(k) || k === "rules") continue;
        if (s.hasOwnProperty(k) && typeof s[k] === typeof d[k]) d[k] = s[k];
    }
    if (s.rules instanceof Array) {
        d.rules = [];
        for (var i = 0; i < s.rules.length; i++) d.rules.push(bcsNormalizeRule(s.rules[i]));
    }
    return d;
}

// ==========================================================================
// COLOR MATCHING
// ==========================================================================
function bcsNameMatches(name, pattern, mode) {
    var n = String(name).toLowerCase();
    var parts = bcsSplitList(pattern);
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i].toLowerCase();
        if (mode === "exact" ? n === p : n.indexOf(p) >= 0) return true;
    }
    return false;
}

function bcsValueMatch(c, src, tol) {
    var t, v = src.v;
    try { t = c.typename; } catch (e) { return false; }
    if (src.type === "CMYK" && t === "CMYKColor")
        return bcsNear(c.cyan, v[0], tol) && bcsNear(c.magenta, v[1], tol) &&
               bcsNear(c.yellow, v[2], tol) && bcsNear(c.black, v[3], tol);
    if (src.type === "RGB" && t === "RGBColor")
        return bcsNear(c.red, v[0], tol) && bcsNear(c.green, v[1], tol) && bcsNear(c.blue, v[2], tol);
    if (src.type === "GRAY" && t === "GrayColor")
        return bcsNear(c.gray, v[0], tol);
    return false;
}

function bcsIsGlobalProcess(color) {
    try { return color.typename === "SpotColor" && color.spot.colorType === ColorModel.PROCESS; }
    catch (e) { return false; }
}

function bcsColorMatches(color, src) {
    if (!color) return false;
    var t;
    try { t = color.typename; } catch (e) { return false; }
    var tol = bcsNum(src.tol, 0.5);

    if (src.type === "SPOT") {
        if (t !== "SpotColor") return false;
        try { return bcsNameMatches(color.spot.name, src.spotName, src.spotMatch); }
        catch (e2) { return false; }
    }
    if (t === "SpotColor") {
        // Global process swatches report as SpotColor; match on their values at 100% tint.
        if (!src.matchGlobal || !bcsIsGlobalProcess(color)) return false;
        try { return bcsNear(color.tint, 100, tol) && bcsValueMatch(color.spot.color, src, tol); }
        catch (e3) { return false; }
    }
    return bcsValueMatch(color, src, tol);
}

function bcsScaled(v, factor) {
    return [v[0] * factor, v[1] * factor, v[2] * factor, v[3] * factor];
}

function bcsSourceTint(color) {
    try { if (color && color.typename === "SpotColor") return color.tint; } catch (e) {}
    return 100;
}

// Tint to use when the output is a spot color.
function bcsTargetTint(rule, srcColor) {
    var d = rule.dst;
    if (d.keepTint) {
        try { if (srcColor && srcColor.typename === "SpotColor") return srcColor.tint; } catch (e) {}
    }
    return d.tint;
}

// Lighten a process build to a tint (factor 0-1). Ink amounts scale down;
// RGB moves toward white.
function bcsApplyTint(type, v, f) {
    if (f >= 1) return [v[0], v[1], v[2], v[3]];
    if (type === "RGB") return [255 - (255 - v[0]) * f, 255 - (255 - v[1]) * f, 255 - (255 - v[2]) * f, 0];
    return bcsScaled(v, f);
}

// The plain {type, v} a rule produces when the output is NOT a spot swatch
// (CMYK / RGB / Gray targets, or a spot target in a process-mode file).
// A 30% tint of the source gives 30% of the target build when keepTint is on.
function bcsProcessResult(rule, srcColor, ctx) {
    var d = rule.dst;
    if (d.type === "SPOT") return { type: "CMYK", v: bcsScaled(d.alt, bcsTargetTint(rule, srcColor) / 100) };
    var f = d.keepTint ? bcsSourceTint(srcColor) / 100 : 1;
    return { type: d.type, v: bcsApplyTint(d.type, d.v, f) };
}

// True when the color already IS what the rule would produce (prevents
// needless edits/saves, e.g. spot "White" matching a "contains white" rule).
function bcsIsAlreadyTarget(color, rule, ctx) {
    var d = rule.dst, t, tol = 0.05;
    try { t = color.typename; } catch (e) { return false; }
    try {
        if (d.type === "NONE") return false;
        if (d.type === "SPOT" && ctx.useSpot) {
            return t === "SpotColor" &&
                   String(color.spot.name).toLowerCase() === bcsTrim(d.spotName).toLowerCase() &&
                   bcsNear(color.tint, bcsTargetTint(rule, color), tol);
        }
        return bcsValueMatch(color, bcsProcessResult(rule, color, ctx), tol);
    } catch (e2) {}
    return false;
}

// which: "fill" | "stroke" | "any". First matching rule wins.
function bcsFindRule(color, rules, which, ctx) {
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (which === "any" ? !(r.fill || r.stroke) : !r[which]) continue;
        if (bcsColorMatches(color, r.src)) {
            return bcsIsAlreadyTarget(color, r, ctx) ? null : r;
        }
    }
    return null;
}

// ==========================================================================
// COLOR CREATION
// ==========================================================================
function bcsMakeCMYK(v) {
    var c = new CMYKColor();
    c.cyan = bcsClamp(v[0], 0, 100); c.magenta = bcsClamp(v[1], 0, 100);
    c.yellow = bcsClamp(v[2], 0, 100); c.black = bcsClamp(v[3], 0, 100);
    return c;
}
function bcsMakeRGB(v) {
    var c = new RGBColor();
    c.red = bcsClamp(v[0], 0, 255); c.green = bcsClamp(v[1], 0, 255); c.blue = bcsClamp(v[2], 0, 255);
    return c;
}
function bcsMakeGray(g) {
    var c = new GrayColor();
    c.gray = bcsClamp(g, 0, 100);
    return c;
}

// --- Reference swatch file (official definitions, e.g. from Pantone Connect)
function bcsColorData(c) {
    var t;
    try { t = c.typename; } catch (e) { return null; }
    if (t === "LabColor") return { model: "LAB", v: [c.l, c.a, c.b] };
    if (t === "CMYKColor") return { model: "CMYK", v: [c.cyan, c.magenta, c.yellow, c.black] };
    if (t === "RGBColor") return { model: "RGB", v: [c.red, c.green, c.blue] };
    if (t === "GrayColor") return { model: "GRAY", v: [c.gray] };
    return null;
}

function bcsMakeColorFromData(d) {
    if (d.model === "LAB") {
        var c = new LabColor();
        c.l = d.v[0]; c.a = d.v[1]; c.b = d.v[2];
        return c;
    }
    if (d.model === "CMYK") return bcsMakeCMYK(d.v);
    if (d.model === "RGB") return bcsMakeRGB(d.v);
    return bcsMakeGray(d.v[0]);
}

// CMYK equivalent (used for previews, the rule's CMYK fields and process-mode files).
function bcsDataToCMYK(d) {
    if (d.model === "CMYK") return [bcsRound(d.v[0], 1), bcsRound(d.v[1], 1), bcsRound(d.v[2], 1), bcsRound(d.v[3], 1)];
    if (d.model === "GRAY") return [0, 0, 0, bcsRound(d.v[0], 1)];
    try {
        var space = d.model === "LAB" ? ImageColorSpace.LAB : ImageColorSpace.RGB;
        var out = app.convertSampleColor(space, d.v, ImageColorSpace.CMYK, ColorConvertPurpose.defaultpurpose);
        if (out && out.length >= 4) return [bcsRound(out[0], 1), bcsRound(out[1], 1), bcsRound(out[2], 1), bcsRound(out[3], 1)];
    } catch (e) {}
    return null;
}

function bcsSnapshotSpots(doc) {
    var lib = { byName: {}, names: [] };
    for (var i = 0; i < doc.spots.length; i++) {
        var sp = doc.spots[i], name, data;
        try {
            if (sp.colorType !== ColorModel.SPOT) continue;
            name = String(sp.name);
            data = bcsColorData(sp.color);
        } catch (e) { continue; }
        if (!data || lib.byName[name.toLowerCase()]) continue;
        data.name = name;
        data.cmyk = bcsDataToCMYK(data);
        lib.byName[name.toLowerCase()] = data;
        lib.names.push(name);
    }
    lib.names.sort(function (a, b) { a = a.toLowerCase(); b = b.toLowerCase(); return a < b ? -1 : (a > b ? 1 : 0); });
    return lib;
}

// Opens the reference file just long enough to read its spot swatches.
function bcsLoadLibrary(path) {
    if (!bcsTrim(path)) return null;
    var f = new File(path);
    if (!f.exists) throw new Error("Reference swatch file not found:\n" + path);
    var doc = null, opened = false, i;
    for (i = 0; i < app.documents.length; i++) {
        try { if (app.documents[i].fullName.fsName === f.fsName) { doc = app.documents[i]; break; } } catch (e) {}
    }
    var oldUIL = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    try {
        if (!doc) { doc = app.open(f); opened = true; }
        return bcsSnapshotSpots(doc);
    } finally {
        if (opened) { try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {} }
        app.userInteractionLevel = oldUIL;
    }
}

// Sets a spot's definition: from the reference file when it has this name,
// otherwise from the CMYK values typed in the rule. Returns "reference" | "typed".
function bcsDefineSpot(spot, d, ctx) {
    var ref = ctx.library ? ctx.library.byName[bcsTrim(d.spotName).toLowerCase()] : null;
    if (ref) {
        try {
            spot.color = bcsMakeColorFromData(ref);
            spot.colorType = ColorModel.SPOT;
            if (ref.model === "LAB") { try { spot.spotKind = SpotColorKind.SPOTLAB; } catch (e0) {} }
            return "reference";
        } catch (e) {}
    }
    spot.color = bcsMakeCMYK(d.alt);
    spot.colorType = ColorModel.SPOT;
    return "typed";
}

function bcsGetSpot(doc, d, ctx) {
    var name = bcsTrim(d.spotName), key = name.toLowerCase(), spot = null, i;
    if (ctx.spotCache[key]) return ctx.spotCache[key];
    var inRef = !!(ctx.library && ctx.library.byName[key]);

    for (i = 0; i < doc.spots.length; i++) {
        try { if (String(doc.spots[i].name).toLowerCase() === key) { spot = doc.spots[i]; break; } } catch (e) {}
    }
    if (spot) {
        try { if (spot.name !== name) spot.name = name; } catch (e2) {}
        try { if (spot.colorType !== ColorModel.SPOT) spot.colorType = ColorModel.SPOT; } catch (e3) {}
        if (inRef && ctx.updateExisting) {
            try { bcsDefineSpot(spot, d, ctx); ctx.notes.push("\"" + name + "\" updated from reference file"); } catch (e5) {}
        }
    } else {
        // A plain (non-global) swatch with the same name would block the new spot's name.
        for (i = doc.swatches.length - 1; i >= 0; i--) {
            try { if (String(doc.swatches[i].name).toLowerCase() === key) doc.swatches[i].remove(); } catch (e4) {}
        }
        spot = doc.spots.add();
        spot.name = name;
        var how = bcsDefineSpot(spot, d, ctx);
        ctx.notes.push("added \"" + name + "\" (" + (how === "reference" ? "from reference file" :
            (ctx.library ? "NOT in reference file - used typed CMYK" : "typed CMYK")) + ")");
    }
    ctx.spotCache[key] = spot;
    return spot;
}

function bcsBuildTarget(rule, srcColor, ctx) {
    var d = rule.dst;
    if (d.type === "NONE") return null;
    if (d.type === "SPOT" && ctx.useSpot) {
        var sc = new SpotColor();
        sc.spot = bcsGetSpot(ctx.doc, d, ctx);
        sc.tint = bcsTargetTint(rule, srcColor);
        return sc;
    }
    var p = bcsProcessResult(rule, srcColor, ctx);
    if (p.type === "CMYK") return bcsMakeCMYK(p.v);
    if (p.type === "RGB") return bcsMakeRGB(p.v);
    return bcsMakeGray(p.v[0]);
}

// ==========================================================================
// LOCK / VISIBILITY HANDLING
// ==========================================================================
function bcsUnlockLayers(doc) {
    var saved = [];
    function walk(layers) {
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            saved.push({ layer: L, locked: L.locked, visible: L.visible });
            try { L.locked = false; } catch (e) {}
            try { L.visible = true; } catch (e2) {}
            try { walk(L.layers); } catch (e3) {}
        }
    }
    walk(doc.layers);
    return saved;
}

function bcsRestoreLayers(saved) {
    for (var i = saved.length - 1; i >= 0; i--) {
        try { saved[i].layer.visible = saved[i].visible; } catch (e) {}
        try { saved[i].layer.locked = saved[i].locked; } catch (e2) {}
    }
}

function bcsUnlockChain(item) {
    var changed = [], p = item, guard = 0, tn;
    while (p && guard++ < 60) {
        try { tn = p.typename; } catch (e) { break; }
        if (tn === "Layer" || tn === "Document") break;
        try { if (p.locked) { p.locked = false; changed.push({ o: p, k: "locked" }); } } catch (e2) {}
        try { if (p.hidden) { p.hidden = false; changed.push({ o: p, k: "hidden" }); } } catch (e3) {}
        try { p = p.parent; } catch (e4) { break; }
    }
    return changed;
}

function bcsRelock(changed) {
    for (var i = changed.length - 1; i >= 0; i--) {
        try { changed[i].o[changed[i].k] = true; } catch (e) {}
    }
}

function bcsSafeSet(item, fn, ctx) {
    try { fn(); return true; } catch (e) {
        if (!ctx.includeLocked) return false;
        var changed = bcsUnlockChain(item);
        if (!changed.length) return false;
        try { fn(); return true; } catch (e2) { return false; }
        finally { bcsRelock(changed); }
    }
}

// ==========================================================================
// DOCUMENT PROCESSING
// ==========================================================================
function bcsFileFilterPasses(filter, fileName) {
    var f = bcsTrim(filter);
    if (!f) return true;
    var neg = false;
    if (f.charAt(0) === "!") { neg = true; f = f.substr(1); }
    var parts = bcsSplitList(f), lower = String(fileName).toLowerCase(), hit = false;
    for (var i = 0; i < parts.length; i++) {
        if (lower.indexOf(parts[i].toLowerCase()) >= 0) { hit = true; break; }
    }
    return neg ? !hit : hit;
}

function bcsActiveRules(rules, fileName) {
    var out = [];
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.enabled && (r.fill || r.stroke) && bcsFileFilterPasses(r.fileFilter, fileName)) out.push(r);
    }
    return out;
}

function bcsUseSpotFor(fileName, s) {
    return bcsTrim(s.spotKeyword) ? bcsFileFilterPasses(s.spotKeyword, fileName) : true;
}

function bcsNewStats() {
    return { fills: 0, strokes: 0, text: 0, gradStops: 0, layersHidden: 0, spotsRemoved: 0, failed: 0 };
}

function bcsApply(owner, getColor, isOn, setColor, setNone, which, statKey, rules, ctx, stats) {
    var color;
    try { if (!isOn()) return; color = getColor(); } catch (e) { return; }
    var rule = bcsFindRule(color, rules, which, ctx);
    if (!rule) return;
    if (ctx.dry) { stats[statKey]++; return; }
    var target;
    try { target = bcsBuildTarget(rule, color, ctx); } catch (e2) { stats.failed++; return; }
    var ok = bcsSafeSet(owner, function () {
        if (target === null) setNone(); else setColor(target);
    }, ctx);
    if (ok) stats[statKey]++; else stats.failed++;
}

function bcsProcessPath(item, rules, ctx, stats) {
    try { if (item.guides) return; } catch (e) {}
    bcsApply(item,
        function () { return item.fillColor; }, function () { return item.filled; },
        function (c) { item.fillColor = c; }, function () { item.filled = false; },
        "fill", "fills", rules, ctx, stats);
    bcsApply(item,
        function () { return item.strokeColor; }, function () { return item.stroked; },
        function (c) { item.strokeColor = c; }, function () { item.stroked = false; },
        "stroke", "strokes", rules, ctx, stats);
}

function bcsProcessTextFrame(tf, rules, ctx, stats) {
    var chars;
    try { chars = tf.textRange.characters; } catch (e) { return; }
    var n = chars.length;
    for (var j = 0; j < n; j++) {
        var ca;
        try { ca = chars[j].characterAttributes; } catch (e2) { continue; }
        (function (ca) {
            bcsApply(tf,
                function () { return ca.fillColor; },
                function () { return ca.fillColor.typename !== "NoColor"; },
                function (c) { ca.fillColor = c; }, function () { ca.fillColor = new NoColor(); },
                "fill", "text", rules, ctx, stats);
            bcsApply(tf,
                function () { return ca.strokeColor; },
                function () { return ca.strokeColor.typename !== "NoColor"; },
                function (c) { ca.strokeColor = c; }, function () { ca.strokeColor = new NoColor(); },
                "stroke", "text", rules, ctx, stats);
        })(ca);
    }
}

function bcsProcessGradients(doc, rules, ctx, stats) {
    for (var g = 0; g < doc.gradients.length; g++) {
        var stops;
        try { stops = doc.gradients[g].gradientStops; } catch (e) { continue; }
        for (var i = 0; i < stops.length; i++) {
            var c;
            try { c = stops[i].color; } catch (e2) { continue; }
            var rule = bcsFindRule(c, rules, "any", ctx);
            if (!rule || rule.dst.type === "NONE") continue;
            if (ctx.dry) { stats.gradStops++; continue; }
            try { stops[i].color = bcsBuildTarget(rule, c, ctx); stats.gradStops++; }
            catch (e3) { stats.failed++; }
        }
    }
}

function bcsHideLayers(doc, namesCsv) {
    var names = bcsSplitList(namesCsv), count = 0, i;
    if (!names.length) return 0;
    for (i = 0; i < names.length; i++) names[i] = names[i].toLowerCase();
    function walk(layers) {
        for (var j = 0; j < layers.length; j++) {
            var L = layers[j];
            try {
                if (bcsInArray(names, String(L.name).toLowerCase()) >= 0 && L.visible) { L.visible = false; count++; }
            } catch (e) {}
            try { walk(L.layers); } catch (e2) {}
        }
    }
    walk(doc.layers);
    return count;
}

function bcsRemoveMatchedSpots(doc, rules) {
    var keep = { "[registration]": true }, removed = 0, i, j;
    for (j = 0; j < rules.length; j++) {
        if (rules[j].dst.type === "SPOT") keep[bcsTrim(rules[j].dst.spotName).toLowerCase()] = true;
    }
    for (i = doc.spots.length - 1; i >= 0; i--) {
        var sp = doc.spots[i], nm;
        try { nm = String(sp.name); } catch (e) { continue; }
        if (keep[nm.toLowerCase()]) continue;
        for (j = 0; j < rules.length; j++) {
            var src = rules[j].src;
            if (src.type === "SPOT" && bcsNameMatches(nm, src.spotName, src.spotMatch)) {
                try { sp.remove(); removed++; } catch (e2) {}
                break;
            }
        }
    }
    return removed;
}

// Returns { status, stats, note }. status: CHANGED | NO_MATCH | NO_RULES | SKIPPED
function bcsProcessDocument(doc, s, fileName) {
    var stats = bcsNewStats();
    var rules = bcsActiveRules(s.rules, fileName);
    var ctx = {
        doc: doc,
        useSpot: bcsUseSpotFor(fileName, s),
        spotCache: {},
        includeLocked: s.includeLocked,
        dry: s.dryRun,
        library: BCS.library,
        updateExisting: s.updateExistingSwatches,
        notes: []
    };

    var paths = doc.pathItems, n = paths.length;
    if (s.maxPaths > 0 && n > s.maxPaths) {
        return { status: "SKIPPED", stats: stats, note: n + " paths (limit " + s.maxPaths + ")" };
    }

    if (rules.length) {
        var layerState = s.includeLocked && !s.dryRun ? bcsUnlockLayers(doc) : null;
        try {
            for (var i = 0; i < n; i++) bcsProcessPath(paths[i], rules, ctx, stats);
            if (s.doText) {
                var tfs = doc.textFrames;
                for (var t = 0; t < tfs.length; t++) bcsProcessTextFrame(tfs[t], rules, ctx, stats);
            }
            if (s.doGradients) bcsProcessGradients(doc, rules, ctx, stats);
        } finally {
            if (layerState) bcsRestoreLayers(layerState);
        }
        if (!s.dryRun && s.removeMatchedSpots) stats.spotsRemoved = bcsRemoveMatchedSpots(doc, rules);
    }
    if (!s.dryRun) stats.layersHidden = bcsHideLayers(doc, s.hideLayers);

    var changes = stats.fills + stats.strokes + stats.text + stats.gradStops;
    var status;
    if (changes > 0 || stats.layersHidden > 0 || stats.spotsRemoved > 0) status = "CHANGED";
    else status = rules.length ? "NO_MATCH" : "NO_RULES";
    var note = (ctx.useSpot ? "spot mode" : "process mode") + "; " + rules.length + " rule(s) applied" +
               (ctx.notes.length ? "; " + ctx.notes.join("; ") : "");
    return { status: status, stats: stats, note: note };
}

function bcsStatsText(st) {
    return "Fills: " + st.fills + "   Strokes: " + st.strokes + "   Text chars: " + st.text +
           "   Gradient stops: " + st.gradStops + "\nLayers hidden: " + st.layersHidden +
           "   Old spots deleted: " + st.spotsRemoved + (st.failed ? "   Could not change: " + st.failed : "");
}

// ==========================================================================
// FILES, SAVING, BATCH
// ==========================================================================
function bcsExt(file) {
    var m = /\.([a-z0-9]+)$/i.exec(decodeURI(file.name));
    return m ? m[1].toLowerCase() : "";
}

function bcsCollectFiles(folder, s, excludes) {
    var out = [], entries = folder.getFiles(), i;
    entries.sort(function (a, b) {
        var x = decodeURI(a.name).toLowerCase(), y = decodeURI(b.name).toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
    });
    for (i = 0; i < entries.length; i++) {
        var f = entries[i], nm = decodeURI(f.name);
        if (f instanceof Folder) {
            if (!s.includeSubfolders) continue;
            if (nm === BCS.BACKUP_FOLDER || nm === BCS.FAILED_FOLDER) continue;
            if (excludes[String(f.fsName).toLowerCase()]) continue;
            out = out.concat(bcsCollectFiles(f, s, excludes));
        } else if (f instanceof File) {
            if (nm.indexOf("._") === 0) continue; // macOS resource-fork junk on network drives
            if (excludes[String(f.fsName).toLowerCase()]) continue; // e.g. the reference swatch file
            var ext = bcsExt(f);
            if ((ext === "pdf" && s.typePDF) || (ext === "ai" && s.typeAI) || (ext === "eps" && s.typeEPS)) out.push(f);
        }
    }
    return out;
}

function bcsRelPath(file, root) {
    var f = String(file.fsName).replace(/\\/g, "/"), r = String(root.fsName).replace(/\\/g, "/");
    if (f.indexOf(r + "/") === 0) return f.substr(r.length + 1);
    return decodeURI(file.name);
}

function bcsSaveDoc(doc, outFile, ext, s) {
    var o;
    if (ext === "ai") {
        o = new IllustratorSaveOptions();
        o.pdfCompatible = true;
    } else if (ext === "eps") {
        o = new EPSSaveOptions();
    } else {
        o = new PDFSaveOptions();
        if (s.pdfPreset) { try { o.pDFPreset = s.pdfPreset; } catch (e) {} }
        o.preserveEditability = s.preserveEditability;
    }
    doc.saveAs(outFile, o);
}

function bcsProcessFile(file, s, root) {
    var name = decodeURI(file.name), ext = bcsExt(file), rel = bcsRelPath(file, root);
    var doc = app.open(file), res;
    try {
        res = bcsProcessDocument(doc, s, name);
        if (!s.dryRun) {
            var outFile = s.outputMode === "folder" ? new File(s.outputFolder + "/" + rel) : file;
            if (res.status === "CHANGED") {
                if (s.outputMode !== "folder" && s.backupOriginals) {
                    var bak = new File(root.fsName + "/" + BCS.BACKUP_FOLDER + "/" + rel);
                    bcsEnsureFolder(bak.parent);
                    if (!bak.exists && !file.copy(bak.fsName)) throw new Error("Could not back up original - file left untouched");
                }
                bcsEnsureFolder(outFile.parent);
                bcsSaveDoc(doc, outFile, ext, s);
                res.savedTo = outFile.fsName;
            } else if (s.outputMode === "folder" && s.copyUnchanged && res.status !== "SKIPPED") {
                bcsEnsureFolder(outFile.parent);
                file.copy(outFile.fsName);
                res.savedTo = outFile.fsName + " (copied unchanged)";
            }
        }
    } finally {
        try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
    }
    return res;
}

function bcsMakeProgress(total) {
    var w = new Window("palette", "Batch Color Swap");
    w.alignChildren = ["fill", "top"];
    var st = w.add("statictext", undefined, "Starting...");
    st.preferredSize = [520, 18];
    var bar = w.add("progressbar", undefined, 0, total);
    bar.preferredSize = [520, 12];
    var counts = w.add("statictext", undefined, "");
    counts.preferredSize = [520, 18];
    var stop = w.add("button", undefined, "Stop after this file");
    w.cancelled = false;
    stop.onClick = function () { w.cancelled = true; stop.text = "Stopping..."; };
    w.show();
    return { w: w, st: st, bar: bar, counts: counts };
}

function bcsRunBatch(s) {
    var root = new Folder(s.rootFolder);
    var excludes = {};
    if (s.outputMode === "folder") excludes[String(new Folder(s.outputFolder).fsName).toLowerCase()] = true;
    if (s.swatchLibrary) excludes[String(new File(s.swatchLibrary).fsName).toLowerCase()] = true;

    var files = bcsCollectFiles(root, s, excludes);
    if (!files.length) { alert("No matching files found in:\n" + root.fsName); return; }

    var enabled = 0;
    for (var r = 0; r < s.rules.length; r++) if (s.rules[r].enabled) enabled++;

    var where = s.dryRun ? "DRY RUN - nothing will be changed or saved." :
        (s.outputMode === "folder" ? "Results saved to:\n" + new Folder(s.outputFolder).fsName :
         "Originals will be OVERWRITTEN" + (s.backupOriginals ? " (backups go to " + BCS.BACKUP_FOLDER + ")." : " with NO backup."));
    if (BCS.library) where += "\n\nReference swatch file: " + BCS.library.names.length + " spot swatch(es) from " + decodeURI(new File(s.swatchLibrary).name);
    if (!confirm("Process " + files.length + " file(s) with " + enabled + " enabled rule(s)?\n\n" + where)) return;

    // Resume support (keyed by relative path, so it survives reordering).
    var resumeFile = new File(root.fsName + "/" + BCS.RESUME_FILE);
    var done = {}, doneCount = 0;
    if (!s.dryRun && resumeFile.exists) {
        var prev = bcsReadText(resumeFile) || "", lines = prev.split(/\r?\n/);
        for (var l = 0; l < lines.length; l++) { if (bcsTrim(lines[l])) { done[bcsTrim(lines[l])] = true; doneCount++; } }
        if (doneCount && !confirm("A previous run was interrupted after " + doneCount + " file(s).\n\nYes = resume and skip those files\nNo = start over from the beginning")) {
            done = {}; doneCount = 0; resumeFile.remove();
        }
    }

    var logFile = new File(root.fsName + "/ColorSwap_Log_" + bcsTimestamp(true) + (s.dryRun ? "_DRYRUN" : "") + ".csv");
    bcsAppendLine(logFile, "File,Status,Fills,Strokes,Text chars,Gradient stops,Layers hidden,Old spots deleted,Could not change,Saved to,Notes");
    var failedFolder = new Folder(root.fsName + "/" + BCS.FAILED_FOLDER);
    var tally = { CHANGED: 0, NO_MATCH: 0, NO_RULES: 0, SKIPPED: 0, FAILED: 0, RESUMED: 0 };

    var oldUIL = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    var prog = bcsMakeProgress(files.length), cancelled = false, start = new Date().getTime();

    try {
        for (var i = 0; i < files.length; i++) {
            var file = files[i], rel = bcsRelPath(file, root);
            prog.st.text = (i + 1) + " / " + files.length + ":  " + rel;
            prog.bar.value = i;
            prog.counts.text = "Changed " + tally.CHANGED + "   No match " + tally.NO_MATCH +
                               "   Skipped " + tally.SKIPPED + "   Failed " + tally.FAILED;
            try { prog.w.update(); } catch (eu) {}
            if (prog.w.cancelled) { cancelled = true; break; }

            if (done[rel]) { tally.RESUMED++; continue; }

            var res = null, lastErr = "";
            for (var attempt = 0; attempt <= BCS.RETRY_LIMIT && !res; attempt++) {
                try { res = bcsProcessFile(file, s, root); }
                catch (e) {
                    lastErr = String(e.message || e) + (e.line ? " (line " + e.line + ")" : "");
                    try { while (app.documents.length && decodeURI(app.activeDocument.name) === decodeURI(file.name)) app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (ec) {}
                    $.sleep(250);
                }
            }

            if (!res) {
                tally.FAILED++;
                if (!s.dryRun) {
                    try { bcsEnsureFolder(failedFolder); file.copy(failedFolder.fsName + "/" + decodeURI(file.name)); } catch (ef) {}
                }
                bcsAppendLine(logFile, [bcsCsv(rel), "FAILED", "", "", "", "", "", "", "", "", bcsCsv(lastErr)].join(","));
            } else {
                tally[res.status] = (tally[res.status] || 0) + 1;
                var st = res.stats;
                bcsAppendLine(logFile, [bcsCsv(rel), res.status, st.fills, st.strokes, st.text, st.gradStops,
                    st.layersHidden, st.spotsRemoved, st.failed, bcsCsv(res.savedTo || ""), bcsCsv(res.note || "")].join(","));
            }
            if (!s.dryRun) bcsAppendLine(resumeFile, rel);

            if (i % 10 === 9) { try { $.gc(); } catch (eg) {} }
        }
    } finally {
        app.userInteractionLevel = oldUIL;
        try { prog.w.close(); } catch (ew) {}
    }

    if (!cancelled && resumeFile.exists) resumeFile.remove();

    var mins = bcsRound((new Date().getTime() - start) / 60000, 1);
    alert((cancelled ? "STOPPED - run the batch again to resume.\n\n" : (s.dryRun ? "DRY RUN COMPLETE\n\n" : "BATCH COMPLETE\n\n")) +
          (s.dryRun ? "Would change: " : "Changed: ") + tally.CHANGED +
          "\nNo matching colors: " + (tally.NO_MATCH + tally.NO_RULES) +
          "\nSkipped (too many paths): " + tally.SKIPPED +
          "\nFailed: " + tally.FAILED + (tally.FAILED && !s.dryRun ? "  (copies in " + BCS.FAILED_FOLDER + ")" : "") +
          (tally.RESUMED ? "\nAlready done in earlier run: " + tally.RESUMED : "") +
          "\n\nTime: " + mins + " min\nLog: " + decodeURI(logFile.name));
}

function bcsRunOnActive(s) {
    if (!app.documents.length) { alert("Open a document first."); return; }
    var doc = app.activeDocument, name = decodeURI(doc.name);
    var res = bcsProcessDocument(doc, s, name);
    try { app.redraw(); } catch (e) {}
    var head = s.dryRun ? "DRY RUN on \"" + name + "\" (nothing changed)" : "Applied to \"" + name + "\" (not saved)";
    var tail = s.dryRun ? "" : "\n\nReview it, then File > Revert if you want to undo everything.";
    alert(head + "\n\nResult: " + res.status + "  (" + res.note + ")\n" + bcsStatsText(res.stats) + tail);
}

// ==========================================================================
// PRESETS & SAVED SETTINGS (stored in the user's app-data folder)
// ==========================================================================
function bcsAppFolder() {
    var f = new Folder(Folder.userData + "/" + BCS.APP_FOLDER_NAME);
    bcsEnsureFolder(f);
    return f;
}
function bcsPresetFolder() {
    var f = new Folder(bcsAppFolder().fsName + "/Presets");
    bcsEnsureFolder(f);
    return f;
}
function bcsListPresets() {
    var files = bcsPresetFolder().getFiles("*.json"), names = [];
    for (var i = 0; i < files.length; i++) names.push(decodeURI(files[i].name).replace(/\.json$/i, ""));
    names.sort(function (a, b) { a = a.toLowerCase(); b = b.toLowerCase(); return a < b ? -1 : (a > b ? 1 : 0); });
    return names;
}
function bcsRulesFromData(data) {
    var list = (data instanceof Array) ? data : (data && data.rules instanceof Array ? data.rules : null);
    if (!list) throw new Error("No \"rules\" list found in this file.");
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(bcsNormalizeRule(list[i]));
    return out;
}
function bcsLoadPresetFile(f) {
    var text = bcsReadText(f);
    if (text === null) throw new Error("Could not read " + f.fsName);
    return bcsRulesFromData(bcsParse(text));
}
function bcsSavePreset(name, rules) {
    var f = new File(bcsPresetFolder().fsName + "/" + bcsSafeFileName(name) + ".json");
    var data = { app: "BatchColorSwap", version: BCS.VERSION, name: name, saved: bcsTimestamp(false), rules: rules };
    return bcsWriteText(f, bcsStringify(data)) ? f : null;
}
function bcsEnsureExamplePreset() {
    try { if (!bcsListPresets().length) bcsSavePreset("Example - PANTONE 289 C to 534 C", bcsExampleRules()); } catch (e) {}
}
function bcsSettingsFile() { return new File(bcsAppFolder().fsName + "/last_settings.json"); }
function bcsLoadSettings() {
    try {
        var t = bcsReadText(bcsSettingsFile());
        if (t) return bcsNormalizeSettings(bcsParse(t));
    } catch (e) {}
    return bcsDefaultSettings();
}
function bcsSaveSettings(s) {
    try { bcsWriteText(bcsSettingsFile(), bcsStringify(s)); } catch (e) {}
}

// ==========================================================================
// DESCRIPTIONS (for lists & summaries)
// ==========================================================================
function bcsFmt(n) { return String(bcsRound(n, 1)); }
function bcsHex(v) {
    var h = "";
    for (var i = 0; i < 3; i++) {
        var x = Math.round(bcsClamp(v[i], 0, 255)).toString(16).toUpperCase();
        h += x.length < 2 ? "0" + x : x;
    }
    return "#" + h;
}
function bcsDescribeValues(type, v) {
    if (type === "CMYK") return "C" + bcsFmt(v[0]) + " M" + bcsFmt(v[1]) + " Y" + bcsFmt(v[2]) + " K" + bcsFmt(v[3]);
    if (type === "RGB") return "R" + bcsFmt(v[0]) + " G" + bcsFmt(v[1]) + " B" + bcsFmt(v[2]) + " (" + bcsHex(v) + ")";
    if (type === "GRAY") return "Gray K" + bcsFmt(v[0]);
    return "";
}
function bcsDescribeSrc(src) {
    if (src.type === "SPOT") return "spot name " + (src.spotMatch === "exact" ? "is" : "contains") + " \"" + src.spotName + "\"";
    return bcsDescribeValues(src.type, src.v);
}
function bcsDescribeDst(d) {
    if (d.type === "NONE") return "None (remove)";
    if (d.type === "SPOT") return "Spot \"" + d.spotName + "\"" + (!d.keepTint && d.tint < 100 ? " " + bcsFmt(d.tint) + "%" : "");
    return bcsDescribeValues(d.type, d.v);
}
function bcsRuleSummary(r, i) {
    var parts = [];
    if (r.fill) parts.push("fill");
    if (r.stroke) parts.push("stroke");
    return (r.enabled ? "[ON]   " : "[off]  ") + (i + 1) + ".  " + (r.name ? r.name + BCS.DASH : "") +
           bcsDescribeSrc(r.src) + BCS.ARROW + bcsDescribeDst(r.dst) +
           "   (" + parts.join(" + ") + (r.fileFilter ? "; files: " + r.fileFilter : "") + ")";
}

// For the "Pick from document" list.
function bcsDescribeForPick(color) {
    var t;
    try { t = color.typename; } catch (e) { return null; }
    function vals(c) {
        var tt = c.typename;
        if (tt === "CMYKColor") return { type: "CMYK", v: [bcsRound(c.cyan, 1), bcsRound(c.magenta, 1), bcsRound(c.yellow, 1), bcsRound(c.black, 1)] };
        if (tt === "RGBColor") return { type: "RGB", v: [bcsRound(c.red, 1), bcsRound(c.green, 1), bcsRound(c.blue, 1), 0] };
        if (tt === "GrayColor") return { type: "GRAY", v: [bcsRound(c.gray, 1), 0, 0, 0] };
        return null;
    }
    try {
        if (t === "SpotColor") {
            var nm = String(color.spot.name), tint = bcsRound(color.tint, 1);
            if (bcsIsGlobalProcess(color)) {
                var base = vals(color.spot.color);
                if (!base) return null;
                return { key: "G|" + nm + "|" + tint,
                         label: "Global swatch \"" + nm + "\"" + (tint !== 100 ? " " + tint + "%" : "") + BCS.DASH + bcsDescribeValues(base.type, base.v),
                         src: { type: base.type, v: base.v, matchGlobal: true } };
            }
            return { key: "S|" + nm.toLowerCase(), label: "Spot \"" + nm + "\" (any tint)",
                     src: { type: "SPOT", spotName: nm, spotMatch: "exact" } };
        }
        var p = vals(color);
        if (!p) return null;
        return { key: p.type + "|" + p.v.join(","), label: p.type === "GRAY" ? bcsDescribeValues(p.type, p.v) : p.type + "  " + bcsDescribeValues(p.type, p.v),
                 src: { type: p.type, v: p.v, matchGlobal: true } };
    } catch (e2) { return null; }
}

// ==========================================================================
// UI: PICK A COLOR FROM THE OPEN DOCUMENT
// ==========================================================================
function bcsGather(item, paths, texts) {
    var t;
    try { t = item.typename; } catch (e) { return; }
    var i;
    if (t === "PathItem") paths.push(item);
    else if (t === "CompoundPathItem") { for (i = 0; i < item.pathItems.length; i++) paths.push(item.pathItems[i]); }
    else if (t === "GroupItem") { for (i = 0; i < item.pageItems.length; i++) bcsGather(item.pageItems[i], paths, texts); }
    else if (t === "TextFrame") texts.push(item);
}

function bcsPickColorDialog() {
    if (!app.documents.length) { alert("Open a document that has the color you want to find."); return null; }
    var doc = app.activeDocument, paths = [], texts = [], fromSel = false, i, j;
    try {
        var sel = doc.selection;
        if (sel && sel.length) { fromSel = true; for (i = 0; i < sel.length; i++) bcsGather(sel[i], paths, texts); }
    } catch (e) {}
    if (!fromSel) {
        for (i = 0; i < doc.pathItems.length && i < 30000; i++) paths.push(doc.pathItems[i]);
        for (i = 0; i < doc.textFrames.length; i++) texts.push(doc.textFrames[i]);
    }

    var map = {}, list = [];
    function add(color, kind) {
        var info = bcsDescribeForPick(color);
        if (!info) return;
        var e = map[info.key];
        if (!e) { e = map[info.key] = { info: info, fill: 0, stroke: 0, text: 0 }; list.push(e); }
        e[kind]++;
    }
    for (i = 0; i < paths.length; i++) {
        var p = paths[i];
        try { if (p.filled) add(p.fillColor, "fill"); } catch (e1) {}
        try { if (p.stroked) add(p.strokeColor, "stroke"); } catch (e2) {}
    }
    var charBudget = 5000;
    for (i = 0; i < texts.length && charBudget > 0; i++) {
        try {
            var ch = texts[i].textRange.characters;
            for (j = 0; j < ch.length && charBudget > 0; j++, charBudget--) {
                add(ch[j].characterAttributes.fillColor, "text");
            }
        } catch (e3) {}
    }
    if (!list.length) { alert("No solid fill or stroke colors found" + (fromSel ? " in the selection." : ".")); return null; }
    list.sort(function (a, b) { return (b.fill + b.stroke + b.text) - (a.fill + a.stroke + a.text); });

    var w = new Window("dialog", "Pick a color " + (fromSel ? "from the selection" : "from \"" + decodeURI(doc.name) + "\""));
    w.alignChildren = ["fill", "top"];
    w.add("statictext", undefined, "Colors in use (most used first). Tip: select objects first to list only their colors.");
    var lb = w.add("listbox", undefined, []);
    lb.preferredSize = [560, 300];
    for (i = 0; i < list.length; i++) {
        var e4 = list[i], uses = [];
        if (e4.fill) uses.push(e4.fill + " fill");
        if (e4.stroke) uses.push(e4.stroke + " stroke");
        if (e4.text) uses.push(e4.text + " text chars");
        lb.add("item", e4.info.label + "     [" + uses.join(", ") + "]");
    }
    lb.selection = 0;
    var bg = w.add("group");
    bg.alignment = "right";
    bg.add("button", undefined, "Cancel", { name: "cancel" });
    var ok = bg.add("button", undefined, "Use This Color", { name: "ok" });
    var picked = null;
    function choose() { if (lb.selection) { picked = list[lb.selection.index].info; w.close(1); } }
    ok.onClick = choose;
    lb.onDoubleClick = choose;
    w.show();
    return picked;
}

// ==========================================================================
// UI: RULE EDITOR
// ==========================================================================
function bcsToRGB(type, v) {
    if (type === "CMYK") {
        var k = 1 - v[3] / 100;
        return [(1 - v[0] / 100) * k, (1 - v[1] / 100) * k, (1 - v[2] / 100) * k];
    }
    if (type === "RGB") return [v[0] / 255, v[1] / 255, v[2] / 255];
    if (type === "GRAY") { var g = 1 - v[0] / 100; return [g, g, g]; }
    return null;
}

function bcsAddSwatch(parent) {
    var g = parent.add("group");
    g.preferredSize = [70, 24];
    g.rgb = null;
    g.onDraw = function () {
        var gr = this.graphics, wdt = this.size[0], hgt = this.size[1];
        try {
            if (this.rgb) {
                gr.newPath();
                gr.rectPath(0, 0, wdt, hgt);
                gr.fillPath(gr.newBrush(gr.BrushType.SOLID_COLOR, [this.rgb[0], this.rgb[1], this.rgb[2], 1]));
            } else {
                gr.newPath();
                gr.moveTo(0, hgt); gr.lineTo(wdt, 0);
                gr.strokePath(gr.newPen(gr.PenType.SOLID_COLOR, [0.8, 0.1, 0.1, 1], 2));
            }
            gr.newPath();
            gr.rectPath(0, 0, wdt, hgt);
            gr.strokePath(gr.newPen(gr.PenType.SOLID_COLOR, [0.45, 0.45, 0.45, 1], 1));
        } catch (e) {}
    };
    return g;
}
function bcsSetSwatch(g, rgb) {
    g.rgb = rgb;
    try { g.hide(); g.show(); } catch (e) {}
}

function bcsNumRow(parent, labels, values, width) {
    var row = parent.add("group"), fields = [];
    row.spacing = 4;
    for (var i = 0; i < labels.length; i++) {
        row.add("statictext", undefined, labels[i]);
        var et = row.add("edittext", undefined, String(bcsRound(values[i], 2)));
        et.characters = width || 4;
        fields.push(et);
    }
    return { row: row, fields: fields };
}

function bcsReadNums(fields, max) {
    var out = [];
    for (var i = 0; i < fields.length; i++) out.push(bcsClamp(bcsNum(fields[i].text, 0), 0, max));
    while (out.length < 4) out.push(0);
    return out;
}
function bcsWriteNums(fields, v) {
    for (var i = 0; i < fields.length; i++) fields[i].text = String(bcsRound(v[i], 2));
}

// Builds the stacked CMYK / RGB / Gray / Spot (/ None) editors inside a panel.
function bcsColorEditor(panel, isTarget, data) {
    var E = { groups: {} };
    var typeRow = panel.add("group");
    typeRow.add("statictext", undefined, "Color type:");
    E.dd = typeRow.add("dropdownlist", undefined, isTarget ? BCS.DST_LABELS : BCS.FIND_LABELS);
    var types = isTarget ? BCS.DST_TYPES : BCS.FIND_TYPES;
    E.types = types;

    var stack = panel.add("group");
    stack.orientation = "stack";
    stack.alignChildren = ["left", "top"];

    function vFor(type, def) { return data.type === type ? data.v : def; }

    var g = stack.add("group"); g.orientation = "column"; g.alignChildren = ["left", "top"];
    E.cmyk = bcsNumRow(g, ["C", "M", "Y", "K"], vFor("CMYK", [0, 0, 0, 0])).fields;
    E.groups.CMYK = g;

    g = stack.add("group"); g.orientation = "column"; g.alignChildren = ["left", "top"];
    E.rgb = bcsNumRow(g, ["R", "G", "B"], vFor("RGB", [0, 0, 0])).fields;
    var hexRow = g.add("group");
    hexRow.add("statictext", undefined, "Hex #");
    E.hex = hexRow.add("edittext", undefined, bcsHex(vFor("RGB", [0, 0, 0])).substr(1));
    E.hex.characters = 8;
    E.groups.RGB = g;

    g = stack.add("group"); g.orientation = "column"; g.alignChildren = ["left", "top"];
    E.gray = bcsNumRow(g, ["Black %"], vFor("GRAY", [0])).fields;
    E.groups.GRAY = g;

    g = stack.add("group"); g.orientation = "column"; g.alignChildren = ["left", "top"];
    var nr = g.add("group");
    nr.add("statictext", undefined, isTarget ? "Spot name:" : "Name");
    if (!isTarget) {
        E.spotMatch = nr.add("dropdownlist", undefined, ["contains", "is exactly"]);
        E.spotMatch.selection = data.spotMatch === "exact" ? 1 : 0;
    }
    E.spotName = nr.add("edittext", undefined, data.spotName || "");
    E.spotName.characters = isTarget ? 22 : 16;
    if (isTarget) {
        g.add("statictext", undefined, "Spot's CMYK appearance (also used in process-mode files):");
        E.alt = bcsNumRow(g, ["C", "M", "Y", "K"], data.alt || [0, 0, 0, 0]).fields;
        var tr = g.add("group");
        tr.add("statictext", undefined, "Tint % (used when not keeping the original tint):");
        E.tint = tr.add("edittext", undefined, String(data.tint === undefined ? 100 : data.tint));
        E.tint.characters = 4;
        E.refBtn = g.add("button", undefined, "Choose from Reference Swatch File...");
        E.refNote = g.add("statictext", undefined, "", { multiline: true });
        E.refNote.preferredSize = [360, 30];
    } else {
        g.add("statictext", undefined, "Matches spot & global swatches by name, any tint.");
        g.add("statictext", undefined, "Separate several names with commas.");
    }
    E.groups.SPOT = g;

    if (isTarget) {
        g = stack.add("group"); g.orientation = "column"; g.alignChildren = ["left", "top"];
        g.add("statictext", undefined, "Matching fills/strokes will be removed.");
        E.groups.NONE = g;
        E.keepTint = panel.add("checkbox", undefined, "Keep the original spot's tint (a 30% tint stays 30%)");
        E.keepTint.value = data.keepTint !== false;
    }

    var prevRow = panel.add("group");
    prevRow.add("statictext", undefined, "Preview:");
    E.swatch = bcsAddSwatch(prevRow);
    E.swatchNote = prevRow.add("statictext", undefined, "");
    E.swatchNote.characters = 22;

    E.type = function () { return types[E.dd.selection ? E.dd.selection.index : 0]; };
    E.refresh = function () {
        var t = E.type();
        for (var k in E.groups) { if (E.groups.hasOwnProperty(k)) E.groups[k].visible = (k === t); }
        var rgb = null, note = "";
        if (t === "CMYK") rgb = bcsToRGB("CMYK", bcsReadNums(E.cmyk, 100));
        else if (t === "RGB") rgb = bcsToRGB("RGB", bcsReadNums(E.rgb, 255));
        else if (t === "GRAY") rgb = bcsToRGB("GRAY", bcsReadNums(E.gray, 100));
        else if (t === "SPOT") {
            if (isTarget) { rgb = bcsToRGB("CMYK", bcsReadNums(E.alt, 100)); note = "approximate"; }
            else { rgb = [0.85, 0.85, 0.85]; note = "matched by name"; }
        } else note = "none";
        bcsSetSwatch(E.swatch, rgb);
        E.swatchNote.text = note;
        if (isTarget) {
            E.keepTint.enabled = (t !== "NONE");
            var lib = BCS.library, nm = bcsTrim(E.spotName.text).toLowerCase();
            E.refBtn.enabled = !!(lib && lib.names.length);
            E.refNote.text = !lib ? "No reference swatch file set: a new spot is built from the CMYK above. Existing spots in a file keep their own definition." :
                (lib.byName[nm] ? "In reference file: the official definition will be used for new swatches." :
                 "Not in the reference file (" + lib.names.length + " spots loaded): the CMYK above will be used.");
        }
    };
    E.setFrom = function (src) { // from a picked color
        var idx = bcsInArray(types, src.type);
        if (idx < 0) return;
        E.dd.selection = idx;
        if (src.type === "CMYK") bcsWriteNums(E.cmyk, src.v);
        if (src.type === "RGB") { bcsWriteNums(E.rgb, src.v); E.hex.text = bcsHex(src.v).substr(1); }
        if (src.type === "GRAY") bcsWriteNums(E.gray, src.v);
        if (src.type === "SPOT") { E.spotName.text = src.spotName; if (E.spotMatch) E.spotMatch.selection = src.spotMatch === "exact" ? 1 : 0; }
        E.refresh();
    };
    E.read = function (out) {
        var t = E.type();
        out.type = t;
        if (t === "CMYK") out.v = bcsReadNums(E.cmyk, 100);
        else if (t === "RGB") out.v = bcsReadNums(E.rgb, 255);
        else if (t === "GRAY") out.v = bcsReadNums(E.gray, 100);
        if (t === "SPOT") {
            out.spotName = bcsTrim(E.spotName.text);
            if (E.spotMatch) out.spotMatch = E.spotMatch.selection.index === 1 ? "exact" : "contains";
            if (isTarget) {
                out.alt = bcsReadNums(E.alt, 100);
                out.tint = bcsClamp(bcsNum(E.tint.text, 100), 0, 100);
            }
        }
        if (isTarget) out.keepTint = E.keepTint.value;
        return out;
    };

    // Live updates
    var all = E.cmyk.concat(E.rgb, E.gray, E.alt || []), i;
    for (i = 0; i < all.length; i++) all[i].onChanging = function () { E.refresh(); };
    for (i = 0; i < E.rgb.length; i++) {
        E.rgb[i].onChange = function () { E.hex.text = bcsHex(bcsReadNums(E.rgb, 255)).substr(1); E.refresh(); };
    }
    E.hex.onChange = function () {
        var m = /^#?([0-9a-f]{6})$/i.exec(bcsTrim(E.hex.text));
        if (!m) return;
        var h = m[1];
        bcsWriteNums(E.rgb, [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]);
        E.refresh();
    };
    E.dd.onChange = function () { E.refresh(); };
    if (isTarget) {
        E.spotName.onChanging = function () { E.refresh(); };
        E.refBtn.onClick = function () {
            var ref = bcsPickReferenceSpot();
            if (!ref) return;
            E.spotName.text = ref.name;
            if (ref.cmyk) bcsWriteNums(E.alt, ref.cmyk);
            E.refresh();
        };
    }

    var startIdx = bcsInArray(types, data.type);
    E.dd.selection = startIdx < 0 ? 0 : startIdx;
    return E;
}

function bcsPickReferenceSpot() {
    var lib = BCS.library;
    if (!lib || !lib.names.length) { alert("Set a reference swatch file in the main window first."); return null; }
    var w = new Window("dialog", "Reference swatches (" + lib.names.length + ")");
    w.alignChildren = ["fill", "top"];
    var gf = w.add("group");
    gf.add("statictext", undefined, "Filter:");
    var et = gf.add("edittext", undefined, "");
    et.characters = 24;
    var lb = w.add("listbox", undefined, []);
    lb.preferredSize = [460, 300];
    var shown = [];
    function fill() {
        var q = bcsTrim(et.text).toLowerCase();
        lb.removeAll();
        shown = [];
        for (var i = 0; i < lib.names.length; i++) {
            var d = lib.byName[lib.names[i].toLowerCase()];
            if (q && d.name.toLowerCase().indexOf(q) < 0) continue;
            shown.push(d);
            lb.add("item", d.name + "      (" + d.model + (d.cmyk ? "; CMYK approx. " + d.cmyk.join("/") : "") + ")");
        }
        if (shown.length) lb.selection = 0;
    }
    et.onChanging = fill;
    var bg = w.add("group");
    bg.alignment = "right";
    bg.add("button", undefined, "Cancel", { name: "cancel" });
    var ok = bg.add("button", undefined, "Use This Swatch", { name: "ok" });
    var picked = null;
    function choose() { if (lb.selection) { picked = shown[lb.selection.index]; w.close(1); } }
    ok.onClick = choose;
    lb.onDoubleClick = choose;
    fill();
    w.show();
    return picked;
}

function bcsEditRuleDialog(rule) {
    var r = bcsClone(rule), result = null;
    var w = new Window("dialog", "Color Rule");
    w.alignChildren = ["fill", "top"];

    var g1 = w.add("group");
    g1.add("statictext", undefined, "Rule name:");
    var etName = g1.add("edittext", undefined, r.name);
    etName.characters = 40;
    var cbOn = g1.add("checkbox", undefined, "Enabled");
    cbOn.value = r.enabled;

    var g2 = w.add("group");
    g2.add("statictext", undefined, "Change:");
    var cbF = g2.add("checkbox", undefined, "Fills");
    var cbS = g2.add("checkbox", undefined, "Strokes");
    cbF.value = r.fill;
    cbS.value = r.stroke;

    var g3 = w.add("group");
    g3.add("statictext", undefined, "Only in files whose name contains:");
    var etFF = g3.add("edittext", undefined, r.fileFilter);
    etFF.characters = 18;
    g3.add("statictext", undefined, "(blank = all files; start with ! for NOT)");

    var cols = w.add("group");
    cols.orientation = "row";
    cols.alignChildren = ["fill", "fill"];

    var pf = cols.add("panel", undefined, "FIND this color");
    pf.alignChildren = ["left", "top"];
    pf.margins = [12, 16, 12, 12];
    pf.preferredSize.width = 360;
    var F = bcsColorEditor(pf, false, r.src);
    var tolRow = pf.add("group");
    tolRow.add("statictext", undefined, "Tolerance \u00B1");
    var etTol = tolRow.add("edittext", undefined, String(r.src.tol));
    etTol.characters = 4;
    tolRow.add("statictext", undefined, "(catches 99.6 vs 100 etc.)");
    var cbGlobal = pf.add("checkbox", undefined, "Also match global swatches with these values");
    cbGlobal.value = r.src.matchGlobal;
    var bPick = pf.add("button", undefined, "Pick from Open Document / Selection...");

    var pt = cols.add("panel", undefined, "REPLACE with");
    pt.alignChildren = ["left", "top"];
    pt.margins = [12, 16, 12, 12];
    pt.preferredSize.width = 400;
    var T = bcsColorEditor(pt, true, r.dst);

    function syncFind() {
        var t = F.type();
        etTol.enabled = (t !== "SPOT");
        cbGlobal.enabled = (t !== "SPOT");
    }
    var oldF = F.dd.onChange;
    F.dd.onChange = function () { oldF(); syncFind(); };

    bPick.onClick = function () {
        var p = bcsPickColorDialog();
        if (!p) return;
        F.setFrom(p.src);
        if (p.src.matchGlobal !== undefined) cbGlobal.value = p.src.matchGlobal;
        syncFind();
    };

    var bg = w.add("group");
    bg.alignment = "right";
    bg.add("button", undefined, "Cancel", { name: "cancel" });
    var ok = bg.add("button", undefined, "OK", { name: "ok" });
    ok.onClick = function () {
        var out = bcsClone(r);
        out.name = bcsTrim(etName.text);
        out.enabled = cbOn.value;
        out.fill = cbF.value;
        out.stroke = cbS.value;
        out.fileFilter = bcsTrim(etFF.text);
        F.read(out.src);
        out.src.tol = bcsClamp(bcsNum(etTol.text, 0.5), 0, 50);
        out.src.matchGlobal = cbGlobal.value;
        T.read(out.dst);
        if (!out.fill && !out.stroke) { alert("Tick Fills and/or Strokes."); return; }
        if (out.src.type === "SPOT" && !out.src.spotName) { alert("Enter the spot / swatch name to find."); return; }
        if (out.dst.type === "SPOT" && !out.dst.spotName) { alert("Enter the name of the spot color to replace with."); return; }
        if (!out.name) out.name = bcsDescribeSrc(out.src) + " to " + bcsDescribeDst(out.dst);
        result = bcsNormalizeRule(out);
        w.close(1);
    };

    w.onShow = function () { F.refresh(); T.refresh(); syncFind(); };
    w.show();
    return result;
}

// ==========================================================================
// UI: MAIN DIALOG
// ==========================================================================
function bcsShowMainDialog(settings) {
    var s = bcsClone(settings), result = null, i;
    var w = new Window("dialog", "Batch Color Swap  v" + BCS.VERSION);
    w.alignChildren = ["fill", "top"];
    w.spacing = 8;

    // ---- Presets
    var pp = w.add("panel", undefined, "Color set / brand preset");
    pp.orientation = "row";
    pp.alignChildren = ["left", "center"];
    pp.margins = [10, 16, 10, 10];
    var ddP = pp.add("dropdownlist", undefined, []);
    ddP.preferredSize.width = 280;
    var bSaveP = pp.add("button", undefined, "Save As...");
    var bDelP = pp.add("button", undefined, "Delete");
    var bImpP = pp.add("button", undefined, "Import...");
    var bFolP = pp.add("button", undefined, "Show Folder");

    var fillingPresets = false;
    function fillPresets(select) {
        fillingPresets = true;
        ddP.removeAll();
        ddP.add("item", "-- load a saved preset --");
        var names = bcsListPresets(), sel = 0;
        for (var k = 0; k < names.length; k++) {
            ddP.add("item", names[k]);
            if (names[k] === select) sel = k + 1;
        }
        ddP.selection = sel;
        fillingPresets = false;
    }

    // ---- Rules
    var rp = w.add("panel", undefined, "Color rules  (checked top to bottom; the first rule that matches a color wins)");
    rp.alignChildren = ["fill", "top"];
    rp.margins = [10, 16, 10, 10];
    var lb = rp.add("listbox", undefined, []);
    lb.preferredSize = [820, 170];
    var rb = rp.add("group");
    var bAdd = rb.add("button", undefined, "Add...");
    var bEdit = rb.add("button", undefined, "Edit...");
    var bDup = rb.add("button", undefined, "Duplicate");
    var bDel = rb.add("button", undefined, "Delete");
    var bUp = rb.add("button", undefined, "Move Up");
    var bDn = rb.add("button", undefined, "Move Down");
    var bTog = rb.add("button", undefined, "On / Off");

    function fillRules(sel) {
        lb.removeAll();
        for (var k = 0; k < s.rules.length; k++) lb.add("item", bcsRuleSummary(s.rules[k], k));
        if (s.rules.length) lb.selection = bcsClamp(sel === undefined ? 0 : sel, 0, s.rules.length - 1);
    }
    function selIdx() { return lb.selection ? lb.selection.index : -1; }

    bAdd.onClick = function () {
        var nr = bcsEditRuleDialog(bcsDefaultRule());
        if (nr) { s.rules.push(nr); fillRules(s.rules.length - 1); }
    };
    bEdit.onClick = function () {
        var k = selIdx();
        if (k < 0) return;
        var er = bcsEditRuleDialog(s.rules[k]);
        if (er) { s.rules[k] = er; fillRules(k); }
    };
    lb.onDoubleClick = bEdit.onClick;
    bDup.onClick = function () {
        var k = selIdx();
        if (k < 0) return;
        var c = bcsClone(s.rules[k]);
        c.name = c.name + " copy";
        s.rules.splice(k + 1, 0, c);
        fillRules(k + 1);
    };
    bDel.onClick = function () {
        var k = selIdx();
        if (k < 0) return;
        s.rules.splice(k, 1);
        fillRules(k);
    };
    bUp.onClick = function () {
        var k = selIdx();
        if (k < 1) return;
        var t = s.rules[k - 1]; s.rules[k - 1] = s.rules[k]; s.rules[k] = t;
        fillRules(k - 1);
    };
    bDn.onClick = function () {
        var k = selIdx();
        if (k < 0 || k >= s.rules.length - 1) return;
        var t = s.rules[k + 1]; s.rules[k + 1] = s.rules[k]; s.rules[k] = t;
        fillRules(k + 1);
    };
    bTog.onClick = function () {
        var k = selIdx();
        if (k < 0) return;
        s.rules[k].enabled = !s.rules[k].enabled;
        fillRules(k);
    };

    ddP.onChange = function () {
        if (fillingPresets || !ddP.selection || ddP.selection.index === 0) return;
        var name = ddP.selection.text;
        try {
            s.rules = bcsLoadPresetFile(new File(bcsPresetFolder().fsName + "/" + bcsSafeFileName(name) + ".json"));
            s.lastPreset = name;
            fillRules(0);
        } catch (e) { alert("Could not load preset:\n" + e.message); }
    };
    bSaveP.onClick = function () {
        var name = prompt("Save the current rules as a preset named:", s.lastPreset || "New Brand");
        if (!name || !bcsTrim(name)) return;
        name = bcsTrim(name);
        var existing = bcsListPresets();
        if (bcsInArray(existing, name) >= 0 && !confirm("Replace the existing preset \"" + name + "\"?")) return;
        if (bcsSavePreset(name, s.rules)) { s.lastPreset = name; fillPresets(name); }
        else alert("Could not save the preset.");
    };
    bDelP.onClick = function () {
        if (!ddP.selection || ddP.selection.index === 0) { alert("Choose a preset in the list first."); return; }
        var name = ddP.selection.text;
        if (!confirm("Delete the preset \"" + name + "\"? (Current rules stay in the list.)")) return;
        var f = new File(bcsPresetFolder().fsName + "/" + bcsSafeFileName(name) + ".json");
        if (f.exists) f.remove();
        fillPresets("");
    };
    bImpP.onClick = function () {
        var f = File.openDialog("Choose a Batch Color Swap preset (.json)",
            ($.os.indexOf("Windows") >= 0) ? "Presets:*.json" : function (ff) { return (ff instanceof Folder) || /\.json$/i.test(decodeURI(ff.name)); });
        if (!f) return;
        try {
            var rules = bcsLoadPresetFile(f);
            var name = decodeURI(f.name).replace(/\.json$/i, "");
            bcsSavePreset(name, rules);
            s.rules = rules;
            s.lastPreset = name;
            fillPresets(name);
            fillRules(0);
        } catch (e) { alert("Could not import that file:\n" + e.message); }
    };
    bFolP.onClick = function () { bcsPresetFolder().execute(); };

    // ---- Two columns
    var cols = w.add("group");
    cols.orientation = "row";
    cols.alignChildren = ["fill", "top"];
    var left = cols.add("group");
    left.orientation = "column";
    left.alignChildren = ["fill", "top"];
    var right = cols.add("group");
    right.orientation = "column";
    right.alignChildren = ["fill", "top"];

    // Source files
    var fp = left.add("panel", undefined, "Source files");
    fp.alignChildren = ["left", "top"];
    fp.margins = [10, 16, 10, 10];
    var fr = fp.add("group");
    var etIn = fr.add("edittext", undefined, s.rootFolder);
    etIn.characters = 36;
    var bIn = fr.add("button", undefined, "Browse...");
    var fr2 = fp.add("group");
    var cbSub = fr2.add("checkbox", undefined, "Include subfolders");
    var cbPDF = fr2.add("checkbox", undefined, "PDF");
    var cbAI = fr2.add("checkbox", undefined, "AI");
    var cbEPS = fr2.add("checkbox", undefined, "EPS");
    cbSub.value = s.includeSubfolders; cbPDF.value = s.typePDF; cbAI.value = s.typeAI; cbEPS.value = s.typeEPS;
    bIn.onClick = function () {
        var f = Folder.selectDialog("Select the folder with the files to process", etIn.text ? new Folder(etIn.text) : undefined);
        if (f) etIn.text = f.fsName;
    };

    // Output
    var op = left.add("panel", undefined, "Save results");
    op.alignChildren = ["left", "top"];
    op.margins = [10, 16, 10, 10];
    var rbOver = op.add("radiobutton", undefined, "Overwrite the original files");
    var gBak = op.add("group");
    gBak.margins = [20, 0, 0, 0];
    var cbBak = gBak.add("checkbox", undefined, "Back up originals first (to an " + BCS.BACKUP_FOLDER + " folder)");
    cbBak.value = s.backupOriginals;
    var rbFolder = op.add("radiobutton", undefined, "Save to another folder (keeps the subfolder structure):");
    var gOut = op.add("group");
    gOut.margins = [20, 0, 0, 0];
    var etOut = gOut.add("edittext", undefined, s.outputFolder);
    etOut.characters = 30;
    var bOut = gOut.add("button", undefined, "Browse...");
    var gCopy = op.add("group");
    gCopy.margins = [20, 0, 0, 0];
    var cbCopy = gCopy.add("checkbox", undefined, "Also copy files with no matches there");
    cbCopy.value = s.copyUnchanged;
    var gPdf = op.add("group");
    gPdf.add("statictext", undefined, "PDF preset:");
    var pdfList = [];
    try { pdfList = app.PDFPresetsList; } catch (e) {}
    if (!pdfList || !pdfList.length) pdfList = ["[Illustrator Default]"];
    var ddPdf = gPdf.add("dropdownlist", undefined, pdfList);
    var pIdx = bcsInArray(pdfList, s.pdfPreset);
    if (pIdx < 0) pIdx = bcsInArray(pdfList, "[Illustrator Default]");
    ddPdf.selection = pIdx < 0 ? 0 : pIdx;
    var cbEdit = op.add("checkbox", undefined, "Preserve Illustrator editing capabilities (PDF)");
    cbEdit.value = s.preserveEditability;

    rbOver.value = s.outputMode !== "folder";
    rbFolder.value = s.outputMode === "folder";
    function syncOut() {
        cbBak.enabled = rbOver.value;
        etOut.enabled = bOut.enabled = cbCopy.enabled = rbFolder.value;
    }
    rbOver.onClick = function () { rbFolder.value = false; rbOver.value = true; syncOut(); };
    rbFolder.onClick = function () { rbOver.value = false; rbFolder.value = true; syncOut(); };
    bOut.onClick = function () {
        var f = Folder.selectDialog("Select the output folder", etOut.text ? new Folder(etOut.text) : undefined);
        if (f) etOut.text = f.fsName;
    };

    // Reference swatch file
    var lp = left.add("panel", undefined, "Reference swatch file (official Pantone definitions)");
    lp.alignChildren = ["left", "top"];
    lp.margins = [10, 16, 10, 10];
    var gl = lp.add("group");
    var etLib = gl.add("edittext", undefined, s.swatchLibrary);
    etLib.characters = 28;
    var bLib = gl.add("button", undefined, "Choose...");
    var bLibClr = gl.add("button", undefined, "Clear");
    var stLib = lp.add("statictext", undefined, "", { multiline: true });
    stLib.preferredSize = [400, 30];
    var cbUpd = lp.add("checkbox", undefined, "Also update same-name swatches already in the files");
    cbUpd.value = s.updateExistingSwatches;
    function syncLib() {
        var path = bcsTrim(etLib.text);
        if (!path) stLib.text = "None. New spot swatches are built from the CMYK values typed in each rule.";
        else if (BCS.library && BCS.libraryPath === path)
            stLib.text = BCS.library.names.length + " spot swatch(es) loaded. Used whenever a rule's target spot name matches.";
        else stLib.text = "Will be read when you test or run the batch.";
        cbUpd.enabled = !!path;
    }
    etLib.onChanging = syncLib;
    bLibClr.onClick = function () { etLib.text = ""; syncLib(); };

    // Also process
    var ap = right.add("panel", undefined, "Also process");
    ap.alignChildren = ["left", "top"];
    ap.margins = [10, 16, 10, 10];
    var cbText = ap.add("checkbox", undefined, "Live text (fill & stroke of type)");
    var cbGrad = ap.add("checkbox", undefined, "Gradient stops (beta - check the results)");
    var cbLock = ap.add("checkbox", undefined, "Locked / hidden layers and objects");
    cbText.value = s.doText; cbGrad.value = s.doGradients; cbLock.value = s.includeLocked;

    // Options
    var xp = right.add("panel", undefined, "Options");
    xp.alignChildren = ["left", "top"];
    xp.margins = [10, 16, 10, 10];
    xp.add("statictext", undefined, "Use SPOT targets only for files whose name contains:");
    var gKw = xp.add("group");
    var etKw = gKw.add("edittext", undefined, s.spotKeyword);
    etKw.characters = 18;
    gKw.add("statictext", undefined, "(blank = always)");
    xp.add("statictext", undefined, "Other files get the spot's CMYK values instead.");
    var gHide = xp.add("group");
    gHide.add("statictext", undefined, "Hide layers named:");
    var etHide = gHide.add("edittext", undefined, s.hideLayers);
    etHide.characters = 18;
    var gMax = xp.add("group");
    gMax.add("statictext", undefined, "Skip files with more than");
    var etMax = gMax.add("edittext", undefined, String(s.maxPaths));
    etMax.characters = 6;
    gMax.add("statictext", undefined, "paths (0 = no limit)");
    var cbRem = xp.add("checkbox", undefined, "Delete old spot swatches after replacing them");
    cbRem.value = s.removeMatchedSpots;
    var cbDry = xp.add("checkbox", undefined, "Dry run: count matches only, change nothing");
    cbDry.value = s.dryRun;

    // Buttons
    var br = w.add("group");
    br.alignment = ["fill", "top"];
    var bTest = br.add("button", undefined, "Test on Open Document");
    var spacer = br.add("group");
    spacer.alignment = ["fill", "fill"];
    br.add("button", undefined, "Cancel", { name: "cancel" });
    var bRun = br.add("button", undefined, "Run Batch", { name: "ok" });

    function collect() {
        s.rootFolder = bcsTrim(etIn.text);
        s.includeSubfolders = cbSub.value; s.typePDF = cbPDF.value; s.typeAI = cbAI.value; s.typeEPS = cbEPS.value;
        s.outputMode = rbFolder.value ? "folder" : "overwrite";
        s.backupOriginals = cbBak.value;
        s.outputFolder = bcsTrim(etOut.text);
        s.copyUnchanged = cbCopy.value;
        s.pdfPreset = ddPdf.selection ? ddPdf.selection.text : "";
        s.preserveEditability = cbEdit.value;
        s.doText = cbText.value; s.doGradients = cbGrad.value; s.includeLocked = cbLock.value;
        s.spotKeyword = bcsTrim(etKw.text);
        s.hideLayers = bcsTrim(etHide.text);
        s.maxPaths = Math.max(0, Math.round(bcsNum(etMax.text, 0)));
        s.removeMatchedSpots = cbRem.value;
        s.dryRun = cbDry.value;
        s.swatchLibrary = bcsTrim(etLib.text);
        s.updateExistingSwatches = cbUpd.value;
        return s;
    }
    function hasEnabledRule() {
        for (var k = 0; k < s.rules.length; k++) if (s.rules[k].enabled) return true;
        return false;
    }

    bTest.onClick = function () {
        collect();
        if (!app.documents.length) { alert("Open a document to test on first."); return; }
        if (!hasEnabledRule()) { alert("Add or enable at least one rule."); return; }
        result = { action: "test", settings: s };
        w.close(1);
    };
    bRun.onClick = function () {
        collect();
        if (!hasEnabledRule()) { alert("Add or enable at least one rule."); return; }
        if (!s.rootFolder || !new Folder(s.rootFolder).exists) { alert("Choose a source folder that exists."); return; }
        if (!s.typePDF && !s.typeAI && !s.typeEPS) { alert("Tick at least one file type."); return; }
        if (s.outputMode === "folder") {
            if (!s.outputFolder) { alert("Choose an output folder, or pick \"Overwrite the original files\"."); return; }
            var a = String(new Folder(s.outputFolder).fsName).toLowerCase(), b = String(new Folder(s.rootFolder).fsName).toLowerCase();
            if (a === b) { alert("The output folder must be different from the source folder."); return; }
        }
        result = { action: "batch", settings: s };
        w.close(1);
    };

    bLib.onClick = function () {
        var filter = ($.os.indexOf("Windows") >= 0) ? "Illustrator files:*.ai;*.pdf;*.eps,All files:*.*" :
            function (ff) { return (ff instanceof Folder) || /\.(ai|pdf|eps)$/i.test(decodeURI(ff.name)); };
        var f = File.openDialog("Choose the .ai file that holds your reference spot swatches", filter);
        if (!f) return;
        etLib.text = f.fsName;
        collect();
        result = { action: "library", settings: s }; // dialog reopens after the file is read
        w.close(1);
    };

    fillPresets(s.lastPreset);
    fillRules(0);
    syncOut();
    syncLib();
    w.show();
    return result;
}

// ==========================================================================
// ENTRY POINT
// ==========================================================================
// Loads (or clears) the reference swatch file named in the settings. Cached
// between dialog rounds; reloaded when the path changes.
function bcsEnsureLibrary(s, quiet) {
    var path = bcsTrim(s.swatchLibrary);
    if (!path) { BCS.library = null; BCS.libraryPath = ""; return true; }
    if (BCS.library && BCS.libraryPath === path) return true;
    try {
        BCS.library = bcsLoadLibrary(path);
        BCS.libraryPath = path;
        return true;
    } catch (e) {
        BCS.library = null;
        BCS.libraryPath = "";
        if (!quiet) alert("Could not read the reference swatch file:\n" + e.message);
        return false;
    }
}

function bcsMain() {
    var s = bcsLoadSettings();
    bcsEnsureExamplePreset();
    bcsEnsureLibrary(s, true);
    while (true) {
        var r = bcsShowMainDialog(s);
        if (!r) return;
        s = r.settings;
        bcsSaveSettings(s);
        if (r.action === "library") {
            BCS.libraryPath = ""; // force a fresh read
            if (bcsEnsureLibrary(s, false) && BCS.library && !BCS.library.names.length)
                alert("No spot swatches were found in that file.\n\nAdd the Pantone colors to its Swatches panel (e.g. from Pantone Connect), save it, and choose it again.");
            continue;
        }
        if (!bcsEnsureLibrary(s, false)) continue;
        if (r.action === "test") { bcsRunOnActive(s); continue; }
        if (r.action === "batch") { bcsRunBatch(s); return; }
    }
}

if (typeof app !== "undefined" && typeof BCS_NO_AUTORUN === "undefined") {
    try { bcsMain(); } catch (e) { alert("Batch Color Swap error:\n" + e.message + (e.line ? "\n(line " + e.line + ")" : "")); }
}
