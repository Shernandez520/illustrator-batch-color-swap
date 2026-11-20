// Mock just enough of Illustrator's DOM to exercise the engine.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function CMYKColor() { this.typename = 'CMYKColor'; this.cyan = 0; this.magenta = 0; this.yellow = 0; this.black = 0; }
function RGBColor() { this.typename = 'RGBColor'; this.red = 0; this.green = 0; this.blue = 0; }
function GrayColor() { this.typename = 'GrayColor'; this.gray = 0; }
function NoColor() { this.typename = 'NoColor'; }
function SpotColor() { this.typename = 'SpotColor'; this.spot = null; this.tint = 100; }
const ColorModel = { SPOT: 'SPOT', PROCESS: 'PROCESS', REGISTRATION: 'REG' };
function LabColor() { this.typename = 'LabColor'; this.l = 0; this.a = 0; this.b = 0; }
const SpotColorKind = { SPOTLAB: 'SPOTLAB', SPOTCMYK: 'SPOTCMYK' };
const ImageColorSpace = { LAB: 'LAB', RGB: 'RGB', CMYK: 'CMYK' };
const ColorConvertPurpose = { defaultpurpose: 'default' };
const app = { documents: [], convertSampleColor: (from, v, to) => from === 'LAB' ? [70, 30, 0, 40] : null };

function cmyk(c, m, y, k) { const x = new CMYKColor(); x.cyan = c; x.magenta = m; x.yellow = y; x.black = k; return x; }

function makeDoc() {
  const doc = { typename: 'Document', spots: [], swatches: [], pathItems: [], textFrames: [], gradients: [], layers: [] };
  doc.spots.add = function () {
    const sp = { typename: 'Spot', name: 'New', color: null, colorType: ColorModel.PROCESS,
      remove() { doc.spots.splice(doc.spots.indexOf(sp), 1); doc.removed = (doc.removed || []).concat(sp.name); } };
    doc.spots.push(sp); return sp;
  };
  doc.addSpot = function (name, color, type) { const sp = doc.spots.add(); sp.name = name; sp.color = color; sp.colorType = type || ColorModel.SPOT; return sp; };
  return doc;
}
function spotColor(sp, tint) { const s = new SpotColor(); s.spot = sp; s.tint = tint === undefined ? 100 : tint; return s; }
function layer(name, opts) { return Object.assign({ typename: 'Layer', name, locked: false, visible: true, layers: [] }, opts || {}); }
function path(fill, stroke, opts) {
  const p = Object.assign({ typename: 'PathItem', filled: !!fill, stroked: !!stroke, guides: false, locked: false, hidden: false, parent: null }, opts || {});
  let _fill = fill || new NoColor(), _stroke = stroke || new NoColor();
  Object.defineProperty(p, 'fillColor', { get: () => _fill, set: v => { if (p.locked || (p.parent && p.parent.locked)) throw new Error('locked'); _fill = v; } });
  Object.defineProperty(p, 'strokeColor', { get: () => _stroke, set: v => { if (p.locked) throw new Error('locked'); _stroke = v; } });
  return p;
}

const src = fs.readFileSync(__dirname + '/../Batch_Color_Swap.jsx', 'utf8').replace(/^#target.*$/m, '');
const ctx = { CMYKColor, RGBColor, GrayColor, NoColor, SpotColor, ColorModel, LabColor, SpotColorKind, ImageColorSpace, ColorConvertPurpose, app, BCS_NO_AUTORUN: true };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const S = ctx;

function settings(over) {
  const s = S.bcsDefaultSettings();
  s.hideLayers = ''; s.removeMatchedSpots = false;
  return Object.assign(s, over || {});
}
let pass = 0; function ok(name, fn) { fn(); pass++; console.log('  ok -', name); }

// ---------- JSON round trip ----------
ok('stringify/parse round trip', () => {
  const s = S.bcsDefaultSettings();
  const back = S.bcsNormalizeSettings(S.bcsParse(S.bcsStringify(s)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(s)));
  assert.throws(() => S.bcsParse('{"a": alert(1)}'));
  assert.strictEqual(S.bcsParse('"a\\"b\\u0041"'), 'a"bA');
});

// ---------- Starter preset reproduces original magenta->white ----------
ok('SC file: magenta -> spot White; process white -> spot White; dup white spots removed', () => {
  const doc = makeDoc();
  const magSpot = doc.addSpot('Magenta Spot', cmyk(0, 100, 0, 0));
  const white2 = doc.addSpot('WHITE 2', cmyk(0, 0, 0, 0));
  const a = path(cmyk(0, 100, 0, 0), cmyk(0, 99.8, 0, 0));
  const b = path(cmyk(0, 0, 0, 0));
  const c = path(spotColor(magSpot, 50));
  const d = path(spotColor(white2));
  const e = path(cmyk(100, 0, 0, 0));
  doc.pathItems.push(a, b, c, d, e);
  const s = settings({ removeMatchedSpots: true });
  const res = S.bcsProcessDocument(doc, s, 'Job123_SCProduction.pdf');
  assert.strictEqual(res.status, 'CHANGED');
  for (const p of [a, b, d]) assert.strictEqual(p.fillColor.spot.name, 'White');
  assert.strictEqual(a.strokeColor.spot.name, 'White');
  assert.strictEqual(c.fillColor.spot.name, 'White');
  assert.strictEqual(c.fillColor.tint, 50, 'keeps tint');
  assert.strictEqual(e.fillColor.cyan, 100, 'cyan untouched');
  assert.strictEqual(doc.spots.filter(x => x.name === 'White').length, 1);
  assert.strictEqual(doc.spots.find(x => x.name === 'White').colorType, 'SPOT');
  assert.ok(doc.removed.includes('WHITE 2') && doc.removed.includes('Magenta Spot'));
  assert.strictEqual(res.stats.fills, 4); assert.strictEqual(res.stats.strokes, 1);
});

ok('FC file: magenta -> process white, whites untouched, no spot created', () => {
  const doc = makeDoc();
  const a = path(cmyk(0, 100, 0, 0));
  const b = path(cmyk(0, 0, 0, 0));
  doc.pathItems.push(a, b);
  const res = S.bcsProcessDocument(doc, settings(), 'Job123_FCProduction.pdf');
  assert.strictEqual(a.fillColor.typename, 'CMYKColor');
  assert.strictEqual(a.fillColor.magenta, 0);
  assert.strictEqual(res.stats.fills, 1);
  assert.strictEqual(doc.spots.length, 0);
});

ok('Existing spot "White" is not re-applied (no needless save)', () => {
  const doc = makeDoc();
  const w = doc.addSpot('White', cmyk(0, 0, 0, 0));
  doc.pathItems.push(path(spotColor(w)));
  const res = S.bcsProcessDocument(doc, settings(), 'x_SCProduction.pdf');
  assert.strictEqual(res.status, 'NO_MATCH');
});

ok('Case-insensitive reuse of existing spot "WHITE", renamed to "White"', () => {
  const doc = makeDoc();
  doc.addSpot('WHITE', cmyk(0, 0, 0, 0));
  const a = path(cmyk(0, 100, 0, 0));
  doc.pathItems.push(a);
  S.bcsProcessDocument(doc, settings(), 'x_SCProduction.pdf');
  assert.strictEqual(doc.spots.length, 1);
  assert.strictEqual(doc.spots[0].name, 'White');
  assert.strictEqual(a.fillColor.spot, doc.spots[0]);
});

// ---------- Generic any-to-any ----------
function rulesSettings(rules, over) { return settings(Object.assign({ rules: rules.map(S.bcsNormalizeRule), spotKeyword: '' }, over || {})); }

ok('CMYK -> new spot PMS with alt values; fill only', () => {
  const doc = makeDoc();
  const a = path(cmyk(100, 80, 0, 10), cmyk(100, 80, 0, 10));
  doc.pathItems.push(a);
  const s = rulesSettings([{ fill: true, stroke: false, src: { type: 'CMYK', v: [100, 80, 0, 10] }, dst: { type: 'SPOT', spotName: 'PMS 2945 C', alt: [100, 45, 0, 14] } }]);
  S.bcsProcessDocument(doc, s, 'any.pdf');
  assert.strictEqual(a.fillColor.spot.name, 'PMS 2945 C');
  assert.deepStrictEqual([a.fillColor.spot.color.cyan, a.fillColor.spot.color.magenta], [100, 45]);
  assert.strictEqual(a.strokeColor.typename, 'CMYKColor', 'stroke untouched');
});

ok('Global process swatch matched by values', () => {
  const doc = makeDoc();
  const g = doc.addSpot('Brand Red', cmyk(0, 100, 100, 0), ColorModel.PROCESS);
  const a = path(spotColor(g));
  doc.pathItems.push(a);
  const s = rulesSettings([{ src: { type: 'CMYK', v: [0, 100, 100, 0] }, dst: { type: 'CMYK', v: [0, 90, 80, 5] } }]);
  S.bcsProcessDocument(doc, s, 'f.pdf');
  assert.strictEqual(a.fillColor.typename, 'CMYKColor');
  assert.strictEqual(a.fillColor.yellow, 80);
  const s2 = rulesSettings([{ src: { type: 'CMYK', v: [0, 100, 100, 0], matchGlobal: false }, dst: { type: 'CMYK', v: [1, 1, 1, 1] } }]);
  const b = path(spotColor(g)); const doc2 = makeDoc(); doc2.spots.push(g); doc2.pathItems.push(b);
  assert.strictEqual(S.bcsProcessDocument(doc2, s2, 'f.pdf').status, 'NO_MATCH');
});

ok('RGB source, Gray target, NONE target removes stroke', () => {
  const doc = makeDoc();
  const rgb = new RGBColor(); rgb.red = 255; rgb.green = 0; rgb.blue = 255;
  const a = path(rgb, cmyk(0, 0, 0, 100));
  doc.pathItems.push(a);
  const s = rulesSettings([
    { stroke: false, src: { type: 'RGB', v: [255, 0, 255], tol: 1 }, dst: { type: 'GRAY', v: [40] } },
    { fill: false, src: { type: 'CMYK', v: [0, 0, 0, 100] }, dst: { type: 'NONE' } }]);
  S.bcsProcessDocument(doc, s, 'f.pdf');
  assert.strictEqual(a.fillColor.typename, 'GrayColor'); assert.strictEqual(a.fillColor.gray, 40);
  assert.strictEqual(a.stroked, false);
});

ok('First match wins - no chaining A->B->C', () => {
  const doc = makeDoc();
  const a = path(cmyk(0, 100, 0, 0));
  doc.pathItems.push(a);
  const s = rulesSettings([
    { src: { type: 'CMYK', v: [0, 100, 0, 0] }, dst: { type: 'CMYK', v: [100, 0, 0, 0] } },
    { src: { type: 'CMYK', v: [100, 0, 0, 0] }, dst: { type: 'CMYK', v: [0, 0, 100, 0] } }]);
  S.bcsProcessDocument(doc, s, 'f.pdf');
  assert.strictEqual(a.fillColor.cyan, 100); assert.strictEqual(a.fillColor.yellow, 0);
});

ok('Tolerance respected', () => {
  const doc = makeDoc();
  const a = path(cmyk(0, 98, 0, 0));
  doc.pathItems.push(a);
  const s = rulesSettings([{ src: { type: 'CMYK', v: [0, 100, 0, 0], tol: 0.5 }, dst: { type: 'CMYK', v: [0, 0, 0, 0] } }]);
  assert.strictEqual(S.bcsProcessDocument(doc, s, 'f').status, 'NO_MATCH');
  s.rules[0].src.tol = 3;
  assert.strictEqual(S.bcsProcessDocument(doc, s, 'f').status, 'CHANGED');
});

ok('File filter with ! (NOT) and comma lists', () => {
  assert.strictEqual(S.bcsFileFilterPasses('!SCProduction', 'a_FCProduction.pdf'), true);
  assert.strictEqual(S.bcsFileFilterPasses('!SCProduction', 'a_scproduction.pdf'), false);
  assert.strictEqual(S.bcsFileFilterPasses('foo, bar', 'xBARx.pdf'), true);
  assert.strictEqual(S.bcsFileFilterPasses('', 'x'), true);
});

ok('Spot name match: exact vs contains, comma list', () => {
  assert.ok(S.bcsNameMatches('PMS 185 C', 'pms 185', 'contains'));
  assert.ok(!S.bcsNameMatches('PMS 185 C', 'pms 185', 'exact'));
  assert.ok(S.bcsNameMatches('Old Red', 'blue, old red', 'exact'));
});

ok('Locked item inside locked group gets changed, then relocked; locked layer restored', () => {
  const doc = makeDoc();
  const L = layer('Art', { locked: true, visible: false });
  doc.layers.push(L);
  const grp = { typename: 'GroupItem', locked: true, hidden: false, parent: L };
  const a = path(cmyk(0, 100, 0, 0), null, { parent: grp });
  doc.pathItems.push(a);
  const s = rulesSettings([{ src: { type: 'CMYK', v: [0, 100, 0, 0] }, dst: { type: 'CMYK', v: [0, 0, 0, 0] } }]);
  const res = S.bcsProcessDocument(doc, s, 'f');
  assert.strictEqual(a.fillColor.magenta, 0);
  assert.strictEqual(grp.locked, true); assert.strictEqual(L.locked, true); assert.strictEqual(L.visible, false);
  assert.strictEqual(res.stats.failed, 0);
  // with includeLocked off it is reported as failed, not silently skipped
  const b = path(cmyk(0, 100, 0, 0), null, { parent: grp }); const d2 = makeDoc(); d2.pathItems.push(b);
  s.includeLocked = false;
  assert.strictEqual(S.bcsProcessDocument(d2, s, 'f').stats.failed, 1);
});

ok('Dry run counts but changes nothing, creates no spots', () => {
  const doc = makeDoc();
  const a = path(cmyk(0, 100, 0, 0));
  doc.pathItems.push(a);
  const res = S.bcsProcessDocument(doc, settings({ dryRun: true }), 'x_SCProduction.pdf');
  assert.strictEqual(res.stats.fills, 1); assert.strictEqual(a.fillColor.magenta, 100); assert.strictEqual(doc.spots.length, 0);
});

ok('Max paths skip is reported', () => {
  const doc = makeDoc();
  for (let i = 0; i < 5; i++) doc.pathItems.push(path(cmyk(0, 100, 0, 0)));
  const res = S.bcsProcessDocument(doc, settings({ maxPaths: 3 }), 'f');
  assert.strictEqual(res.status, 'SKIPPED');
});

ok('Hide layers (nested, case-insensitive) counts as a change', () => {
  const doc = makeDoc();
  const bg = layer('Background'); const top = layer('Top', { layers: [bg] });
  doc.layers.push(top);
  const res = S.bcsProcessDocument(doc, settings({ hideLayers: 'BACKGROUND', rules: [] }), 'f');
  assert.strictEqual(bg.visible, false); assert.strictEqual(res.status, 'CHANGED');
});

ok('Text characters and gradient stops', () => {
  const doc = makeDoc();
  const chars = [0, 1, 2].map(i => ({ characterAttributes: { fillColor: i === 1 ? cmyk(0, 0, 0, 100) : cmyk(0, 100, 0, 0), strokeColor: new NoColor() } }));
  doc.textFrames.push({ typename: 'TextFrame', parent: null, textRange: { characters: chars } });
  doc.gradients.push({ gradientStops: [{ color: cmyk(0, 100, 0, 0) }, { color: cmyk(0, 0, 0, 0) }] });
  const s = rulesSettings([{ src: { type: 'CMYK', v: [0, 100, 0, 0] }, dst: { type: 'CMYK', v: [0, 0, 100, 0] } }], { doGradients: true });
  const res = S.bcsProcessDocument(doc, s, 'f');
  assert.strictEqual(chars[0].characterAttributes.fillColor.yellow, 100);
  assert.strictEqual(chars[1].characterAttributes.fillColor.black, 100);
  assert.strictEqual(doc.gradients[0].gradientStops[0].color.yellow, 100);
  assert.strictEqual(res.stats.text, 2); assert.strictEqual(res.stats.gradStops, 1);
});


// ---------- v1.1: tints ----------
function lab(l, a, b) { const c = new LabColor(); c.l = l; c.a = a; c.b = b; return c; }
ok('PMS tint -> CMYK target scales the build (keep tint on)', () => {
  const doc = makeDoc();
  const p289 = doc.addSpot('PANTONE 289 C', cmyk(100, 64, 0, 60));
  const a = path(spotColor(p289, 30)), b = path(spotColor(p289, 100));
  doc.pathItems.push(a, b);
  const s = rulesSettings([{ src: { type: 'SPOT', spotName: '289', spotMatch: 'contains' }, dst: { type: 'CMYK', v: [100, 80, 0, 20] } }]);
  S.bcsProcessDocument(doc, s, 'f');
  assert.deepStrictEqual([a.fillColor.cyan, a.fillColor.magenta, a.fillColor.yellow, a.fillColor.black].map(x => +x.toFixed(4)), [30, 24, 0, 6]);
  assert.strictEqual(b.fillColor.cyan, 100);
  // keep tint off -> full build
  const c = path(spotColor(p289, 30)); const d2 = makeDoc(); d2.spots.push(p289); d2.pathItems.push(c);
  s.rules[0].dst.keepTint = false;
  S.bcsProcessDocument(d2, s, 'f');
  assert.strictEqual(c.fillColor.cyan, 100);
});

ok('PMS tint -> RGB target lightens toward white; Gray scales', () => {
  const doc = makeDoc();
  const sp = doc.addSpot('PANTONE 289 C', cmyk(100, 64, 0, 60));
  const a = path(spotColor(sp, 50), spotColor(sp, 50));
  doc.pathItems.push(a);
  const s = rulesSettings([
    { stroke: false, src: { type: 'SPOT', spotName: '289' }, dst: { type: 'RGB', v: [0, 40, 100] } },
    { fill: false, src: { type: 'SPOT', spotName: '289' }, dst: { type: 'GRAY', v: [80] } }]);
  S.bcsProcessDocument(doc, s, 'f');
  assert.deepStrictEqual([a.fillColor.red, a.fillColor.green, a.fillColor.blue], [127.5, 147.5, 177.5]);
  assert.strictEqual(a.strokeColor.gray, 40);
});

// ---------- v1.1: reference swatch file ----------
function refLibrary() {
  const ref = makeDoc();
  ref.addSpot('PANTONE 534 C', lab(28, 2, -30));
  ref.addSpot('PANTONE 186 C', cmyk(0, 100, 81, 4));
  ref.addSpot('Brand Global', cmyk(1, 2, 3, 4), ColorModel.PROCESS);   // not a spot - skipped
  ref.addSpot('[Registration]', cmyk(100, 100, 100, 100), ColorModel.REGISTRATION);
  return S.bcsSnapshotSpots(ref);
}
ok('Snapshot reads only true spots, converts Lab to CMYK for preview', () => {
  const lib = refLibrary();
  assert.strictEqual(JSON.stringify(lib.names), JSON.stringify(['PANTONE 186 C', 'PANTONE 534 C']));
  assert.strictEqual(lib.byName['pantone 534 c'].model, 'LAB');
  assert.strictEqual(JSON.stringify(lib.byName['pantone 534 c'].cmyk), '[70,30,0,40]');
});

const rule289to534 = () => [{ src: { type: 'SPOT', spotName: 'PANTONE 289 C', spotMatch: 'exact' }, dst: { type: 'SPOT', spotName: 'PANTONE 534 C', alt: [9, 9, 9, 9] } }];

ok('289 -> 534 when 534 is missing: created from reference (Lab), tints kept, old 289 removed', () => {
  S.BCS.library = refLibrary();
  const doc = makeDoc();
  const p289 = doc.addSpot('PANTONE 289 C', cmyk(100, 64, 0, 60));
  const a = path(spotColor(p289), spotColor(p289, 40));
  doc.pathItems.push(a);
  const res = S.bcsProcessDocument(doc, rulesSettings(rule289to534(), { removeMatchedSpots: true }), 'f');
  const sp = doc.spots.find(x => x.name === 'PANTONE 534 C');
  assert.ok(sp); assert.strictEqual(sp.color.typename, 'LabColor'); assert.strictEqual(sp.color.b, -30);
  assert.strictEqual(sp.colorType, 'SPOT');
  assert.strictEqual(a.fillColor.spot, sp); assert.strictEqual(a.strokeColor.tint, 40);
  assert.ok(!doc.spots.find(x => x.name === 'PANTONE 289 C'));
  assert.ok(/from reference file/.test(res.note), res.note);
});

ok('Existing 534 in file: kept by default, replaced when "update existing" is on', () => {
  S.BCS.library = refLibrary();
  const mk = () => { const d = makeDoc(); d.addSpot('PANTONE 534 C', cmyk(5, 5, 5, 5)); const p = d.addSpot('PANTONE 289 C', cmyk(1, 1, 1, 1)); d.pathItems.push(path(spotColor(p))); return d; };
  const d1 = mk(); S.bcsProcessDocument(d1, rulesSettings(rule289to534()), 'f');
  assert.strictEqual(d1.spots.find(x => x.name === 'PANTONE 534 C').color.typename, 'CMYKColor');
  const d2 = mk(); const res = S.bcsProcessDocument(d2, rulesSettings(rule289to534(), { updateExistingSwatches: true }), 'f');
  assert.strictEqual(d2.spots.find(x => x.name === 'PANTONE 534 C').color.typename, 'LabColor');
  assert.ok(/updated from reference/.test(res.note));
});

ok('Target not in reference file falls back to typed CMYK and says so in the log', () => {
  S.BCS.library = refLibrary();
  const doc = makeDoc();
  const p = doc.addSpot('PANTONE 289 C', cmyk(1, 1, 1, 1));
  doc.pathItems.push(path(spotColor(p)));
  const rules = rule289to534(); rules[0].dst.spotName = 'PANTONE 999 C';
  const res = S.bcsProcessDocument(doc, rulesSettings(rules), 'f');
  assert.strictEqual(doc.spots.find(x => x.name === 'PANTONE 999 C').color.cyan, 9);
  assert.ok(/NOT in reference file/.test(res.note));
});

ok('Process-mode file with spot target uses the rule CMYK, scaled by tint', () => {
  S.BCS.library = refLibrary();
  const doc = makeDoc();
  const p = doc.addSpot('PANTONE 289 C', cmyk(1, 1, 1, 1));
  const a = path(spotColor(p, 50)); doc.pathItems.push(a);
  const rules = rule289to534(); rules[0].dst.alt = [70, 30, 0, 40];
  S.bcsProcessDocument(doc, rulesSettings(rules, { spotKeyword: 'SCProduction' }), 'x_FCProduction.pdf');
  assert.deepStrictEqual([a.fillColor.cyan, a.fillColor.black], [35, 20]);
  assert.ok(!doc.spots.find(x => x.name === 'PANTONE 534 C'));
  S.BCS.library = null;
});

ok('Settings round trip keeps new fields', () => {
  const s = S.bcsDefaultSettings(); s.swatchLibrary = '/x/Ref.ai'; s.updateExistingSwatches = true;
  const back = S.bcsNormalizeSettings(S.bcsParse(S.bcsStringify(s)));
  assert.strictEqual(back.swatchLibrary, '/x/Ref.ai'); assert.strictEqual(back.updateExistingSwatches, true);
});

ok('Rule summaries render', () => {
  S.bcsStarterRules().forEach((r, i) => console.log('      ' + S.bcsRuleSummary(r, i)));
});

console.log(`\n${pass} tests passed`);
