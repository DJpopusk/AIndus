// Overlay: dancing 3D models (Sketchfab models, dances from mocap datasets), Holi powder,
// falling particles, the title and music.
// Lives in an extension iframe on top of the page and is driven by postMessage from content.js.

import * as THREE from './vendor/three/three.module.min.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { clone as skeletonClone } from './vendor/three/SkeletonUtils.js';
import { MeshoptDecoder } from './vendor/three/meshopt_decoder.module.js';
import { mergeGeometries } from './vendor/three/BufferGeometryUtils.js';

const $ = (id) => document.getElementById(id);
let canvas = $('gl');
const parentOrigin = '*'; // the parent is Instagram/YouTube, checked through event.source
let settings = { sound: true, volume: 0.7, dancers: 18, fx: 1, cows: true, gods: true, fall: 'theme', backdrop: true, animals: true, traffic: true };

// ---------- assets ----------
// Dances are built by scripts/make-dances.py from three sources that allow redistribution: AIST++ (street
// dance: hip-hop, locking, popping, krump, waacking, house; CC BY 4.0), 100STYLE (funny styles: chicken, zombie,
// robot, penguin and more; CC BY 4.0) and the CMU mocap database (Indian dance, pantomimes). The GLB holds a skeleton
// with Mixamo bone names and no rotations; the animation is joint positions. bakeRetarget moves a dance onto a model
// by matching bone directions.
const DANCE_FILE = 'assets/dances/dances.glb';
// dance metadata (dances.json): category street / rofl / indian, title, arm reach
const danceMeta = {};
const danceMetaLoaded = fetch(chrome.runtime.getURL('assets/dances/dances.json')).then((r) => r.json())
  .then((d) => { for (const c of d.clips) danceMeta[c.take] = c; }).catch(() => {});
// category shares per celebration theme. Modern and funny dances are the base and Indian ones add flavour
// (more of them on the bollywood, wedding and diwali themes)
const DANCE_MIX = {
  default: { street: 45, rofl: 35, indian: 20 },
  bollywood: { street: 35, rofl: 30, indian: 35 }, wedding: { street: 35, rofl: 30, indian: 35 }, diwali: { street: 35, rofl: 30, indian: 35 },
  spidey: { street: 60, rofl: 40, indian: 0 },
};
const danceTag = (clip) => (danceMeta[clip.name]?.tags || ['street'])[0];
// pick a dance: first a category by the theme's shares, then a random dance in it. only is a list of allowed
// names (models with fragile skinning have one in people.json: dances)
function pickDance(clips, only = null) {
  const pool = clips.map((c, i) => i).filter((i) => !only || only.includes(clips[i].name));
  if (!pool.length) return Math.floor(Math.random() * clips.length);
  const mix = DANCE_MIX[theme?.name] || DANCE_MIX.default;
  const tags = [...new Set(pool.map((i) => danceTag(clips[i])))].filter((t) => (mix[t] ?? 10) > 0);
  if (!tags.length) return rnd(pool);
  let r = Math.random() * tags.reduce((a, t) => a + (mix[t] ?? 10), 0), tag = tags[tags.length - 1];
  for (const t of tags) { r -= (mix[t] ?? 10); if (r <= 0) { tag = t; break; } }
  return rnd(pool.filter((i) => danceTag(clips[i]) === tag));
}
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);        // models are meshopt-compressed (scripts/compress-models.py)
let peopleDir = 'assets/models/people/';        // debugging: compare with compressed or original copies
const loadGltf = (p) => new Promise((res, rej) => loader.load(chrome.runtime.getURL(p), res, undefined, rej));

// Indian character models (downloaded from Sketchfab, see people.json).
// They use a Mixamo skeleton, but bone names carry suffixes like Hips_01 and a mixamorig: prefix,
// so they are renamed to plain Mixamo names, which is what bakeRetarget matches on.
let people = [];
const peopleLoaded = fetch(chrome.runtime.getURL('assets/models/people/people.json'))
  .then((r) => r.json()).then((p) => { people = p; }).catch(() => { people = []; });
const peopleCache = new Map();
// One model takes tens of megabytes of video memory even after compression, so only a limited number of
// different models is kept per session. The set is picked at random, so the dancers change between runs.
const MAX_LOADED = 16;  // different models in video memory at once; the rest are unloaded (evictPeople)
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
// Cast for a celebration: up to four themed models, one star, then models already loaded (to avoid
// extra downloads) and random ones. Never more than MAX_LOADED in total.
function castFor(themeName) {
  const humans = people.filter((p) => (p.kind === 'm' || p.kind === 'f') && p.file !== SPIDEY_FILE);   // Spider-Man only appears in his own show
  const themed = shuffle(humans.filter((p) => (p.themes || []).includes(themeName))).slice(0, 4);
  const pick = new Set(themed);
  // Modi: almost always at least one, both every other time
  const modis = shuffle(humans.filter((p) => /^modi/.test(p.file)));
  if (modis[0]) pick.add(modis[0]);
  if (modis[1] && Math.random() < 0.5) pick.add(modis[1]);
  const star = shuffle(humans.filter((p) => p.featured && !pick.has(p)))[0];
  if (star) pick.add(star);
  for (const p of shuffle(humans.filter((p) => peopleCache.has(p.file)))) if (pick.size < MAX_LOADED - 2) pick.add(p);
  for (const p of shuffle(humans)) if (pick.size < 11) pick.add(p);           // for a crowd of 18, 11 different models; repeats get recoloured
  if (themeName === 'spidey') { const sp = people.find((p) => p.file === SPIDEY_FILE); if (sp) pick.add(sp); }
  return [...pick];
}
// unload models that are not on stage while more than MAX_LOADED are loaded, least recently used first
function evictPeople(onStage) {
  const humans = [...peopleCache.entries()].filter(([f]) => { const r = people.find((p) => p.file === f); return r && (r.kind === 'm' || r.kind === 'f'); });
  if (humans.length <= MAX_LOADED) return;
  const victims = humans.filter(([f]) => !onStage.has(f)).sort((a, b) => (a[1].usedAt || 0) - (b[1].usedAt || 0));
  for (const [f, c] of victims.slice(0, humans.length - MAX_LOADED)) {
    c.holder.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); }
    });
    peopleCache.delete(f); fitCache.delete(f);
    for (const k of [...retargetCache.keys()]) if (k.startsWith(f + '|')) retargetCache.delete(k);
  }
}
// Bone names to Mixamo: the mixamorig: prefix, Sketchfab suffixes (_01, sometimes a double _66_0), and the
// Character Creator skeleton (CC_Base_L_Upperarm -> LeftArm), which three models use.
const CC_BODY = { Hip: 'Hips', Waist: 'Spine', Spine01: 'Spine1', Spine02: 'Spine2', NeckTwist01: 'Neck', Head: 'Head' };
const CC_SIDE = { Clavicle: 'Shoulder', Upperarm: 'Arm', Forearm: 'ForeArm', Hand: 'Hand', Thigh: 'UpLeg', Calf: 'Leg', Foot: 'Foot', ToeBase: 'ToeBase' };
const CC_FINGER = { Index: 'Index', Mid: 'Middle', Ring: 'Ring', Pinky: 'Pinky', Thumb: 'Thumb' };
function cleanBone(n) {
  const b = n.split(':').pop().replace(/^mixamorig_?/, '').replace(/(_\d+)+$/, '');
  const cc = /^(?:Default_)?CC_Base_(?:([LR])_)?([A-Za-z]+)(\d*)(?:_Default)?$/.exec(b);
  if (!cc) return b;
  const [, side, part, num] = cc, S = side === 'L' ? 'Left' : 'Right';
  if (!side) return CC_BODY[part + num] || b;
  if (CC_SIDE[part] && !num) return S + CC_SIDE[part];
  if (CC_FINGER[part] && num) return `${S}Hand${CC_FINGER[part]}${num}`;
  return b;
}

// Some models (Modi, the policeman) export every material as semi-transparent (BLEND), so the body shows
// through when rendered. Body and clothes are made opaque, hair and eyelashes keep alpha cutout, and
// only glass and corneas stay transparent.
const GLASSY = /glass|cornea|eyewear|lens/i, CUTOUT = /hair|lash|brow|beard|moustache|mustache/i;
function fixAlpha(mesh) {
  for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    if (!m || !m.transparent || GLASSY.test(m.name || '')) continue;
    m.transparent = false;
    m.depthWrite = true;
    m.opacity = 1;
    m.alphaTest = CUTOUT.test(m.name || '') ? 0.5 : 0;
    m.needsUpdate = true;
  }
}

// Spatial smoothing of skin weights. On the second Modi the vest and the shirt under it are two layers a centimetre
// apart, but they are bound to different bones: in motion they separate and the shirt shows through the vest as dark
// holes. Each vertex's weights are averaged with its neighbours (Gaussian) within frac of the model size, 4% for that
// model (people.json: smoothSkin). Close layers end up with the same weights and move together. The geometry is shared
// by all clones, so this runs once at load time.
function smoothSkin(mesh, frac, passes = 2) {
  const g = mesh.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  if (!P || !SI || !SW || !mesh.skeleton) return;
  // hands and forearms hang right next to the kurta. Their weights must not spread into the cloth, or the hem
  // follows the hand. These bones only keep vertices that were already bound to them.
  const bones = mesh.skeleton.bones;
  const distal = bones.map((b) => { const m = /^(Left|Right).*(ForeArm|Hand)/.exec(cleanBone(b.name)); return m ? m[1] : null; });
  const n = P.count, nb = mesh.skeleton.bones.length;
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) * frac, r2 = r * r, s2 = 2 * (r / 2) ** 2;
  const cell = (v) => Math.floor(v / r);
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${cell(P.getX(i))},${cell(P.getY(i))},${cell(P.getZ(i))}`;
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  }
  let cur = new Float32Array(n * nb);
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) cur[i * nb + SI.getComponent(i, c)] += SW.getComponent(i, c);
  // The automatic rig gave the vest near the hip up to 44% forearm weight because the arm rests next to it.
  // Bend the arm and a piece of vest goes with it like a blade. If a vertex is mostly not arm
  // (less than half its weight on that side's arm), forearm and hand weights are removed from it.
  const armOf = bones.map((b) => { const m = /^(Left|Right)(Arm|ForeArm|Hand)/.exec(cleanBone(b.name)); return m ? m[1] : null; });
  // Same for the upper arm bone, but stricter: under a third of the weight on the arm means it is the side of the vest,
  // which would follow the arm like a flag. The armpit creases a little, but such models have limited arms anyway (rom).
  for (let i = 0; i < n; i++) for (const side of ['Left', 'Right']) {
    let chain = 0, fore = 0;
    for (let b = 0; b < nb; b++) if (armOf[b] === side) { chain += cur[i * nb + b]; if (distal[b]) fore += cur[i * nb + b]; }
    const strip = chain < 0.35 ? chain : chain < 0.5 ? fore : 0;
    if (strip > 0) {
      for (let b = 0; b < nb; b++) if (armOf[b] === side && (chain < 0.35 || distal[b])) cur[i * nb + b] = 0;
      const rest = 1 - strip;
      if (rest > 1e-3) for (let b = 0; b < nb; b++) cur[i * nb + b] /= rest;
    }
  }
  const sides = new Uint8Array(n);                        // bit 1: left hand/forearm weight left, bit 2: right
  for (let i = 0; i < n; i++) for (let b = 0; b < nb; b++) if (distal[b] && cur[i * nb + b] > 0) sides[i] |= distal[b] === 'Left' ? 1 : 2;
  const allowed = (i, b) => !distal[b] || (sides[i] & (distal[b] === 'Left' ? 1 : 2));
  // neighbours and their weights are computed once
  const nbrs = [], wts = [];
  for (let i = 0; i < n; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i), cx = cell(x), cy = cell(y), cz = cell(z);
    const ids = [], ws = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = grid.get(`${cx + a},${cy + b},${cz + c}`);
      if (!list) continue;
      for (const j of list) {
        const d2 = (P.getX(j) - x) ** 2 + (P.getY(j) - y) ** 2 + (P.getZ(j) - z) ** 2;
        if (d2 <= r2) { ids.push(j); ws.push(Math.exp(-d2 / s2)); }
      }
    }
    nbrs.push(ids); wts.push(ws);
  }
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(n * nb);
    for (let i = 0; i < n; i++) {
      const ids = nbrs[i], ws = wts[i];
      let tot = 0;
      for (let k = 0; k < ids.length; k++) {
        const j = ids[k], w = ws[k];
        tot += w;
        for (let b = 0; b < nb; b++) { const v = cur[j * nb + b]; if (v && allowed(i, b)) next[i * nb + b] += v * w; }
      }
      if (tot > 0) for (let b = 0; b < nb; b++) next[i * nb + b] /= tot;
    }
    cur = next;
  }
  // back to the four heaviest bones per vertex
  for (let i = 0; i < n; i++) {
    const top = [];
    for (let b = 0; b < nb; b++) { const v = cur[i * nb + b]; if (v > 1e-4) top.push([v, b]); }
    top.sort((p, q) => q[0] - p[0]);
    const t4 = top.slice(0, 4), sum = t4.reduce((a, [v]) => a + v, 0) || 1;
    for (let c = 0; c < 4; c++) {
      SI.setComponent(i, c, t4[c] ? t4[c][1] : 0);
      SW.setComponent(i, c, t4[c] ? t4[c][0] / sum : 0);
    }
  }
  SI.needsUpdate = true; SW.needsUpdate = true;
}

// Cow legs: thigh -> shin -> foot chains. The two rigs name them differently: rigify on the Polish cow
// (front_thigh.L, thigh.R...) and Biped on Cow Dance (LegF_0.L, LegB_0.R...); the loader strips the dots from names.
function cowLegs(root) {
  const out = [];
  root.traverse((b) => {
    if (!b.isBone) return;
    const m = /^(front_thigh|thigh|LegF_0|LegB_0)\.?([LR])(_\d+)?$/.exec(b.name);
    if (!m) return;
    const chain = [b];
    for (let x = b; chain.length < 3;) { x = x.children.find((c) => c.isBone); if (!x) break; chain.push(x); }
    if (chain.length === 3) out.push({ chain, front: /front|LegF/.test(m[1]), side: m[2] });
  });
  return out;
}
// rotate a bone so it points (at its child) in the given world direction
function aimBone(b, dir) {
  const child = b.children.find((c) => c.isBone); if (!child || !b.parent) return;
  const d = child.getWorldPosition(new THREE.Vector3()).sub(b.getWorldPosition(new THREE.Vector3())).normalize();
  const w = new THREE.Quaternion().setFromUnitVectors(d, dir.clone().normalize()).multiply(b.getWorldQuaternion(new THREE.Quaternion()));
  b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(w));
  b.updateMatrixWorld(true);
}

// Bounds from skinned vertices without outliers. The Polish cow has unweighted vertices that end up metres away
// after skinning, and an exact Box3 shifted both the centre and the body axis (the cow stood sideways).
// We take the 0.5th and 99.5th percentiles on each axis.
function robustBox(root) {
  root.updateMatrixWorld(true);
  const xs = [], ys = [], zs = [], v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    // only vertices referenced by triangles: a trimmed pedestal stays in the buffer but is not drawn
    const n = o.geometry.attributes.position.count, idx = o.geometry.index, used = idx ? new Uint8Array(n) : null;
    if (idx) for (let t = 0; t < idx.count; t++) used[idx.getX(t)] = 1;
    const step = Math.max(1, Math.floor(n / 20000));
    for (let i = 0; i < n; i += step) {
      if (used && !used[i]) continue;
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld); xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  });
  const q = (a, p) => { a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))]; };
  if (!xs.length) return new THREE.Box3().setFromObject(root);
  return new THREE.Box3(new THREE.Vector3(q(xs, 0.005), q(ys, 0.005), q(zs, 0.005)), new THREE.Vector3(q(xs, 0.995), q(ys, 0.995), q(zs, 0.995)));
}

async function loadPerson(rec) {
  if (!peopleCache.has(rec.file)) {
    const g = await loadGltf(peopleDir + rec.file);
    // human bones are renamed to match our dances; cows keep theirs, they have their own animation
    g.scene.traverse((o) => {
      if ((rec.kind === 'm' || rec.kind === 'f') && o.name) o.name = cleanBone(o.name);   // animals, cows and gods keep their own bone names
      if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; fixAlpha(o); }
      if (o.isSkinnedMesh && rec.smoothSkin) smoothSkin(o, rec.smoothSkin);
    });
    // Unskinned parts outside the skeleton (a turban, someone's glasses) stay in place while the body dances.
    // Each one is attached to the nearest bone with its world transform kept, so it moves with that bone.
    if (rec.kind === 'm' || rec.kind === 'f') {
      g.scene.updateMatrixWorld(true);
      const bones = []; g.scene.traverse((o) => { if (o.isBone) bones.push(o); });
      const orphans = [];
      g.scene.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) { let x = o.parent; while (x && !x.isBone) x = x.parent; if (!x) orphans.push(o); } });
      const c = new THREE.Vector3(), bp = new THREE.Vector3();
      for (const o of bones.length ? orphans : []) {
        new THREE.Box3().setFromObject(o).getCenter(c);
        let best = null, bd = Infinity;
        for (const b of bones) { const d = b.getWorldPosition(bp).distanceTo(c); if (d < bd) { bd = d; best = b; } }
        if (best) best.attach(o);
      }
      if (orphans.length) console.log(`[ИИндус] ${rec.file}: прицепил к костям ${orphans.length} деталей`);
    }
    // Size comes from the bones, not the mesh: a skinned mesh's bounding box is computed in bind pose
    // and is off by a factor of two for these models (a person 3.4 m tall). Bones are where they really are.
    g.scene.updateMatrixWorld(true);
    const measure = () => {
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity), v = new THREE.Vector3();
      let n = 0;
      g.scene.traverse((o) => { if (o.isBone) { o.getWorldPosition(v); lo.min(v); hi.max(v); n++; } });
      if (!n) { const bb = new THREE.Box3().setFromObject(g.scene); lo.copy(bb.min); hi.copy(bb.max); }
      return { lo, hi, h: hi.y - lo.y, d: hi.z - lo.z };
    };
    // Some rigs have helper bones high above the head, so the overall span is wrong (a person 3.4 m tall).
    // For people we measure what matters: head top minus foot. For the old RPM dummies that was 1.48 m.
    const boneY = (names) => {
      let best = null;
      g.scene.traverse((o) => {
        if (!o.isBone || !names.includes(o.name)) return;
        const y = o.getWorldPosition(new THREE.Vector3()).y;
        best = best === null ? y : (names === FEET ? Math.min(best, y) : Math.max(best, y));
      });
      return best;
    };
    const FEET = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
    let m = measure();
    if (rec.kind === 'm' || rec.kind === 'f') {
      const head = boneY(['Head']), foot = boneY(FEET);
      if (head !== null && foot !== null && head - foot > 0.05) { m = { ...m, h: head - foot, lo: new THREE.Vector3(m.lo.x, foot, m.lo.z) };
        m.byBones = true; }
    }
    // Z-up axis (a common Blender export): depth is then larger than height, so the model is stood up.
    // The rotation comes from people.json: guessing it from the bounds was unreliable (a cow ended up on its nose)
    if (rec.rotX) {
      g.scene.rotation.x = rec.rotX * Math.PI / 180;
      g.scene.updateMatrixWorld(true);
      m = measure();
    }
    // statue bones (if any) say nothing about the body, so measure the exact skinned mesh bounds
    if (rec.kind === 'god') {
      // Statue scans sometimes include a wide flat pedestal or stand. It looks like a flying board and inflates the
      // bounds, so meshes that are almost flat and wider than half the statue are hidden.
      const whole = new THREE.Box3().setFromObject(g.scene, true), size = whole.getSize(new THREE.Vector3());
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const bb = new THREE.Box3().setFromObject(o, true), sz = bb.getSize(new THREE.Vector3());
        if (sz.y < size.y * 0.04 && Math.max(sz.x, sz.z) > Math.max(size.x, size.z) * 0.5) o.visible = false;
      });
      // Vishnu's stand is a wide slab in the same mesh as the statue, so it cannot be hidden as a whole.
      // In the bottom slice (trimBase, a fraction of the height, people.json) triangles wider than the statue itself are
      // removed: the pedestal is narrower than the arms and stays, the slab is the widest part and goes.
      if (rec.trimBase) {
        const cut = whole.min.y + size.y * rec.trimBase, v = new THREE.Vector3(), meshes = [];
        g.scene.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
        const pts = meshes.map((o) => {
          const P = o.geometry.attributes.position, a = new Float32Array(P.count * 3);
          for (let i = 0; i < P.count; i++) o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld).toArray(a, i * 3);
          return a;
        });
        let cx = 0, cz = 0, n = 0, R = 0;
        for (const a of pts) for (let i = 0; i < a.length; i += 3) if (a[i + 1] >= cut) { cx += a[i]; cz += a[i + 2]; n++; }
        cx /= n || 1; cz /= n || 1;
        for (const a of pts) for (let i = 0; i < a.length; i += 3) if (a[i + 1] >= cut) R = Math.max(R, Math.hypot(a[i] - cx, a[i + 2] - cz));
        meshes.forEach((o, k) => {
          const a = pts[k], cnt = a.length / 3;
          const low = (i) => a[i * 3 + 1] < cut, wide = (i) => Math.hypot(a[i * 3] - cx, a[i * 3 + 2] - cz) > R * 1.02;
          const idx = o.geometry.index ? o.geometry.index.array : Array.from({ length: cnt }, (_, i) => i), keep = [];
          for (let t = 0; t < idx.length; t += 3) {
            const [p, q, r] = [idx[t], idx[t + 1], idx[t + 2]];
            if (!(low(p) && low(q) && low(r) && (wide(p) || wide(q) || wide(r)))) keep.push(p, q, r);
          }
          o.geometry.setIndex(keep);
        });
      }
      const bb = robustBox(g.scene);
      m = { lo: bb.min.clone(), hi: bb.max.clone(), h: bb.max.y - bb.min.y, d: bb.max.z - bb.min.z, c: bb.getCenter(new THREE.Vector3()) };
    }
    // Background animal: rotation from people.json (turn), height from height, pivot in the centre, bottom on the floor.
    // They keep their own clips (elephant, camel, tiger, zebu, monkey); the one matching clip is used (usually Idle).
    if (rec.kind === 'animal' || rec.kind === 'vehicle' || rec.kind === 'dog') {
      g.scene.rotation.y = (rec.turn || 0) * Math.PI / 180;
      g.scene.updateMatrixWorld(true);
      const bb = robustBox(g.scene), c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      const k = rec.height / sz.y;
      g.scene.scale.multiplyScalar(k);
      g.scene.position.set(-c.x * k, -bb.min.y * k, -c.z * k);
      const holder = new THREE.Group(); holder.add(g.scene);
      const want = rec.clip ? new RegExp(rec.clip, 'i') : null;
      const clips = (g.animations || []).filter((a) => !want || want.test(a.name));
      peopleCache.set(rec.file, { holder, clips: clips.length ? clips : g.animations || [], animal: { W: sz.x * k, L: sz.z * k, H: rec.height } });
      console.log(`[ИИндус] животное ${rec.file}: ${(sz.x * k).toFixed(2)} × ${(sz.z * k).toFixed(2)} × ${rec.height} м, клипов ${clips.length}`);
      return peopleCache.get(rec.file);
    }
    // Turn the cow to face the camera (+z), put the pivot in the middle of the body and measure the mesh exactly:
    // layout needs its length and width, since on the floor a cow takes an L x W capsule.
    if (rec.kind === 'cow') {
      // the Polish cow's rest pose is a walking frame with the right front leg bent and raised, so all legs are set straight down
      const legs = cowLegs(g.scene);
      g.scene.updateMatrixWorld(true);
      for (const L of legs) for (const b of L.chain) aimBone(b, new THREE.Vector3(0, -1, 0));
      g.scene.updateMatrixWorld(true);
      let bb = robustBox(g.scene);
      const c0 = bb.getCenter(new THREE.Vector3()), sz0 = bb.getSize(new THREE.Vector3());
      let head = null;
      g.scene.traverse((o) => { if (!head && o.isBone && /head|face/i.test(o.name)) head = o; });
      const hp = head ? head.getWorldPosition(new THREE.Vector3()).sub(c0) : new THREE.Vector3(0, 0, 1);
      // the head is where the head bone points; if that is wrong somewhere, people.json adds a turn (degrees)
      g.scene.rotation.y = (sz0.x > sz0.z ? (hp.x > 0 ? -Math.PI / 2 : Math.PI / 2) : (hp.z > 0 ? 0 : Math.PI)) + (rec.turn || 0) * Math.PI / 180;
      g.scene.updateMatrixWorld(true);
      bb = robustBox(g.scene);
      const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      const k = COW_H / sz.y;
      g.scene.scale.multiplyScalar(k);
      g.scene.position.set(-c.x * k, -bb.min.y * k, -c.z * k);
      const holder = new THREE.Group();
      holder.add(g.scene);
      holder.updateMatrixWorld(true);
      // nod: swing the neck (or head) bone around the cow's lateral axis, in its parent's space
      let neck = null;
      g.scene.traverse((o) => { if (!neck && o.isBone && /neck/i.test(o.name)) neck = o; });
      neck = neck || head;
      const nod = neck && neck.parent ? { name: neck.name, rest: neck.quaternion.clone(),
        axis: new THREE.Vector3(1, 0, 0).applyQuaternion(neck.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize() } : null;
      // for leg dancing: each joint's forward-back axis (across the cow) in its parent's space
      const legRig = legs.map((L) => ({ front: L.front, side: L.side, names: L.chain.slice(0, 2).map((b) => b.name),
        rest: L.chain.slice(0, 2).map((b) => b.quaternion.clone()),
        axis: L.chain.slice(0, 2).map((b) => new THREE.Vector3(1, 0, 0).applyQuaternion(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize()) }));
      const cow = { L: sz.z * k, W: sz.x * k, H: COW_H, nod, legs: legRig };
      console.log(`[ИИндус] корова ${rec.file}: ${cow.L.toFixed(2)} × ${cow.W.toFixed(2)} × ${COW_H} м, кивает ${nod ? nod.name : '—'}`);
      peopleCache.set(rec.file, { holder, clips: [], cow });
      return peopleCache.get(rec.file);
    }
    // bones reach neither the top of the head nor the floor, so people are normalised to 1.70
    const target = rec.kind === 'god' ? 1.9 : (m.byBones ? 1.48 : 1.70);
    let k = m.h > 0.01 ? target / m.h : 1;
    if (rec.kind === 'm' || rec.kind === 'f') {
      const cl = chainLen(g.scene);
      if (cl > 0.01) k = REF_CHAIN / cl;                   // same bone length as the reference, so height is the same for any rest pose
    }
    const holder = new THREE.Group();
    g.scene.scale.multiplyScalar(k);
    g.scene.position.y -= m.lo.y * k;                      // put it on the scene floor
    // a statue is also centred on the pivot, otherwise it drifts away from its halo when it sways
    if (rec.kind === 'god' && m.c) { g.scene.position.x -= m.c.x * k; g.scene.position.z -= m.c.z * k; }
    holder.add(g.scene);
    console.log(`[ИИндус] модель ${rec.file}: кости ${m.h.toFixed(2)} м, масштаб ${k.toFixed(2)}, поворот ${g.scene.rotation.x ? 'да' : 'нет'}`);
    peopleCache.set(rec.file, { holder, clips: g.animations || [],
      god: rec.kind === 'god' ? { W: (m.hi.x - m.lo.x) * k, D: (m.hi.z - m.lo.z) * k, H: m.h * k } : null });
  }
  return peopleCache.get(rec.file);
}

// Fallback when retargeting fails: the clip without translations (hip translation in foreign units tears the
// mesh apart; Modi's face once fell to pieces). Our dances have no rotations, so the model then just stands in rest pose.
// ---------- retargeting dances onto other skeletons ----------
// Copying rotations does not work: models have different rest poses (T-pose, arms down, the Spider-Men even lean
// forward), and the same numbers give different poses. So on every frame each bone is aimed at its child the same
// way as in the source: the bone direction matches, not the angle. The pelvis is aligned by two vectors (up the spine
// and across the hips) to get both tilt and turn.
const AIM = {
  Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', Head: 'HeadTop_End',
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'LeftHandMiddle1',
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase',
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase',
};
const retargetCache = new Map();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _m1 = new THREE.Matrix4();

// Height from the foot -> shin -> thigh -> pelvis -> spine -> neck -> head chain. Unlike the rest-pose height, bone
// length does not depend on the pose, so a Spider-Man crouching in rest pose does not get blown up three times.
const CHAIN = ['LeftFoot', 'LeftLeg', 'LeftUpLeg', 'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'];
function chainLen(root) {
  root.updateMatrixWorld(true);
  const B = boneMap(root);
  let L = 0, prev = null;
  for (const n of CHAIN) {
    if (!B[n]) return 0;
    const p = B[n].getWorldPosition(new THREE.Vector3());
    if (prev) L += p.distanceTo(prev);
    prev = p;
  }
  return L;
}
// reference length of the foot -> ... -> head chain; the whole scene is tuned to it (it was the Ready Player Me dummy)
const REF_CHAIN = 1.6266;

function boneMap(root) {
  const m = {};
  root.traverse((o) => { if (o.isBone && !m[o.name]) m[o.name] = o; });
  return m;
}
const wpos = (b, out) => b.getWorldPosition(out);
function basisFrom(up, side, out) {                 // orthonormal basis from up and side vectors
  const y = _v3.copy(up).normalize();
  const z = _v4.crossVectors(side, y).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return out.setFromRotationMatrix(_m1.makeBasis(x, y, z));
}

// Joint limits for models with poor skinning. On the second Modi the vest is tied to the arm: raise the arm above
// the shoulder and the vest follows it like a wing; lean and the shirt shows through the vest. Such models have
// rom in people.json: the largest deviation of a bone from rest pose, in degrees.
const ROM_GROUPS = { arm: ['LeftArm', 'RightArm'], forearm: ['LeftForeArm', 'RightForeArm'], hand: ['LeftHand', 'RightHand'], shoulder: ['LeftShoulder', 'RightShoulder'],
  spine: ['Spine', 'Spine1', 'Spine2'], neck: ['Neck', 'Head'], hips: ['Hips'], leg: ['LeftUpLeg', 'RightUpLeg'] };
const IDQ = new THREE.Quaternion(), Y_UP = new THREE.Vector3(0, 1, 0);
function romLimit(rec, bone) {
  if (!rec.rom) return 0;
  for (const [g, names] of Object.entries(ROM_GROUPS)) if (rec.rom[g] && names.includes(bone)) return rec.rom[g] * Math.PI / 180;
  return 0;
}

function bakeRetarget(rec, kind, idx, fps = 24) {
  const key = `${rec.file}|${kind}|${idx}`;
  if (retargetCache.has(key)) return retargetCache.get(key);
  const srcRoot = assets[kind].scene, clip = assets[kind].clips[idx];
  const tgtRoot = peopleCache.get(rec.file).holder;
  const S = boneMap(srcRoot), T = boneMap(tgtRoot);
  if (!T.Hips || !S.Hips) return null;
  // rest poses, saved to put the cached model back the way it was
  const restQ = {}, restP = {};
  for (const [n, b] of Object.entries(T)) { restQ[n] = b.quaternion.clone(); restP[n] = b.position.clone(); }
  tgtRoot.updateMatrixWorld(true);
  // target at rest: each bone's direction to its child and the pelvis basis
  const order = [];
  // walk through helper nodes between bones too (FBX exports sometimes have ..._scaleCompensation)
  (function walk(o) { if (o.isBone) order.push(o); for (const c of o.children) if (!c.isMesh) walk(c); })(T.Hips);
  const mixer = new THREE.AnimationMixer(srcRoot);
  mixer.clipAction(clip).play();
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const tracksQ = {}, hipPos = new Float32Array(frames * 3), times = new Float32Array(frames);
  for (const b of order) tracksQ[b.name] = new Float32Array(frames * 4);
  const FEET = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
  const lowest = (M) => Math.min(...FEET.filter((n) => M[n]).map((n) => wpos(M[n], _v1).y));
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    srcRoot.updateMatrixWorld(true);
    for (const b of order) { b.quaternion.copy(restQ[b.name]); }
    tgtRoot.updateMatrixWorld(true);
    for (const b of order) {
      const sb = S[b.name];
      if (sb) {
        const parentW = b.parent.getWorldQuaternion(_q1);
        let targetW = null;
        if (b.name === 'Hips' && T.Spine && S.Spine && T.LeftUpLeg && T.RightUpLeg && S.LeftUpLeg && S.RightUpLeg) {
          // pelvis: map the target's rest basis onto the source's current basis
          const sUp = wpos(S.Spine, _v1).sub(wpos(sb, _v2)).clone();
          const sSide = wpos(S.LeftUpLeg, _v1).sub(wpos(S.RightUpLeg, _v2)).clone();
          const tUp = wpos(T.Spine, _v1).sub(wpos(b, _v2)).clone();
          const tSide = wpos(T.LeftUpLeg, _v1).sub(wpos(T.RightUpLeg, _v2)).clone();
          const qS = basisFrom(sUp, sSide, new THREE.Quaternion());
          const qT = basisFrom(tUp, tSide, new THREE.Quaternion());
          const delta = qS.multiply(qT.invert());                     // rotation from the target basis to the source basis
          const lim = romLimit(rec, 'Hips');
          if (lim) {                                                  // torso tilt is limited, rotation around the vertical is not
            const up = new THREE.Vector3(0, 1, 0).applyQuaternion(delta), tilt = up.angleTo(Y_UP);
            if (tilt > lim) delta.premultiply(new THREE.Quaternion().setFromUnitVectors(up, Y_UP).slerp(IDQ, lim / tilt));
          }
          targetW = delta.multiply(b.getWorldQuaternion(_q2));
        } else {
          const child = AIM[b.name];
          if (child && T[child] && S[child]) {
            const dS = wpos(S[child], _v1).sub(wpos(sb, _v2)).normalize().clone();
            const dT = wpos(T[child], _v1).sub(wpos(b, _v2)).normalize();
            const swing = new THREE.Quaternion().setFromUnitVectors(dT, dS);
            const lim = romLimit(rec, b.name);
            if (lim) { const a = dT.angleTo(dS); if (a > lim) swing.slerp(IDQ, 1 - lim / a); }
            targetW = swing.multiply(b.getWorldQuaternion(_q2));
          }
        }
        if (targetW) {
          b.quaternion.copy(parentW.invert().multiply(targetW));
          b.updateMatrixWorld(true);
        }
      }
      b.quaternion.toArray(tracksQ[b.name], f * 4);
    }
    // ground: shift the pelvis vertically so the target's lowest foot is where the source's is.
    // Squats and jumps carry over, and a model crouching in rest pose does not sink into the floor.
    const dyFoot = lowest(S) - lowest(T);
    const wHip = wpos(T.Hips, _v2);
    wHip.y += dyFoot;
    const p = wHip.applyMatrix4(_m1.copy(T.Hips.parent.matrixWorld).invert());
    p.toArray(hipPos, f * 3);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(srcRoot);
  srcRoot.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  for (const [n, b] of Object.entries(T)) { b.quaternion.copy(restQ[n]); b.position.copy(restP[n]); }
  tgtRoot.updateMatrixWorld(true);
  const tracks = Object.entries(tracksQ).map(([n, v]) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, v));
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hipPos));
  const out = new THREE.AnimationClip(clip.name + ':' + rec.file, clip.duration, tracks);
  retargetCache.set(key, out);
  return out;
}

const rotOnlyCache = new WeakMap();
function rotationOnly(clip) {
  if (!rotOnlyCache.has(clip)) {
    const tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion'));
    rotOnlyCache.set(clip, new THREE.AnimationClip(clip.name + ':rot', clip.duration, tracks));
  }
  return rotOnlyCache.get(clip);
}

let assets = null; // { m: {scene, clips[]}, f: the same source }
async function loadAssets() {
  if (assets) return assets;
  const g = await loadGltf(DANCE_FILE);
  const toBone = (node) => {
    const b = new THREE.Bone(); b.name = node.name; b.position.copy(node.position);
    for (const c of node.children) b.add(toBone(c));
    return b;
  };
  const rig = new THREE.Group();
  rig.add(toBone(g.scene.getObjectByName('Hips')));
  if (!g.animations.length) throw new Error('нет танцев');
  const src = { scene: rig, clips: g.animations };
  assets = { m: src, f: src };
  return assets;
}

// Mannequin: the fallback dancer when no model has loaded (or the build has none, e.g. from the repository).
// Capsules between the dance joints, placed by the joint positions on every frame.
const MANNEQUIN = [
  ['Hips', 'Spine', 0.13], ['Spine', 'Spine2', 0.14], ['Spine2', 'Neck', 0.13], ['Neck', 'Head', 0.05, 'skin'],
  ...['Left', 'Right'].flatMap((s) => [[`${s}Shoulder`, `${s}Arm`, 0.05], [`${s}Arm`, `${s}ForeArm`, 0.05], [`${s}ForeArm`, `${s}Hand`, 0.04, 'skin'],
    [`${s}Hand`, `${s}HandMiddle1`, 0.035, 'skin'], ['Hips', `${s}UpLeg`, 0.08], [`${s}UpLeg`, `${s}Leg`, 0.075], [`${s}Leg`, `${s}Foot`, 0.055],
    [`${s}Foot`, `${s}ToeBase`, 0.045, 'shoe']]),
];
const HEAD_GEO = new THREE.SphereGeometry(0.105, 16, 12), capsuleGeo = new Map();   // capsules sized by bone length, shared by all mannequins
const SKIN_TONES = [0x8d5524, 0xa0673a, 0xc68642, 0x6b4226];
function makeMannequin() {
  const obj = skeletonClone(assets.m.scene), B = boneMap(obj);
  const cloth = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.65, 0.5), roughness: 0.65 });
  const skin = new THREE.MeshStandardMaterial({ color: rnd(SKIN_TONES), roughness: 0.75 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.8 });
  obj.updateMatrixWorld(true);
  const segs = MANNEQUIN.filter(([a, b]) => B[a] && B[b]).map(([a, b, r, m]) => {
    const key = a + '|' + b;
    if (!capsuleGeo.has(key)) {
      const len = B[a].getWorldPosition(_v1).distanceTo(B[b].getWorldPosition(_v2));
      capsuleGeo.set(key, new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 4, 10));
    }
    const mesh = new THREE.Mesh(capsuleGeo.get(key), m === 'skin' ? skin : m === 'shoe' ? shoe : cloth);
    mesh.frustumCulled = false; obj.add(mesh);
    return { a: B[a], b: B[b], r, mesh };
  });
  const head = new THREE.Mesh(HEAD_GEO, skin); head.frustumCulled = false; obj.add(head);
  obj.userData.mannequin = { segs, head, B };
  return obj;
}
const _mi = new THREE.Matrix4();
function poseMannequin(obj) {
  const m = obj.userData.mannequin;
  obj.updateMatrixWorld(true);
  _mi.copy(obj.matrixWorld).invert();
  for (const s of m.segs) {
    const pa = s.a.getWorldPosition(_v1).applyMatrix4(_mi), pb = s.b.getWorldPosition(_v2).applyMatrix4(_mi);
    const d = _v3.subVectors(pb, pa), len = d.length();
    s.mesh.position.addVectors(pa, pb).multiplyScalar(0.5);
    if (len > 1e-4) s.mesh.quaternion.setFromUnitVectors(Y_UP, d.multiplyScalar(1 / len));
  }
  const h = m.B.Head.getWorldPosition(_v1).applyMatrix4(_mi), top = m.B.HeadTop_End.getWorldPosition(_v2).applyMatrix4(_mi);
  m.head.position.lerpVectors(h, top, 0.45);
}

const texLoader = new THREE.TextureLoader();

let songs = [];
const songsLoaded = fetch(chrome.runtime.getURL('assets/songs/songs.json')).then((r) => r.json()).then((s) => { songs = s; }).catch(() => {});

// ---------- three.js scene ----------
// ---------- graphics quality ----------
// All graphics run on the GPU (WebGL). The expensive parts are pixel count (four times more on Retina),
// antialiasing, three coloured point lights evaluated on every model pixel, particles and the heavy god scans.
// Levels drop them one by one. In auto mode we start from the GPU name and step down when frames are late
// (median frame longer than 26 ms, i.e. below ~38 fps).
const GFX = {
  high:   { pr: 2,    aa: true,  particles: 700, octaves: 5, lights: true,  maxDancers: 24, gods: 2, fps: 0,  rain: 140, power: 'high-performance' },
  medium: { pr: 1.25, aa: true,  particles: 420, octaves: 4, lights: true,  maxDancers: 18,  gods: 1, fps: 0,  rain: 200, power: 'high-performance' },
  low:    { pr: 1,    aa: false, particles: 200, octaves: 3, lights: false, maxDancers: 14,  gods: 0, fps: 30, rain: 320, power: 'low-power' },
};
const LEVELS = ['high', 'medium', 'low'];
let gfxLevel = 'high', gfxMode = 'auto', G = GFX.high, renderer = null, gpuName = '';
function makeRenderer(g) {
  if (renderer) {                                   // antialiasing is set when the context is created, so a new canvas is needed
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh); canvas = fresh;
    renderer.dispose(); renderer.forceContextLoss();
  }
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: g.aa, powerPreference: g.power });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.userData = { aa: g.aa, power: g.power };
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  gpuName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).replace(/^ANGLE \((.*)\)$/, '$1');
}
makeRenderer(G);
const guessLevel = (name) => /swiftshader|llvmpipe|software|basic render/i.test(name) ? 'low'
  : /intel.*(hd|uhd)|mali|adreno|powervr|videocore/i.test(name) ? 'medium' : 'high';
let savedGfx = null, gfxReady = false, gfxSavedAt = 0, lastFps = 0;
try { chrome.storage.local.get('gfx').then(({ gfx }) => { savedGfx = gfx || null; }).catch(() => {}); } catch { /* outside the extension */ }
function saveGfx(force) {
  const now = performance.now();
  if (!force && now - gfxSavedAt < 10000) return;
  gfxSavedAt = now;
  try { chrome.storage.local.set({ gfx: { level: gfxLevel, mode: gfxMode, gpu: gpuName.slice(0, 60), fps: lastFps } }); } catch { /* ignore */ }
}
function applyGfx(level) {
  gfxLevel = level; G = GFX[level];
  if (renderer.userData.aa !== G.aa || renderer.userData.power !== G.power) makeRenderer(G);
  resize();
  spots.forEach((l) => { l.visible = G.lights; });
  if (powder) powder.geometry.setDrawRange(0, G.particles);
  fireMat.uniforms.uOct.value = G.octaves;
  gfxCheckAt = performance.now() + 2500;
  console.log(`[ИИндус] графика: ${level}${gfxMode === 'auto' ? ' (авто)' : ''}, ${gpuName}`);
  saveGfx(true);
}
// mode from settings: in auto, the level found last time on the same GPU, otherwise a guess from its name
function setGraphics(mode = 'auto') {
  if (gfxReady && mode === gfxMode) return;
  gfxMode = mode; gfxReady = true;
  const remembered = savedGfx && savedGfx.mode === 'auto' && savedGfx.gpu === gpuName.slice(0, 60) && GFX[savedGfx.level] ? savedGfx.level : null;
  applyGfx(mode === 'auto' ? remembered || guessLevel(gpuName) : GFX[mode] ? mode : 'high');
}
// auto: median frame interval over ~1.5 s; above 26 ms means one level down
let frameLog = [], gfxCheckAt = 0, lastFrameAt = 0;
function governor(now) {
  if (lastFrameAt) frameLog.push(now - lastFrameAt);
  lastFrameAt = now;
  if (now < gfxCheckAt || !dancers.length) { frameLog.length = 0; return; }   // textures and shaders load right after start
  if (frameLog.length < 90) return;
  const med = frameLog.slice().sort((a, b) => a - b)[45];
  frameLog.length = 0;
  lastFps = Math.round(1000 / med);
  if (gfxMode === 'auto' && med > 26 && gfxLevel !== 'low') applyGfx(LEVELS[LEVELS.indexOf(gfxLevel) + 1]);
  else saveGfx();
}
const scene = new THREE.Scene();
// Camera: 1.85 m high (PHOTO_CAM_Y), a bit above eye level, so the heads of back rows show above the shoulders of
// front rows. With a backdrop photo it is tilted so the 3D horizon matches the photo's horizon (matchCamera): the
// ground in the photo then is the floor, and people and vehicles stand on it in the right perspective.
// Without a photo the same camera uses a virtual horizon.
const DEF_CAM_Y = 1.35, DEF_LOOK_Y = 1.15;
let camY = DEF_CAM_Y, lookY = DEF_LOOK_Y;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
camera.position.set(0, camY, 4.4);
camera.lookAt(0, lookY, 0);

const hemi = new THREE.HemisphereLight(0xfff2dc, 0x3a1a00, 1.3); scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 4, 3); scene.add(key);
const spots = [0xff9933, 0xff1493, 0x138808].map((c, i) => {
  const l = new THREE.PointLight(c, 30, 12, 1.6);
  l.userData.phase = (i / 3) * Math.PI * 2;
  scene.add(l);
  return l;
});

// ---------- celebration themes ----------
// The title never changes; a theme sets the look: fire, particles, emoji, music.
const TITLE = 'ИИНДУИЗАЦИЯ';
const THEMES = {
  bollywood: { fall: 'confetti',
    hue: '#ff9933', fire: [[0.8, 0.05, 0.02], [1.0, 0.45, 0.05], [1.0, 0.95, 0.6]],
    palette: [0xff9933, 0xff1493, 0xffd700, 0x00bfff, 0xffffff],
    emoji: ['💃', '🕺', '🎬', '✨', '🪩', '🔥', '🥁'], chars: ['civil', 'bride'], particle: 'glitter', tags: ['bollywood', 'bhangra'],
  },
  bhangra: { fall: 'confetti',
    hue: '#ffcc00', fire: [[0.65, 0.25, 0.0], [1.0, 0.7, 0.1], [1.0, 1.0, 0.8]],
    palette: [0xffd700, 0xff8c00, 0x138808, 0xff4500, 0xffffff],
    emoji: ['🪘', '🧡', '💛', '🌾', '🕺', '🎺', '🇮🇳'], chars: ['dholi', 'turban'], particle: 'confetti', tags: ['bhangra', 'dhol'],
  },
  holi: { fall: 'gulal',
    hue: '#ff1493', fire: [[0.55, 0.02, 0.35], [1.0, 0.25, 0.75], [1.0, 0.9, 0.95]],
    palette: [0xff1493, 0xffd700, 0x00bfff, 0x7cfc00, 0xff4500, 0xda70d6, 0xffffff],
    emoji: ['🎨', '🌈', '💜', '💛', '🩷', '✨', '🥳'], chars: ['civil', 'dholi'], particle: 'powder', tags: ['holi', 'dhol', 'festival'],
  },
  diwali: { fall: 'sparks',
    hue: '#ffb300', fire: [[0.7, 0.2, 0.0], [1.0, 0.62, 0.05], [1.0, 0.97, 0.75]],
    palette: [0xffd700, 0xff8c00, 0xfff5cc, 0xff4500, 0xffa500],
    emoji: ['🪔', '✨', '🎆', '🎇', '🌟', '🕉️', '🧨'], chars: ['guru', 'bride'], particle: 'sparks', tags: ['diwali', 'classic', 'festival'],
    fireworks: true,
  },
  wedding: { fall: 'petals',
    hue: '#ff2d55', fire: [[0.6, 0.0, 0.12], [1.0, 0.2, 0.35], [1.0, 0.85, 0.8]],
    palette: [0xff2d55, 0xffd700, 0xff69b4, 0xffffff, 0xff4500],
    emoji: ['💐', '🌺', '💍', '👰', '🥻', '🎊', '🐘'], chars: ['bride', 'guru'], particle: 'petals', tags: ['wedding', 'classic'],
  },
  // the web show: Spider-Man in front shoots webs at the screen, a crowd behind him (see updateShow)
  spidey: { fall: 'confetti',
    hue: '#e23b3b', fire: [[0.5, 0.02, 0.06], [0.95, 0.12, 0.12], [0.55, 0.75, 1.0]],
    palette: [0xe23b3b, 0x1f4fd6, 0xffffff, 0xff9933, 0x138808],
    emoji: ['🕷️', '🕸️', '💥', '🦸', '🇮🇳'], chars: ['civil'], particle: 'confetti', tags: ['bollywood', 'bhangra'], show: 'spidey',
  },
  street: { fall: 'rupees',
    hue: '#00bfff', fire: [[0.7, 0.15, 0.0], [1.0, 0.5, 0.08], [1.0, 0.95, 0.7]],
    palette: [0xff9933, 0x138808, 0xffd700, 0x00bfff, 0xff4500],
    emoji: ['🛺', '🇮🇳', '🐄', '🌶️', '🥘', '🛕', '🪘'], chars: ['civil', 'military'], particle: 'confetti', tags: ['street', 'dhol'],
  },
  cricket: { fall: 'confetti',
    hue: '#00bfff', fire: [[0.0, 0.25, 0.6], [0.1, 0.65, 1.0], [0.85, 0.98, 1.0]],
    palette: [0x00bfff, 0xff9933, 0xffffff, 0x138808, 0xffd700],
    emoji: ['🏏', '🇮🇳', '🏆', '🔥', '🥳', '📣'], chars: ['fan', 'military'], particle: 'confetti', tags: ['street', 'bollywood'],
  },
  default: { fall: 'petals',
    hue: '#ff9933', fire: [[0.75, 0.05, 0.01], [1.0, 0.42, 0.04], [1.0, 0.92, 0.55]],
    palette: [0xff9933, 0xff1493, 0xffd700, 0x138808, 0x00bfff, 0xff4500],
    emoji: ['🇮🇳', '🪔', '💃', '🕺', '🐘', '🥻', '🎉', '🙏', '🌶️', '🥘', '🪘', '✨'], particle: 'powder', tags: [],
  },
};
// particle behaviour: [Y speed from, to], spread, size, where they come from
const PARTICLE = {
  powder: { vy: [0.5, 1.7], spread: 0.45, size: 0.16, from: 'bottom' },
  sparks: { vy: [1.3, 2.8], spread: 0.22, size: 0.10, from: 'bottom' },
  petals: { vy: [-0.95, -0.35], spread: 0.5, size: 0.26, from: 'top' },
  glitter: { vy: [0.2, 1.1], spread: 0.95, size: 0.13, from: 'bottom' },
  confetti: { vy: [0.7, 1.6], spread: 0.75, size: 0.2, from: 'bottom' },
};
const THEME_NAMES = Object.keys(THEMES);
let theme = { name: 'default', ...THEMES.default }, lastThemeName = null;

// All themes have equal odds. The same theme is never picked twice in a row: variety is visible,
// and each theme still has the same probability because the rule is symmetric.
let forcedTheme = null;                 // debugging: the next celebration uses this theme
// The web show is rare: about once in 25 celebrations; the other themes share the rest equally
const RARE_THEMES = { spidey: 0.04 };
function pickTheme() {
  if (forcedTheme && THEMES[forcedTheme]) { lastThemeName = forcedTheme; return { name: forcedTheme, ...THEMES[forcedTheme] }; }
  for (const [name, p] of Object.entries(RARE_THEMES)) {
    if (name !== lastThemeName && Math.random() < p) { lastThemeName = name; return { name, ...THEMES[name] }; }
  }
  const pool = THEME_NAMES.filter((n) => n !== lastThemeName && !(n in RARE_THEMES));
  const name = pool[Math.floor(Math.random() * pool.length)];
  lastThemeName = name;
  return { name, ...THEMES[name] };
}
let PALETTE = THEMES.default.palette;

// ---------- burning frame around the reel: a full-screen shader in a second (orthographic) scene ----------
const fireScene = new THREE.Scene();
const fireCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fireMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false,
  uniforms: { uTime: { value: 0 }, uPR: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) }, uRect: { value: new THREE.Vector4(0, 0, 0, 0) }, uBeat: { value: 0 }, uFx: { value: 1 }, uOct: { value: 5 },
    uC1: { value: new THREE.Color(0.75, 0.05, 0.01) }, uC2: { value: new THREE.Color(1.0, 0.42, 0.04) }, uC3: { value: new THREE.Color(1.0, 0.92, 0.55) } },
  vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    precision highp float;
    uniform float uTime, uPR, uBeat, uFx, uOct; uniform vec2 uRes; uniform vec4 uRect; uniform vec3 uC1, uC2, uC3;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
    float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { if (float(i) >= uOct) break; v += a * noise(p); p = p * 2.02 + vec2(1.7, 9.2); a *= 0.5; } return v; }
    float sdRoundRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
    void main() {
      vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPR;      // CSS px, y down
      vec2 center = uRect.xy + uRect.zw * 0.5;
      float d = sdRoundRect(frag - center, uRect.zw * 0.5, 16.0);             // >0 outside the reel
      float H = (80.0 + 70.0 * uBeat) * uFx;                                  // flame tongue height
      if (d > H * 1.4 || d < -0.45 * H) discard;
      vec2 p = frag / 38.0;
      float n = fbm(vec2(p.x, p.y + uTime * 2.4));                            // the flame flows upward
      float n2 = fbm(vec2(p.x * 1.9 + 3.1, p.y * 1.4 + uTime * 3.8));
      float t = d / H;
      float inside = smoothstep(-0.2, 0.05, t);                                // reaches into the reel only a tiny bit
      float flame = (1.0 - smoothstep(0.0, 1.0, t + (n * 1.15 + n2 * 0.65 - 0.8) * 1.1)) * inside;
      flame = clamp(flame, 0.0, 1.0);
      vec3 col = mix(uC1, uC2, flame);                                         // dark tips, the body in the theme colour
      col = mix(col, uC3, pow(flame, 4.0));                                    // bright core right at the frame
      float alpha = smoothstep(0.04, 0.55, flame) * (0.92 + 0.08 * uBeat);
      float glow = exp(-max(d, 0.0) / (45.0 * uFx)) * 0.3 * (0.6 + 0.4 * uBeat) * step(0.0, d);
      col += uC2 * glow;
      gl_FragColor = vec4(col, max(alpha, glow));
    }`,
});
fireScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fireMat));
const occScene = new THREE.Scene();
// depth is written only when the depth test is on, hence depthTest with an always-pass function
const occluder = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth }));
occScene.add(occluder);

// ---------- city backdrop: a photo behind the dancers with a window for the reel ----------
// A full-screen pass before the fire and the 3D scene. The photo is scaled to cover the screen and slightly enlarged
// (room for parallax as the camera sways), softened a little through mip levels, and darker at the edges and bottom,
// where the dancers' shadows read better on the ground. The backdrop is cut out inside the reel, so the video stays visible.
let backdrops = [], lastBackdrop = null, bgTarget = 0;
const backdropsLoaded = fetch(chrome.runtime.getURL('assets/backdrops/backdrops.json')).then((r) => r.json()).then((b) => { backdrops = b; }).catch(() => { backdrops = []; });
const bgTexCache = new Map();
const bgScene = new THREE.Scene();
const bgMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false,
  uniforms: { uTex: { value: null }, uTexAspect: { value: 1.5 }, uRes: { value: new THREE.Vector2(1, 1) }, uPR: { value: 1 }, uRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    uHasRect: { value: 0 }, uShift: { value: 0 }, uOffY: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    precision highp float;
    uniform sampler2D uTex; uniform float uTexAspect, uPR, uShift, uOffY, uOpacity, uHasRect, uTime; uniform vec2 uRes; uniform vec4 uRect;
    float sdRoundRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
    void main() {
      vec2 scr = uRes / uPR, frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPR;   // CSS px, y down
      float a = uOpacity;
      if (uHasRect > 0.5) {
        float d = sdRoundRect(frag - (uRect.xy + uRect.zw * 0.5), uRect.zw * 0.5, 16.0);
        a *= smoothstep(-1.0, 2.0, d);
        if (a <= 0.001) discard;
      }
      vec2 uv = frag / scr, st = uv - 0.5;
      float sa = scr.x / scr.y;
      if (sa > uTexAspect) st.y *= uTexAspect / sa; else st.x *= sa / uTexAspect;
      st = st / 1.08 + vec2(uShift + sin(uTime * 0.05) * 0.006, uOffY);   // vertical shift to line up the horizon
      vec3 col = texture2D(uTex, vec2(st.x + 0.5, 0.5 - st.y), 1.2).rgb;
      float vig = smoothstep(1.25, 0.3, length((uv - 0.5) * vec2(1.0, 1.25)));
      col *= mix(0.7, 1.0, vig);
      gl_FragColor = vec4(col, a);
    }`,
});
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));
function bgTexture(file) {
  if (!bgTexCache.has(file)) {
    bgTexCache.set(file, new Promise((ok) => texLoader.load(chrome.runtime.getURL('assets/backdrops/' + file), (t) => {
      t.colorSpace = THREE.NoColorSpace;                 // the shader writes colour as is: the photo is already sRGB
      t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; ok(t);
    }, undefined, () => ok(null))));
  }
  return bgTexCache.get(file);
}
// The photo horizon is b.horizon (fraction of the photo height from the top). The photo covers the screen with a
// 1.08 zoom and can be shifted vertically within the spare margin so the horizon lands near HZ_TARGET on screen.
// The camera is then tilted to wherever the horizon really ended up: tan(tilt) = NDC(horizon) * tan(fov/2).
const HZ_TARGET = 0.56, PHOTO_CAM_Y = 1.85;   // a bit above eye level: heads of back rows show above the shoulders of front rows
let curBackdrop = null;
function matchCamera(b) {
  let yh = HZ_TARGET, o = 0;                     // no photo: the same camera with a virtual horizon, so the crowd has the same scale
  if (b) {
    const ta = b.size[0] / b.size[1], sa = innerWidth / innerHeight, k = sa > ta ? ta / sa : 1;
    const slack = Math.max(0, (1 - k / 1.08) / 2);
    o = THREE.MathUtils.clamp(b.horizon - 0.5 - (HZ_TARGET - 0.5) * k / 1.08, -slack, slack);
    yh = 0.5 + (b.horizon - 0.5 - o) * 1.08 / k;   // where the horizon is on screen (fraction from the top)
  }
  const ndc = 1 - 2 * yh, tanDown = ndc * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  bgMat.uniforms.uOffY.value = o;
  camY = PHOTO_CAM_Y; lookY = camY - tanDown * 4.4;
}
// light on the people matches the photo: its sky and ground set the hemisphere colours, overall brightness sets the strength
function lightFromPhoto(tex) {
  if (!tex) { hemi.color.set(0xfff2dc); hemi.groundColor.set(0x3a1a00); hemi.intensity = 1.3; key.color.set(0xffffff); key.intensity = 1.4; spots.forEach((l) => { l.intensity = 30; }); return; }
  const c = document.createElement('canvas'); c.width = c.height = 24;
  const g = c.getContext('2d'); g.drawImage(tex.image, 0, 0, 24, 24);
  const px = g.getImageData(0, 0, 24, 24).data, hz = Math.round(24 * (curBackdrop ? curBackdrop.horizon : 0.5));
  const avg = (y0, y1) => { let r = 0, gg = 0, b = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 24; x++) { const i = (y * 24 + x) * 4; r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; } return [r / n / 255, gg / n / 255, b / n / 255]; };
  const sky = avg(0, Math.max(1, hz)), ground = avg(Math.min(23, hz), 24), all = avg(0, 24);
  const luma = 0.3 * all[0] + 0.59 * all[1] + 0.11 * all[2];
  const mixW = (cc, t) => cc.map((v) => v * t + (1 - t));
  hemi.color.setRGB(...mixW(sky, 0.45), THREE.SRGBColorSpace);
  hemi.groundColor.setRGB(...ground.map((v) => v * 0.8), THREE.SRGBColorSpace);
  hemi.intensity = 0.55 + 1.5 * luma;
  key.color.setRGB(...mixW(all, 0.35), THREE.SRGBColorSpace);
  key.intensity = 0.35 + 1.6 * luma;
  spots.forEach((l) => { l.intensity = luma < 0.25 ? 22 : 9; });       // coloured spotlights are stronger at night and barely visible by day
}
function backdropOn(themeName) {                                    // choice and camera right away; the texture loads later
  if (!backdrops.length) return;
  const fit = backdrops.filter((b) => (b.themes || []).includes(themeName) && b.file !== lastBackdrop);
  const pick = rnd(fit.length ? fit : backdrops.filter((b) => b.file !== lastBackdrop));
  lastBackdrop = pick.file; curBackdrop = pick;
  bgMat.uniforms.uTexAspect.value = pick.size[0] / pick.size[1];
  matchCamera(pick);                                              // camera right away, before the layout
  bgTexture(pick.file).then((tex) => {
    if (!tex || !running || curBackdrop !== pick) return;
    bgMat.uniforms.uTex.value = tex;
    lightFromPhoto(tex);
    bgTarget = 1;
    console.debug('[ИИндус] фон:', pick.place);
  });
}
function backdropOff() { bgTarget = 0; bgMat.uniforms.uOpacity.value = 0; bgMat.uniforms.uTex.value = null; curBackdrop = null; matchCamera(null); lightFromPhoto(null); }



// ---------- beat: audio analyser; if the audio context did not start, a synthetic pulse ----------
let actx = null, analyser = null, freqData = null, beat = 0;
function ensureAnalyser() {
  if (analyser || actx) return;
  try {
    actx = new AudioContext();
    if (actx.state !== 'running') { actx.resume().catch(() => {}); }
    if (actx.state !== 'running') { actx.close().catch(() => {}); actx = 'blocked'; return; } // otherwise the sound would go silent
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser); analyser.connect(actx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
  } catch (e) { actx = 'blocked'; }
}
function updateBeat(t) {
  if (frozenT !== null) { beat = 0; return; }           // debugging: no pulsing, otherwise the model scale wobbles
  let target;
  if (analyser && !audio.paused) {
    analyser.getByteFrequencyData(freqData);
    let s = 0; for (let i = 1; i < 12; i++) s += freqData[i];        // bass
    target = Math.min(1, Math.max(0, (s / 11 / 255 - 0.35) / 0.45));
  } else {
    target = 0.5 + 0.5 * Math.max(0, Math.sin(t * Math.PI * 2 * 2.13)); // ~128 BPM
  }
  beat = target > beat ? target : beat * 0.9 + target * 0.1;            // sharp attack, slow decay
}
// ---------- costumes ----------
// Props (not worn any more: they sat badly on the downloaded figures; kept for lookTest debugging).
// Coordinates are in the bone space of the old RPM dummy: on Head the eyes are at (+-0.030, 0.088, 0.082) and the
// top of the head at y~0.226, so +y is up and +z is forward (into the face).
const MAT = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra });
const GOLD = () => MAT(0xffd700, { metalness: 0.7, roughness: 0.25 });
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const bone = (o, n) => o.getObjectByName(n);

function garland(o) {
  const sp = bone(o, 'Spine2'), B = o.fit && o.fit.body; if (!sp || !B) return;
  // base of the neck: the lowest quarter of the neck vertices (or the top of the torso if there is no neck)
  let nx = B.box.getCenter(new THREE.Vector3()).x, nz = 0, nrx = 0.055, nrz = 0.05, yn = o.fit.torso.box.max.y - 0.02;
  if (o.fit.neck) {
    const ys = o.fit.neck.p.map((v) => v.y).sort((a, b) => a - b), y0 = ys[Math.round(0.25 * (ys.length - 1))], sl = o.fit.neck.slab(y0, 0.015);
    if (sl) { nx = sl.cx; nz = sl.cz; nrx = sl.rx; nrz = sl.rz; yn = y0; }
  }
  const g = new THREE.Group(), BR = 0.021, petal = new THREE.SphereGeometry(BR, 8, 8), n = 28;
  const drop = Math.min(0.2, (o.fit.torso.box.max.y - o.fit.torso.box.min.y) * 0.36);
  for (let i = 0; i < n; i++) {
    // beads form a loop: along the base of the neck at the back, over the shoulders at the sides, hanging onto the chest in front
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), w = Math.max(0, c);
    const x = nx + Math.sin(a) * (nrx + 0.03 + 0.08 * w);
    let y = yn - 0.012 - drop * Math.pow(w, 1.5), z;
    const zf = B.front(x, y) ?? nz + nrz, zb = B.back(x, y) ?? nz - nrz;
    if (c > 0.35) z = zf + BR * 0.85;
    else if (c < -0.35) z = zb - BR * 0.85;
    else {                                           // on the shoulder: between front and back, on top of the body
      z = THREE.MathUtils.lerp(zb, zf, (c + 0.35) / 0.7);
      const t = B.top(x, z); if (t !== null) y = Math.max(y, t + BR * 0.85);
    }
    const m = new THREE.Mesh(petal, MAT(i % 3 === 2 ? 0xff4500 : 0xffa500, { emissive: 0x552200 }));
    m.position.set(x, y, z);
    g.add(m);
  }
  sp.add(g);
}

function turban(o, color) {
  const h = bone(o, 'Head'), H = o.fit && o.fit.head; if (!h || !H) return;
  const G = headGeom(H), yb = G.eyeY + 0.3 * (G.top - G.eyeY);      // lower edge on the forehead, above the eyebrows
  const sl = H.all.slab(yb); if (!sl) return;
  const rx = sl.rx * 1.06 + 0.012, rz = sl.rz * 1.06 + 0.012, dh = G.top - yb + 0.05;
  const g = new THREE.Group(), mat = MAT(color, { roughness: 0.6 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.scale.set(rx, dh, rz); dome.position.set(sl.cx, yb, sl.cz);
  g.add(dome);
  // turns of cloth: the lower one thicker, the next one higher and narrower, as if wound
  for (const [f, th] of [[0, 0.16], [0.32, 0.12]]) {
    const k = Math.sqrt(1 - f * f), wrap = new THREE.Mesh(new THREE.TorusGeometry(1, th, 10, 40), mat);
    wrap.rotation.x = Math.PI / 2; wrap.scale.set(rx * k, rz * k, 0.12);
    wrap.position.set(sl.cx, yb + f * dh, sl.cz);
    g.add(wrap);
  }
  const jf = 0.42, jewel = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 12), GOLD());
  jewel.position.set(sl.cx, yb + jf * dh, sl.cz + rz * Math.sqrt(1 - jf * jf) + 0.008);
  // kalgi: a thin golden plume above the jewel, tilted back a little
  const plume = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.06, 8), GOLD());
  plume.position.set(sl.cx, yb + jf * dh + 0.035, sl.cz + rz * Math.sqrt(1 - jf * jf) - 0.006); plume.rotation.x = -0.35;
  g.add(jewel, plume);
  h.add(g);
}

// peaked cap: crown, visor in front (+z), red band and badge
function cap(o, color) {
  const h = bone(o, 'Head'), H = o.fit && o.fit.head; if (!h || !H) return;
  const G = headGeom(H), bandH = 0.032;
  // the crown is at most 7.5 cm tall: with full hair the cap sits higher instead of growing into a top hat
  const yb = Math.max(G.eyeY + 0.36 * (G.top - G.eyeY), G.top + 0.025 - bandH - 0.075);
  const sl = H.all.slab(yb); if (!sl) return;
  const rx = sl.rx * 1.04 + 0.008, rz = sl.rz * 1.04 + 0.008;
  const hc = THREE.MathUtils.clamp(G.top + 0.025 - (yb + bandH), 0.05, 0.075);   // the crown covers the top of the head with some margin
  const g = new THREE.Group(), mat = MAT(color, { roughness: 0.55 });
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), MAT(0x8b0000));
  band.scale.set(rx, bandH, rz); band.position.set(sl.cx, yb + bandH / 2, sl.cz);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1, 1, 32), mat);
  crown.scale.set(rx, hc, rz); crown.position.set(sl.cx, yb + bandH + hc / 2, sl.cz);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(1.22, 1.22, 1, 32), mat);
  lid.scale.set(rx, 0.01, rz); lid.position.set(sl.cx, yb + bandH + hc, sl.cz);
  const visor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1, false, -1.0, 2.0), MAT(0x14110d, { roughness: 0.35 }));
  visor.scale.set(rx * 1.02, 0.008, rz * 1.5); visor.position.set(sl.cx, yb + 0.004, sl.cz); visor.rotation.x = 0.14;
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.019, 16), GOLD());
  badge.position.set(sl.cx, yb + bandH + hc * 0.45, sl.cz + rz * 1.09 + 0.004);
  g.add(band, crown, lid, visor, badge);
  h.add(g);
}

function epaulettes(o) {
  const sp = bone(o, 'Spine2'), T = o.fit && o.fit.torso; if (!sp || !T) return;
  const sl = T.slab(T.box.max.y - 0.05, 0.02); if (!sl) return;
  for (const sx of [-1, 1]) {
    const x = sl.cx + sx * sl.rx * 0.78, y = T.top(x, sl.cz), y2 = T.top(x - sx * 0.04, sl.cz);
    if (y === null) continue;
    const g = new THREE.Group();
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.018, 0.11), GOLD());
    g.add(e);
    for (let k = 0; k < 5; k++) {                      // fringe along the outer edge
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.035, 5), GOLD());
      f.position.set(sx * 0.045, -0.02, -0.04 + k * 0.02);
      g.add(f);
    }
    g.position.set(x, y + 0.012, sl.cz);
    g.rotation.z = y2 !== null ? Math.atan2(y2 - y, 0.04) * -sx : 0;   // follows the slope of the shoulder
    g.userData.rigid = true;
    sp.add(g);
  }
}

function medals(o) {
  const sp = bone(o, 'Spine2'), T = o.fit && o.fit.torso; if (!sp || !T) return;
  const y = T.box.max.y - 0.13, sl = T.slab(y, 0.02); if (!sl) return;
  for (let i = 0; i < 3; i++) {
    const x = sl.cx + sl.rx * 0.28 + i * 0.036, z = T.front(x, y); if (z === null) continue;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.005, 14), GOLD());
    m.rotation.x = Math.PI / 2; m.position.set(x, y, z + 0.005);
    const rib = new THREE.Mesh(new THREE.PlaneGeometry(0.022, 0.03), MAT([0xff9933, 0x138808, 0x1c3f94][i], { side: THREE.DoubleSide }));
    rib.position.set(x, y + 0.028, (T.front(x, y + 0.028) ?? z) + 0.004);
    sp.add(m, rib);
  }
}

function beard(o, color) {
  const h = bone(o, 'Head'); if (!h) return;
  const mat = MAT(color, { roughness: 1 });
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 12), mat);
  jaw.scale.set(1.3, 1.15, 0.85); jaw.position.set(0, 0.012, 0.052);
  const chin = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 10), mat);
  chin.scale.set(1.1, 1.5, 0.9); chin.position.set(0, -0.035, 0.07);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.014, 0.022), mat);
  lip.position.set(0, 0.056, 0.088);
  h.add(jaw, chin, lip);
}

function mustache(o, color = 0x2a1a0e) {
  const h = bone(o, 'Head'); if (!h) return;
  const m = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0085, 8, 16, Math.PI), MAT(color, { roughness: 1 }));
  m.position.set(0, 0.052, 0.09); m.rotation.z = Math.PI; m.scale.set(1.15, 0.75, 0.6);
  h.add(m);
}

function glasses(o, frame = 0x1a1a1a) {
  const h = bone(o, 'Head'), H = o.fit && o.fit.head; if (!h || !H) return;
  const G = headGeom(H), fs = H.face.slab(G.eyeY) || H.all.slab(G.eyeY); if (!fs) return;
  let le, re, zf;
  if (H.eyes) { le = H.eyes.l.c; re = H.eyes.r.c; zf = Math.max(H.eyes.l.front, H.eyes.r.front) + 0.008; }
  else {                                              // no eyeballs: eyes placed by face proportions
    le = new THREE.Vector3(fs.cx + fs.rx * 0.36, G.eyeY, 0); re = new THREE.Vector3(fs.cx - fs.rx * 0.36, G.eyeY, 0);
    zf = Math.max(H.face.front(le.x, le.y) ?? fs.z1, H.face.front(re.x, re.y) ?? fs.z1) + 0.012;
  }
  // bridge: narrow, at eye level; a wider window caught the nose itself and the glasses slid to its tip
  const nose = H.face.front((le.x + re.x) / 2, G.eyeY + 0.006, 0.006);
  if (nose !== null) zf = Math.max(zf, nose + 0.003);
  const lr = THREE.MathUtils.clamp(Math.abs(le.x - re.x) * 0.4, 0.02, 0.028), ey = (le.y + re.y) / 2;
  const g = new THREE.Group(), mat = MAT(frame, { metalness: 0.4, roughness: 0.3 });
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x223344, transparent: true, opacity: 0.55, roughness: 0.15, metalness: 0.3 });
  const all = H.all.slab(ey) || fs;
  for (const e of [le, re]) {
    const sx = Math.sign(e.x - (le.x + re.x) / 2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(lr, 0.0045, 8, 24), mat);
    ring.position.set(e.x, ey, zf);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(lr * 0.95, 20), lensMat);
    lens.position.set(e.x, ey, zf);
    // temple arm from the edge of the frame back to the ear, along the side of the head
    const ax = (sx > 0 ? all.x1 : all.x0) + sx * 0.004, ear = all.cz - 0.01, len = Math.max(0.02, zf - ear);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.005, len), mat);
    arm.position.set((e.x + sx * lr + ax) / 2, ey + 0.004, ear + len / 2);
    arm.rotation.y = Math.atan2(ax - (e.x + sx * lr), len) * 0.5;
    g.add(ring, lens, arm);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, Math.abs(le.x - re.x) - 2 * lr), 0.005, 0.005), mat);
  bridge.position.set((le.x + re.x) / 2, ey + 0.004, zf);
  g.add(bridge);
  h.add(g);
}

// sash over the shoulder (sari, scarf, order ribbon)
function sash(o, color) {
  const sp = bone(o, 'Spine2'), T = o.fit && o.fit.torso; if (!sp || !T) return;
  const top = T.box.max.y, bot = T.box.min.y, H = top - bot;
  const sh = T.slab(top - 0.05, 0.02), wa = T.slab(bot + 0.1 * H, 0.03); if (!sh || !wa) return;
  // from the left shoulder to the right hip: across the chest in front, the back behind, over the shoulder on top
  const xs = sh.cx + sh.rx * 0.5, xh = wa.cx - wa.rx * 0.85, yh = bot + 0.08 * H;
  const ys = T.top(xs, sh.cz) ?? top;
  const path = (side) => { const pts = [];
    for (let i = 0; i <= 16; i++) { const t = i / 16, x = THREE.MathUtils.lerp(xs, xh, t), y = THREE.MathUtils.lerp(ys - 0.03, yh, t);
      const z = side > 0 ? T.front(x, y) : T.back(x, y); if (z !== null) pts.push(new THREE.Vector3(x, y, z + side * 0.008)); }
    return pts; };
  const front = path(1), back = path(-1); if (front.length < 4 || back.length < 4) return;
  const over = [];
  for (let i = 1; i < 6; i++) { const z = THREE.MathUtils.lerp(back[0].z, front[0].z, i / 6), y = T.top(xs, z); if (y !== null) over.push(new THREE.Vector3(xs, y + 0.008, z)); }
  const pts = [...back.reverse(), ...over, ...front];
  const nrm = [...back.map(() => new THREE.Vector3(0, 0, -1)), ...over.map(() => new THREE.Vector3(0, 1, 0)), ...front.map(() => new THREE.Vector3(0, 0, 1))];
  const band = ribbon(pts, nrm, 0.07, MAT(color, { roughness: 0.55, side: THREE.DoubleSide }));
  band.userData.flex = true;
  sp.add(band);
}

function dhoti(o, color) {
  const hips = bone(o, 'Hips'); if (!hips) return;
  const d = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.21, 0.28, 20, 1, true), MAT(color, { side: THREE.DoubleSide, roughness: 0.9 }));
  d.position.set(0, -0.17, 0);
  hips.add(d);
}

function dhol(o) {
  const sp = bone(o, 'Spine2'), T = o.fit && o.fit.torso; if (!sp || !T) return;
  const top = T.box.max.y, bot = T.box.min.y, H = top - bot, y = bot + 0.3 * H;
  const sl = T.slab(y, 0.03); if (!sl) return;
  sl.cx = T.box.getCenter(new THREE.Vector3()).x;          // middle of the torso from the shoulders, not from the slice: folds get in the way there
  const zf = T.front(sl.cx, y) ?? sl.z1, R = 0.085, L = 0.22;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 20), MAT(0x8b5a2b, { roughness: 0.8 }));
  body.rotation.z = Math.PI / 2;
  g.add(body);
  for (const sx of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.011, 8, 20), MAT(0xf0e0c0));
    rim.rotation.y = Math.PI / 2; rim.position.x = sx * L / 2;
    g.add(rim);
  }
  g.position.set(sl.cx, y, zf + R + 0.015);       // hangs in front of the belly without sinking into it
  g.userData.rigid = true;
  sp.add(g);
  // strap: from the edge of the drum up across the chest over the opposite shoulder
  const sh = T.slab(top - 0.05, 0.02); if (!sh) return;
  const xs = sh.cx - sh.rx * 0.5, ys = T.top(xs, sh.cz) ?? top, pts = [], nrm = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, x = THREE.MathUtils.lerp(sl.cx + L * 0.35, xs, t), yy = THREE.MathUtils.lerp(y + R * 0.8, ys - 0.02, t);
    const z = T.front(x, yy); if (z === null) continue;
    pts.push(new THREE.Vector3(x, yy, Math.max(z + 0.007, t < 0.25 ? zf + 0.02 : -Infinity))); nrm.push(new THREE.Vector3(0, 0, 1));
  }
  if (pts.length > 3) { const strap = ribbon(pts, nrm, 0.028, MAT(0xaa0000, { side: THREE.DoubleSide })); strap.userData.flex = true; sp.add(strap); }
}

function flowerCrown(o) {
  const h = bone(o, 'Head'), H = o.fit && o.fit.head; if (!h || !H) return;
  const G = headGeom(H);
  // the wreath sits where the head with hair is almost full width: higher it would float, lower it would sink
  let maxRx = 0;
  for (let y = G.top - 0.01; y > G.eyeY; y -= 0.008) { const sl = H.all.slab(y, 0.006); if (sl) maxRx = Math.max(maxRx, sl.rx); }
  let at = null;
  for (let y = G.top - 0.01; y > G.eyeY; y -= 0.004) { const sl = H.all.slab(y, 0.006); if (sl && sl.rx >= 0.9 * maxRx) { at = { y: y - 0.004, sl }; break; } }
  if (!at) return;
  const { y, sl } = at, rx = sl.rx + 0.003, rz = sl.rz + 0.003;
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.1, 8, 36), MAT(0x2e8b57));
  ring.rotation.x = Math.PI / 2; ring.scale.set(rx, rz, 0.12); ring.position.set(sl.cx, y, sl.cz);
  g.add(ring);
  const petal = new THREE.SphereGeometry(0.019, 8, 8);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const f = new THREE.Mesh(petal, MAT(i % 2 ? 0xffffff : 0xff69b4, { emissive: 0x220011 }));
    f.position.set(sl.cx + Math.sin(a) * rx, y + 0.008, sl.cz + Math.cos(a) * rz);
    g.add(f);
  }
  h.add(g);
}

function bindi(o) {
  const h = bone(o, 'Head'); if (!h) return;
  const d = new THREE.Mesh(new THREE.CircleGeometry(0.009, 12), MAT(0xcc0022, { emissive: 0x660011 }));
  d.position.set(0, 0.118, 0.098);
  h.add(d);
}

// Characters: each one is a set of props. w is the relative chance to be picked.
const CHARACTERS = [
  { name: 'civil', w: 20, outfits: ['kurta_white', 'kurta_teal', 'kurta_saffron', 'sherwani_red', 'cricket_blue'], build: (o) => { garland(o); if (Math.random() < 0.45) mustache(o); if (Math.random() < 0.25) glasses(o); } },
  { name: 'turban', w: 18, outfits: ['kurta_saffron', 'kurta_white', 'sherwani_red'], build: (o) => { turban(o, rnd(PALETTE)); mustache(o); garland(o); } },
  { name: 'military', w: 15, outfits: ['police_khaki', 'army_olive'], build: (o) => { cap(o, rnd([0x3b4a2f, 0x2f3b4a, 0x4a3b2f])); epaulettes(o); medals(o); mustache(o); } },
  { name: 'modi', w: 12, outfits: ['kurta_white', 'kurta_saffron'], build: (o) => { beard(o, 0xf0f0ee); glasses(o, 0x555555); sash(o, 0xff9933); } },
  { name: 'bride', w: 12, outfits: ['saree_pink', 'saree_green', 'sherwani_red'], build: (o) => { flowerCrown(o); bindi(o); sash(o, rnd([0xff2d55, 0xd4145a, 0xffd700])); garland(o); } },
  { name: 'dholi', w: 10, outfits: ['kurta_saffron', 'kurta_teal'], build: (o) => { dhol(o); turban(o, 0xff4500); mustache(o); } },
  { name: 'guru', w: 8, outfits: ['kurta_white', 'kurta_saffron'], build: (o) => { beard(o, 0xe8e8e8); dhoti(o, 0xfff5e0); sash(o, 0xffa500); } },
  { name: 'fan', w: 5, outfits: ['cricket_blue'], build: (o) => { sash(o, 0x00bfff); glasses(o, 0x111111); if (Math.random() < 0.5) mustache(o); } },
];

function dressUp(obj, forced, kind) {
  // a theme can favour matching characters: more brides at a wedding, more fans at cricket
  const boost = theme.chars || [];
  const pool = CHARACTERS.map((c) => ({ c, w: c.w * (boost.includes(c.name) ? 3 : 1) }));
  let pick = CHARACTERS.find((c) => c.name === forced);
  if (!pick) {
    let r = Math.random() * pool.reduce((a, x) => a + x.w, 0);
    pick = (pool.find((x) => (r -= x.w) <= 0) || pool[0]).c;
  }
  return pick.name;
}

let dancers = [];
let reelRect = null; // reel rectangle in px; dancers stand beside it, not on it

// ---------- layout without occlusion ----------
// Everything on stage (people, cows, animals, gods) takes a rectangle on screen: its bounding box with room for
// dancing, the beat and camera sway, projected to pixels. A spot is valid only if the rectangle stays clear of the
// reel and follows the overlap rules below. Order: cows and big animals, then the front row (lead, stars, both Modis),
// the back rows, the macaque, the gods. Whatever does not fit sits this reel out: fewer figures, each fully visible.
const SYNCS = [['унисон', 42], ['канон', 26], ['разнобой', 32]];   // in unison it reads as a routine, out of sync as a crowd
const STYLES = ['толпа', 'лесенка', 'шеренга'];                   // how people are spread in depth
const COW_H = 1.4;            // cow height, m, as a real cow next to a person
const COW_TURN = 0.3;         // on top of the camera view angle the body is turned inward, toward the reel, by ~17 degrees
const COW_SWAY = 0.28;        // and sways +-16 degrees without a full turn, so the space it needs is known
const MIN_PEOPLE = 14;        // a celebration is a crowd: never fewer than fourteen people
const BEAT_HZ = 2.13;         // ~128 BPM, same as the synthetic beat
const CAM_SWAY = 0.1;         // the camera sways +-10 cm, which needs a horizontal margin
const DANCER_H = 1.95;       // dancer height including a jump, m
const layCam = new THREE.PerspectiveCamera(38, 1, 0.1, 50);    // the camera in its middle position is what we measure with
function syncLayCam() {
  layCam.fov = camera.fov; layCam.aspect = camera.aspect; layCam.position.set(0, camY, 4.4); layCam.lookAt(0, lookY, 0);
  layCam.updateProjectionMatrix(); layCam.updateMatrixWorld(true);
}
const halfWAt = (z) => Math.tan(THREE.MathUtils.degToRad(layCam.fov / 2)) * layCam.aspect * (layCam.position.z - z);
const _lv = new THREE.Vector3();
// a w x h x d box with its base centred at (x, y0, z), union over the yaw angles; in screen pixels
function boxRect(x, y0, z, w, h, d, yaws = [0]) {
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  for (const yaw of yaws) {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    for (const sx of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) for (const yy of [0, h]) {
      const lx = sx * w, lz = sz * d;
      _lv.set(x + lx * c + lz * sn, y0 + yy, z - lx * sn + lz * c).project(layCam);
      const px = (_lv.x + 1) / 2 * innerWidth, py = (1 - _lv.y) / 2 * innerHeight;
      l = Math.min(l, px); r = Math.max(r, px); t = Math.min(t, py); b = Math.max(b, py);
    }
  }
  const sway = CAM_SWAY / Math.max(0.5, layCam.position.z - z) * (innerHeight / 2) / Math.tan(THREE.MathUtils.degToRad(layCam.fov / 2));
  return { l: l - sway, r: r + sway, t, b };
}
const hit = (a, b, pad = 0) => a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;
const overlapArea = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
// Crowd in rows. The front row stands as close as the frame allows (feet on the ground at the bottom edge);
// the lead, the stars and both Modis go there. People in one row do not touch each other. Back rows fill the gaps:
// the head of a farther person (top 14% of their rectangle) must not be hidden behind a nearer person's head or
// shoulders. The camera is a bit above eye level, so back heads rise above front shoulders. Shoulders and arms may
// overlap, which gives a busy crowd where every face is still visible.
// Between the rows run corridors, and vehicles drive strictly inside them without touching anyone. Row spacing comes
// from the sizes (metres behind the front row):
//   row 0: 0;  dogs: 0.7;  row 1: 1.7 (cows stand here; with its sway the body reaches back to ~3.0);
//   scooters: 3.6 (+-0.4 wide: 3.2 to 4.0);  row 2: 4.55 (a dancing person takes +-0.45);
//   tuk-tuks: 5.9 (+-0.75 wide: 5.15 to 6.65);  row 3: 7.25;  row 4: 8.95.
// The debug getter __iindu.stage.traffic reports the gaps (test/e2e/scene-shot.js prints them).
// Cows stand only in row 1, near the frame edges (in other rows the body would block a corridor); if there is no
// room they go to the last row. Big animals stand deepest, the macaque in front next to the reel.
const ROW_GAP = [0, 1.7, 4.55, 7.25, 8.95];
const LANE_GAP = { dog: 0.7, scooter: 3.6, tuktuk: 5.9 };
const BACK_GAP = 11.2;                 // the elephant and other big animals, behind the last row
let stageWhy = [];                     // why nothing fit (debugging)
function arrangeStage({ keep = false } = {}) {
  syncLayCam();
  const W = innerWidth, H = innerHeight;
  const reel = reelRect && reelRect.w < W * 0.9 ? { l: reelRect.x - 10, r: reelRect.x + reelRect.w + 10, t: reelRect.y - 10, b: reelRect.y + reelRect.h + 10 } : null;
  const reelCx = reelRect ? reelRect.x + reelRect.w / 2 : W / 2;
  const hide = (e) => { e.placed = false; e.obj.visible = false; if (e.shadow) e.shadow.visible = false; if (e.halo) e.halo.visible = false; };
  const show_ = (e, R) => { e.placed = true; e.rect = R; e.obj.visible = true; if (e.shadow) e.shadow.visible = true; if (e.halo) e.halo.visible = true; };
  const taken = [];
  if (keep) {
    for (const e of [...dancers, ...cows, ...beasts, ...gods]) if (e.placed) taken.push(e.rect);
  } else {
    for (const e of [...dancers, ...cows, ...beasts, ...gods]) hide(e);
    // front row: the closest depth at which the feet are still in frame
    let zF = 0.6;
    while (zF > -6 && boxRect(0, 0, zF, 0.6, DANCER_H, 0.15).b > H - 10) zF -= 0.1;
    zF -= 0.5;                                                  // a little deeper: people get smaller and the crowd fits
    const rows = ROW_GAP.map((g) => zF - g);
    lanes = { dog: zF - LANE_GAP.dog, scooter: zF - LANE_GAP.scooter, tuktuk: zF - LANE_GAP.tuktuk };
    const placed = [];                                          // { cx, w, row, R }
    stageWhy = [];
    const cxOf = (R) => (R.l + R.r) / 2, wOf = (R) => R.r - R.l;
    const sideOf = (R) => (cxOf(R) < reelCx ? -1 : 1);
    const count = { '-1': 0, 1: 0 };
    // best spot in row `row` for the rectangle that make(x) returns; the rules are described above
    // the farther person's head (top 14% of the rectangle) must be visible: not behind a nearer head or shoulders
    const headSeen = (R, p) => {
      const w = wOf(R), h = R.b - R.t, cx = cxOf(R);
      const F = { l: cx - 0.2 * w, r: cx + 0.2 * w, t: R.t, b: R.t + 0.14 * h };
      if (Math.abs(cx - p.cx) < 0.25 * (w + p.w) / 2) return false;          // not right behind someone
      const P = p.R, ph = P.b - P.t, a = (F.r - F.l) * (F.b - F.t);
      const occ = p.person
        ? overlapArea(F, { l: p.cx - 0.2 * p.w, r: p.cx + 0.2 * p.w, t: P.t, b: P.t + 0.14 * ph }) + overlapArea(F, { l: P.l, r: P.r, t: P.t + 0.14 * ph, b: P.b })
        : overlapArea(F, P);
      return occ < 0.3 * a;
    };
    const find = (row, make, { out = 0.25, nearFrac = 0.6, sameFrac = 0.8, prefer = null, head = false } = {}) => {
      const z = rows[row], hw = halfWAt(z), step = hw * 2 / (W / 6);
      let best = null, bestScore = -Infinity;
      const why = { n: 0, edge: 0, reel: 0, same: 0, near: 0, far: 0 };
      for (let x = -hw * 1.1; x <= hw * 1.1; x += step) {
        const g = make(x, z), R = g.R, cx = cxOf(R), w = wOf(R);
        why.n++;
        if (R.l < -out * w || R.r > W + out * w || R.t < 0) { why.edge++; continue; }
        if (reel && hit(R, reel, 2)) { why.reel++; continue; }
        let ok = true, spread = 3;
        for (const p of placed) {
          const d = Math.abs(cx - p.cx);
          if (p.row === row) { if (d < sameFrac * (w + p.w) / 2) { ok = false; why.same++; break; } spread = Math.min(spread, d / w); }
          else if (p.row < row) { if (head ? !headSeen(R, p) : d < nearFrac * (p.w + w) / 2) { ok = false; why.near++; break; } }
          else if (p.row < 9 && d < 0.5 * Math.max(p.w, w)) { ok = false; why.far++; break; }   // and not right in front of someone farther away (the elephant may be covered)
        }
        if (!ok) continue;
        const side = sideOf(R);
        let score = Math.min(spread, 2) - 0.6 * Math.max(0, count[side] - count[-side]) + 0.15 * Math.random();
        if (prefer === 'outer') score += 2 * Math.abs(cx - reelCx) / W;
        if (prefer === 'inner') score -= 2 * Math.abs(cx - reelCx) / W;
        if (score > bestScore) { bestScore = score; best = { x, z, g, R }; }
      }
      if (!best) stageWhy.push({ row, z: +z.toFixed(2), ...why, R: wOf(make(0, z).R) | 0 });
      return best;
    };
    const commit = (e, best, row, isPerson) => {
      const R = best.R;
      placed.push({ cx: cxOf(R), w: wOf(R), row, R, person: isPerson }); taken.push(R); show_(e, R);
      if (isPerson) count[sideOf(R)]++;
    };
    // --- people: the main ones in front ---
    const order = [...dancers].sort((a, b) => (b.lead - a.lead) || ((peopleRec(b)?.featured ? 1 : 0) - (peopleRec(a)?.featured ? 1 : 0)));
    const personAt = (d) => (x, z) => { const sc = d.base * 1.07; return { R: boxRect(x, 0, z, 0.5 * sc, DANCER_H * sc, 0.15) }; };
    const put = (d, best, row) => {
      d.obj.position.set(best.x, 0, best.z);
      d.obj.rotation.y = d.lead ? 0 : -Math.sign(best.x) * 0.12 + (d.ry || 0);       // slightly toward the centre of the frame
      if (d.shadow) d.shadow.position.set(best.x, 0.005, best.z);
      commit(d, best, row, true);
    };
    let row = 0;
    const queue = [...order];
    // cows and the dancing chimp first, in row 1, the cow near the frame edge (otherwise people take all the room)
    for (const c of cows) {
      const make = (x, z) => {
        if (c.beast) return { R: boxRect(x, 0, z, Math.max(c.dims.W, 0.7), c.dims.H + 0.1, 0.3), psi: 0 };
        const sgn = x < 0 ? -1 : 1, psi = -sgn * (Math.atan2(Math.abs(x), layCam.position.z - z) + COW_TURN);
        return { R: boxRect(x, 0, z, c.dims.W, COW_H + 0.1, c.dims.L, [psi - COW_SWAY, psi, psi + COW_SWAY]), psi };
      };
      const last = rows.length - 1;
      const b = find(1, make, { out: c.beast ? 0 : 0.25, nearFrac: 0.5, prefer: c.beast ? null : 'outer' }) || find(last, make, { out: 0.3, nearFrac: 0.4, prefer: 'outer' });
      if (!b) continue;
      c.x = b.x; c.z = b.z; c.psi = b.g.psi; c.side = sideOf(b.R);
      c.obj.position.set(c.x, 0, c.z); c.obj.rotation.set(0, c.psi, 0);
      c.shadow.position.set(c.x, 0.005, c.z); c.shadow.rotation.y = c.psi;
      commit(c, b, b.z === rows[1] ? 1 : last, false);
    }
    // --- big animals deep in the back (before people, who then stand in front of them) and the macaque next to the reel (after) ---
    const placeBeast = (bst) => {
      const corner = bst.rec.place === 'corner', dm = bst.dims;
      const make = (x, z) => {
        const sgn = x < 0 ? -1 : 1, psi = corner ? -sgn * 0.5 : -sgn * (Math.atan2(Math.abs(x), layCam.position.z - z) * 0.6 + 0.45);
        return { R: boxRect(x, 0, z, dm.W, dm.H + 0.05, dm.L, corner ? [psi - 0.35, psi + 0.35] : [psi]), psi };
      };
      let b = null;
      if (corner) b = find(0, make, { prefer: 'inner', sameFrac: 0.9 }) || find(1, make, { prefer: 'inner' });
      else { rows.push(zF - BACK_GAP); b = find(rows.length - 1, make, { out: 0.3, nearFrac: 0.3, prefer: 'outer' }); rows.pop(); }
      if (!b) return;
      bst.psi = b.g.psi; bst.obj.position.set(b.x, 0, b.z); bst.obj.rotation.set(0, bst.psi, 0);
      bst.shadow.position.set(b.x, 0.004, b.z); bst.shadow.rotation.z = bst.psi;
      commit(bst, b, corner ? 0 : 9, false);
    };
    for (const bst of beasts) if (bst.rec.place !== 'corner') placeBeast(bst);
    // front row while there is room
    while (queue.length) { const d = queue[0], b = find(0, personAt(d), { out: 0.12, sameFrac: 1.15 }); if (!b) break; put(d, b, 0); queue.shift(); }   // with gaps for the rows behind
    // the rest of the people go to rows 2, 3 and 4, into the gaps
    for (row = 1; row < rows.length && queue.length; row++) {
      while (queue.length) { const d = queue[0], b = find(row, personAt(d), { head: true }); if (!b) break; put(d, b, row); queue.shift(); }
    }
    for (const bst of beasts) if (bst.rec.place === 'corner') placeBeast(bst);
    if (traffic.length) placeTraffic();
  }
  // --- gods: in the sky where it is free (and not under the title) ---
  const tb = $('title').getBoundingClientRect();
  if (tb.width) taken.push({ l: tb.left - 10, r: tb.right + 10, t: tb.top - 10, b: tb.bottom + 36 });
  if (reel) taken.push(reel);
  const free = (R) => !taken.some((o) => hit(R, o, 2));
  const XS = []; for (let xn = -1.1; xn <= 1.1; xn += 0.05) XS.push(xn);
  for (const g of gods.filter((g) => !g.placed)) {
    const dm = g.dims;
    let best = null, bestScore = -Infinity;
    for (const sc of [1, 0.8, 0.62, 0.5]) for (const z of [-3, -4.5, -6]) for (const y0 of [1.4, 1.9, 2.4, 2.9, 3.4]) {
      const hw = halfWAt(z), Hs = dm.H * sc;
      for (const xn of XS) {
        const x = xn * hw;
        const Rs = boxRect(x, y0 - 0.08, z, dm.W * sc, Hs + 0.16, dm.D * sc, [-0.45, 0, 0.45]);
        const Rh = boxRect(x, y0 + 0.1 * Hs, z - 0.35, 1.05 * Hs, 1.05 * Hs, 0.01);
        const R = { l: Math.min(Rs.l, Rh.l), r: Math.max(Rs.r, Rh.r), t: Math.min(Rs.t, Rh.t), b: Math.max(Rs.b, Rh.b) };
        if (R.l < 0 || R.r > W || R.t < 0 || !free(R)) continue;
        const score = 2 * sc - 0.2 * Math.abs(xn) + 0.1 * Math.random();
        if (score > bestScore) { bestScore = score; best = { x, z, y0, sc, R }; }
      }
    }
    if (!best) { hide(g); continue; }
    const Hs = dm.H * best.sc;
    g.obj.scale.setScalar(best.sc); g.obj.position.set(best.x, best.y0, best.z); g.base = best.y0;
    g.halo.scale.setScalar(1.05 * Hs / 2); g.haloDy = 0.625 * Hs; g.halo.position.set(best.x, best.y0 + g.haloDy, best.z - 0.35);
    show_(g, best.R); taken.push(best.R);
  }
  if (!keep) console.debug(`[ИИндус] расстановка: людей ${dancers.filter((d) => d.placed).length}/${dancers.length}, коров ${cows.filter((c) => c.placed).length}/${cows.length}, животных ${beasts.filter((b) => b.placed).length}/${beasts.length}`);
}
const peopleRec = (d) => d.file && people.find((p) => p.file === d.file);

function pickChoreography() {
  const formation = rnd(STYLES);
  let r = Math.random() * SYNCS.reduce((a, [, w]) => a + w, 0);
  const sync = (SYNCS.find(([, w]) => (r -= w) <= 0) || SYNCS[0])[0];
  return { formation, sync };
}

// Prop adapter. Turbans, glasses and garlands used to be drawn in the RPM dummy's bone space and copied to other
// skeletons as is. Downloaded models have a different head and torso size and sit differently relative to their bones
// (on the kurta model the head is a face mask plus separate hair), so props floated above the head, sank into the chest
// or stuck out sideways. Now each prop is built on the real body surface: under the bone hangs a group with the dummy's
// axes (+y up, +z forward), holding a point cloud of this model's head and torso in rest pose. A hat follows the head
// cross-section at forehead height, glasses follow the eyeballs, garland and sash follow the chest and back, epaulettes
// sit on top of the shoulders.
const fitCache = new Map();
// point cloud in adapter space with quick queries for where the body surface is
class Cloud {
  constructor(pts) {
    this.p = pts;
    const q = (a, t) => a[Math.round(t * (a.length - 1))];
    const xs = pts.map((v) => v.x).sort((a, b) => a - b), ys = pts.map((v) => v.y).sort((a, b) => a - b), zs = pts.map((v) => v.z).sort((a, b) => a - b);
    this.box = new THREE.Box3(new THREE.Vector3(q(xs, 0.01), q(ys, 0.01), q(zs, 0.01)), new THREE.Vector3(q(xs, 0.99), q(ys, 0.99), q(zs, 0.99)));
  }
  // slice at height y: centre and half-axes along x and z (5th to 95th percentile of the points in the slice)
  slab(y, h = 0.012) {
    let pts = this.p.filter((v) => Math.abs(v.y - y) < h);
    if (pts.length < 8) pts = this.p.filter((v) => Math.abs(v.y - y) < h * 3);
    if (pts.length < 4) return null;
    const q = (a, t) => a[Math.round(t * (a.length - 1))];
    const xs = pts.map((v) => v.x).sort((a, b) => a - b), zs = pts.map((v) => v.z).sort((a, b) => a - b);
    const x0 = q(xs, 0.03), x1 = q(xs, 0.97), z0 = q(zs, 0.03), z1 = q(zs, 0.97);
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2, rz: (z1 - z0) / 2, x0, x1, z0, z1 };
  }
  // outermost body point nearby: front (max z), back (min z), top (max y)
  extreme(a, b, axA, axB, axOut, sign, r = 0.025) {
    for (let k = 0; k < 4; k++, r *= 1.8) {
      let best = null;
      for (const v of this.p) if (Math.abs(v[axA] - a) < r && Math.abs(v[axB] - b) < r) { const w = v[axOut] * sign; if (best === null || w > best) best = w; }
      if (best !== null) return best * sign;
    }
    return null;
  }
  front(x, y, r) { return this.extreme(x, y, 'x', 'y', 'z', 1, r); }
  back(x, y) { return this.extreme(x, y, 'x', 'y', 'z', -1); }
  top(x, z) { return this.extreme(x, z, 'x', 'z', 'y', 1); }
}
// head, face, eye, neck and torso vertices in world space (rest pose)
function collectBody(root) {
  root.updateMatrixWorld(true);
  const out = { head: [], face: [], eyes: [], neck: [], torso: [] }, v = new THREE.Vector3();
  const TORSO = new Set(['Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder']);
  const regionOf = (b) => {
    if (!b) return null;
    if (b.name === 'Neck') return 'neck';
    if (TORSO.has(b.name)) return 'torso';
    for (let x = b; x && x.isBone; x = x.parent) { if (x.name === 'Head') return 'head'; if (x.name === 'Neck') break; }
    return null;
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.prop) return;
    const mname = [].concat(o.material).map((m) => (m && m.name) || '').join(' ');
    if (/glass|eyewear/i.test(mname)) out.glasses = true;          // the model already wears glasses, no second pair
    const hair = HAIRMAT.test(mname), eye = /eyeball/i.test(mname), detail = /lash|cornea|teeth|tongue|eyeball/i.test(mname);
    const add = (r) => {
      const p = v.clone();
      if (r !== 'head') out[r].push(p);
      else if (eye) out.eyes.push(p);
      else if (!detail) { out.head.push(p); if (!hair) out.face.push(p); }   // eyelashes and teeth are dense small parts that pulled the head toward the eyes
    };
    const P = o.geometry.attributes.position, n = P.count, step = Math.max(1, Math.floor(n / 9000));
    if (o.isSkinnedMesh) {
      const SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight, bones = o.skeleton.bones;
      for (let i = 0; i < n; i += step) {
        let best = 0, bw = -1;
        for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > bw) { bw = w; best = SI.getComponent(i, c); } }
        const r = regionOf(bones[best]);
        if (r) { o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld); add(r); }
      }
    } else {                                           // plain mesh on a bone: glasses, a pen in a pocket
      let r = null;
      for (let x = o.parent; x && !r; x = x.parent) if (x.isBone) r = regionOf(x);
      if (r) for (let i = 0; i < n; i += step) { v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); add(r); }
    }
  });
  return out;
}
// into adapter space, thinned on a 1 cm grid: one point per cell, so dense meshes do not dominate
const toFrame = (pts, f, max = 3500, cell = 0.01) => {
  const iq = f.q.clone().invert(), seen = new Set(), out = [];
  for (const p of pts) {
    const l = p.clone().sub(f.pos).applyQuaternion(iq).divideScalar(f.s);
    const k = `${Math.round(l.x / cell)},${Math.round(l.y / cell)},${Math.round(l.z / cell)}`;
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
};
// everything the props need, in the head and chest adapter spaces
// Torso skin for attaching props: body and clothing vertices (pelvis, back, chest, neck, shoulders, thighs)
// with their skin weights, in the dancer's own space so it works for every clone of the model.
const SKIN_REGION = /^(Hips|Spine\d?|Neck|(Left|Right)(Shoulder|Arm|UpLeg))$/;
function collectSkin(obj) {
  obj.updateMatrixWorld(true);
  const pos = [], bones = [], wts = [], v = new THREE.Vector3(), inv = obj.matrixWorld.clone().invert();
  obj.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible || o.userData.prop) return;
    const P = o.geometry.attributes.position, SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight, B = o.skeleton.bones;
    const step = Math.max(1, Math.floor(P.count / 6000));
    for (let i = 0; i < P.count; i += step) {
      let best = 0, bw = -1;
      for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > bw) { bw = w; best = SI.getComponent(i, c); } }
      if (!B[best] || !SKIN_REGION.test(B[best].name)) continue;
      o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      pos.push(v.x, v.y, v.z);
      const bn = [], bw4 = [];
      for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > 0.01 && B[SI.getComponent(i, c)]) { bn.push(B[SI.getComponent(i, c)].name); bw4.push(w); } }
      bones.push(bn); wts.push(bw4);
    }
  });
  // 4 cm grid for nearest-neighbour lookup
  const grid = new Map(), C = 0.04, key = (x, y, z) => `${Math.floor(x / C)},${Math.floor(y / C)},${Math.floor(z / C)}`;
  for (let i = 0; i < pos.length / 3; i++) { const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  return { pos, bones, wts, grid, C };
}
// skin weights at a point (dancer space): blend of the nearest skin vertices' weights, weighted by 1/distance
function skinWeightsAt(S, x, y, z, k = 4) {
  let found = [];
  for (let r = 1; r <= 4 && found.length < k; r++) {
    found = [];
    const cx = Math.floor(x / S.C), cy = Math.floor(y / S.C), cz = Math.floor(z / S.C);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
      const list = S.grid.get(`${cx + a},${cy + b},${cz + c}`); if (!list) continue;
      for (const i of list) found.push([Math.hypot(S.pos[i * 3] - x, S.pos[i * 3 + 1] - y, S.pos[i * 3 + 2] - z), i]);
    }
  }
  found.sort((p, q) => p[0] - q[0]);
  const acc = new Map();
  for (const [d, i] of found.slice(0, k)) {
    const f = 1 / Math.max(0.004, d);
    S.bones[i].forEach((n, j) => acc.set(n, (acc.get(n) || 0) + f * S.wts[i][j]));
  }
  const top = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4), sum = top.reduce((a, [, w]) => a + w, 0) || 1;
  return top.map(([n, w]) => [n, w / sum]);
}

function measureFit(obj, frames) {
  const b = collectBody(obj), fit = { glasses: !!b.glasses, skin: collectSkin(obj) };
  if (frames.Head && b.head.length > 30) {
    const all = new Cloud(toFrame(b.head, frames.Head)), face = b.face.length > 30 ? new Cloud(toFrame(b.face, frames.Head)) : all;
    let eyes = null;
    const ep = toFrame(b.eyes, frames.Head, 2000, 0.002);
    if (ep.length > 20) {                            // eyeballs: split by the sign of x relative to the middle of the face
      const mid = face.box.getCenter(new THREE.Vector3()).x;
      const side = (sgn) => { const s = ep.filter((v) => (v.x - mid) * sgn > 0); if (s.length < 5) return null;
        const c = s.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(s.length);
        return { c, front: Math.max(...s.map((v) => v.z)), r: (Math.max(...s.map((v) => v.y)) - Math.min(...s.map((v) => v.y))) / 2 }; };
      const l = side(1), r = side(-1);
      if (l && r) eyes = { l, r };
    }
    fit.head = { all, face, eyes };
  }
  if (frames.Spine2 && b.torso.length > 30) {
    fit.torso = new Cloud(toFrame(b.torso, frames.Spine2, 4000));
    fit.body = b.neck.length ? new Cloud(toFrame([...b.torso, ...b.neck], frames.Spine2, 5000)) : fit.torso;   // with the neck, for the garland
    if (b.neck.length > 10) fit.neck = new Cloud(toFrame(b.neck, frames.Spine2, 1500));
  }
  return fit;
}
function propRig(obj, key) {
  const R = boneMap(assets.m.scene), T = boneMap(obj);
  assets.m.scene.updateMatrixWorld(true); obj.updateMatrixWorld(true);
  const objQ = obj.getWorldQuaternion(new THREE.Quaternion()), rootQ = objQ.clone().invert();
  const rootS = obj.getWorldScale(new THREE.Vector3());
  const adapters = {}, frames = {};
  for (const name of ['Head', 'Neck', 'Spine2', 'Hips']) {
    const tb = T[name], rb = R[name];
    if (!tb || !rb) continue;
    const qt = rootQ.clone().multiply(tb.getWorldQuaternion(new THREE.Quaternion()));
    const qr = rb.getWorldQuaternion(new THREE.Quaternion());
    const st = tb.getWorldScale(new THREE.Vector3()).divide(rootS), sr = rb.getWorldScale(new THREE.Vector3());
    const a = new THREE.Group();
    a.quaternion.copy(qt.invert().multiply(qr));
    a.scale.set(sr.x / st.x, sr.y / st.y, sr.z / st.z);
    tb.add(a);
    adapters[name] = a;
    frames[name] = { pos: tb.getWorldPosition(new THREE.Vector3()), q: objQ.clone().multiply(qr), s: rootS.x * sr.x };
  }
  // one figure per file: measured once, clones read the cache
  let fit = key && fitCache.get(key);
  if (!fit) { fit = measureFit(obj, frames); if (key) fitCache.set(key, fit); }
  return { getObjectByName: (n) => adapters[n] || null, fit, finish: () => skinProps(obj, adapters, fit) };
}
// Torso props (beads, sash, epaulettes, dhol) become clothing: they get skin weights from the nearest skin and
// move with it. They used to be pinned to the chest bone, so when a dancer raised the shoulders or leaned, the beads
// hung in the air and the sash went inside the body. Rigid parts (a bead, an epaulette, the drum) take the weights of
// one point, the one nearest their centre, and do not bend; ribbons (userData.flex) are weighted per vertex and follow
// the body. Hats and glasses stay on the head bone: the head is rigid anyway.
function skinProps(obj, adapters, fit) {
  const S = fit.skin; if (!S || !S.pos.length) return;
  let body = null;
  obj.traverse((o) => { if (o.isSkinnedMesh && !o.userData.prop && (!body || o.skeleton.bones.length > body.skeleton.bones.length)) body = o; });
  if (!body) return;
  obj.updateMatrixWorld(true);
  const skel = body.skeleton, idxOf = new Map(skel.bones.map((b, i) => [b.name, i]));
  const boneM = skel.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skel.boneInverses[i]));
  const toLocal = obj.matrixWorld.clone().invert(), v = new THREE.Vector3(), c = new THREE.Vector3();
  const groups = new Map();                                        // material -> geometries
  const blend = (ws) => {                                          // sum of w * (bone * inverse bind)
    const A = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), e = A.elements;
    for (const [n, w] of ws) { const m = boneM[idxOf.get(n)]; if (!m) continue; for (let k = 0; k < 16; k++) e[k] += w * m.elements[k]; }
    return A;
  };
  const weightsFor = (p) => skinWeightsAt(S, ...v.copy(p).applyMatrix4(toLocal).toArray()).filter(([n]) => idxOf.has(n));
  for (const name of ['Spine2', 'Neck', 'Hips']) {
    const ad = adapters[name]; if (!ad) continue;
    const meshes = [];
    ad.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      // anchor of a rigid part: centre of the nearest ancestor with userData.rigid, otherwise of the mesh itself
      let anchor = m;
      for (let x = m.parent; x && x !== ad; x = x.parent) if (x.userData.rigid) anchor = x;
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);   // world space, rest pose
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.attributes.normal) g.computeVertexNormals();
      const P = g.attributes.position, N = g.attributes.normal, n = P.count;
      const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
      let fixed = null;
      if (!m.userData.flex) {
        new THREE.Box3().setFromObject(anchor).getCenter(c);
        const ws = weightsFor(c); fixed = { ws, inv: blend(ws).invert() };
      }
      const nm = new THREE.Matrix3();
      for (let i = 0; i < n; i++) {
        let ws, inv;
        if (fixed) ({ ws, inv } = fixed);
        else { v.fromBufferAttribute(P, i); ws = weightsFor(v); inv = blend(ws).invert(); }
        ws.forEach(([bn, w], k) => { SI[i * 4 + k] = idxOf.get(bn); SW[i * 4 + k] = w; });
        v.fromBufferAttribute(P, i).applyMatrix4(inv); P.setXYZ(i, v.x, v.y, v.z);          // into the bind pose
        nm.setFromMatrix4(inv); v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); N.setXYZ(i, v.x, v.y, v.z);
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k);
      if (!g.index) g.setIndex([...Array(n).keys()]);
      const mat = m.material, mk = [mat.color?.getHex(), mat.emissive?.getHex(), mat.metalness, mat.roughness, mat.side, mat.transparent].join('|');
      (groups.get(mk) || groups.set(mk, { mat, geos: [] }).get(mk)).geos.push(g);
      m.removeFromParent();
    }
  }
  // one skinned mesh per material: about ten draw calls instead of a hundred
  for (const { mat, geos } of groups.values()) {
    const merged = geos.length > 1 ? mergeGeometries(geos) : geos[0];
    if (!merged) continue;
    const sm = new THREE.SkinnedMesh(merged, mat);
    sm.frustumCulled = false; sm.userData.prop = true;
    obj.add(sm);
    sm.updateMatrixWorld(true);
    // binding: world(v) = sum of w * (bone * inverse) * bindMatrix * v, and bindMatrix is the mesh's own world matrix.
    // That is why positions above were mapped through the inverse blend (A^-1); here the mesh matrix is removed as well.
    const Minv = sm.matrixWorld.clone().invert(), Pm = merged.attributes.position, Nm = merged.attributes.normal, n3 = new THREE.Matrix3().setFromMatrix4(Minv);
    for (let i = 0; i < Pm.count; i++) {
      v.fromBufferAttribute(Pm, i).applyMatrix4(Minv); Pm.setXYZ(i, v.x, v.y, v.z);
      v.fromBufferAttribute(Nm, i).applyMatrix3(n3).normalize(); Nm.setXYZ(i, v.x, v.y, v.z);
    }
    sm.bind(skel, sm.matrixWorld);
  }
}
// ribbon over the body surface: path points and normals (where the surface faces) -> a strip of width w
function ribbon(points, normals, w, mat) {
  const pos = [], idx = [], T = new THREE.Vector3(), W = new THREE.Vector3();
  points.forEach((p, i) => {
    T.subVectors(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]).normalize();
    W.crossVectors(T, normals[i]).normalize().multiplyScalar(w / 2);
    pos.push(p.x - W.x, p.y - W.y, p.z - W.z, p.x + W.x, p.y + W.y, p.z + W.z);
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
// head: eye height, top and centre from the point cloud (eyes from the eyeballs, or from face proportions if there are none)
function headGeom(H) {
  const b = H.all.box, fb = H.face.box, top = b.max.y, chin = fb.min.y;
  const eyeY = H.eyes ? (H.eyes.l.c.y + H.eyes.r.c.y) / 2 : chin + 0.58 * (fb.max.y - chin);
  return { top, chin, eyeY, cx: (b.min.x + b.max.x) / 2 };
}

// what a downloaded person may wear: they have their own clothes and hair, so no beards or dhoti
const LOOKS = [
  ['без шапки', (o) => { if (Math.random() < 0.6) garland(o); }],
  ['тюрбан', (o) => { turban(o, rnd(PALETTE)); if (Math.random() < 0.5) garland(o); }],
  ['фуражка', (o) => { cap(o, rnd([0x3b4a2f, 0x2f3b4a, 0x4a3b2f])); epaulettes(o); }],
  ['венок', (o) => { flowerCrown(o); garland(o); }],
  ['очки', (o) => { glasses(o); if (Math.random() < 0.5) sash(o, rnd(PALETTE)); }],
  ['дхол', (o) => { dhol(o); turban(o, 0xff4500); }],
  ['лента', (o) => { sash(o, rnd([0xff9933, 0x138808, 0xffffff, 0xff2d55])); garland(o); }],
];
const CLOTH = /outfit|top|bottom|look|kurta|shirt|pant|dress|saree/i, HAIRMAT = /hair/i;
const DYES = [0xffb366, 0xc0392b, 0x1abc9c, 0xf1c40f, 0xff69b4, 0x27ae60, 0x3a5bd0, 0x8e44ad, 0xffffff];
// tint over the texture: light cloth gets colour, folds and patterns stay
function recolorPerson(obj) {
  const dye = Math.random() < 0.8 ? new THREE.Color(rnd(DYES)) : null;
  const hair = Math.random() < 0.3 ? new THREE.Color(rnd([0x9a9a9a, 0x5a3a22, 0xd8c8a8])) : null;
  obj.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const out = list.map((m) => {
      const n = m.name || '';
      if (dye && CLOTH.test(n)) { const c = m.clone(); c.color.multiply(dye); return c; }
      if (hair && HAIRMAT.test(n)) { const c = m.clone(); c.color.multiply(hair); return c; }
      return m;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
}

let forcedCostume = null, forcedPerson = null;   // for debug screenshots
let camOverride = null;                           // debugging: close-up camera
let frozenT = null;                               // debugging: frozen time, for pixel comparisons
let chore = { formation: 'шеренга', sync: 'разнобой' };
function spawnDancers(n, forcedChore, { lead = null } = {}) {
  clearDancers();
  chore = forcedChore || pickChoreography();
  n = Math.max(MIN_PEOPLE, n);                              // crowd: at least MIN_PEOPLE
  if (lead) n += 1;
  const groupClip = pickDance(assets.m.clips);             // in unison and canon everyone dances the same dance
  const groupSpeed = 0.95 + Math.random() * 0.25;
  // deck for the stage: each loaded person comes out once; at most three stars (two with a lead), or half the stage is Modi
  const pool = people.filter((p) => (p.kind === 'm' || p.kind === 'f') && peopleCache.has(p.file) && p.file !== SPIDEY_FILE).sort(() => Math.random() - 0.5);
  const crowd = pool.filter((p) => !lead || p.file !== lead.file);
  // themed people first (cricketers at cricket, saris and festive clothes at a wedding), then the rest
  const onTheme = (p) => (p.themes || []).includes(theme.name);
  const stars = crowd.filter((p) => p.featured).sort((a, b) => (/^modi/.test(b.file) - /^modi/.test(a.file)) || (onTheme(b) - onTheme(a))).slice(0, lead ? 2 : 3);
  const plain = crowd.filter((p) => !p.featured).sort((a, b) => onTheme(b) - onTheme(a));
  const deck = [...stars, ...plain].slice(0, Math.max(n, 1)).sort(() => Math.random() - 0.5);
  for (let i = 0; i < n; i++) {
    // the downloaded Indian models dance; the mannequin is the fallback when no model loaded (or the build has none)
    const isLead = lead && i === 0;
    // beyond the deck, repeats come only from ordinary people (recoloured): two identical Modis would look odd
    const k = lead ? i - 1 : i, extra = plain.length ? plain : deck;
    const rec = isLead ? lead : !forcedCostume && deck.length ? (k < deck.length ? deck[k] : extra[(k - deck.length) % extra.length]) : null;
    const kind = rec ? (rec.kind === 'f' ? 'f' : 'm') : (Math.random() < 0.5 ? 'm' : 'f');
    const src = assets[kind];
    const ready = rec && peopleCache.get(rec.file)?.holder;
    const obj = ready ? skeletonClone(ready) : makeMannequin();
    const ry = (Math.random() - .5) * (chore.sync === 'разнобой' ? 0.5 : 0.1);   // position and turn toward the reel come from arrangeStage
    const mixer = new THREE.AnimationMixer(obj);
    let idx = chore.sync === 'разнобой' ? pickDance(src.clips, rec && rec.dances) : groupClip % src.clips.length;
    // models with fragile skinning dance only their own list (dances in people.json, chosen by test/e2e/dance-fit.js):
    // the second Modi's vest is welded to his hands, and on wide-armed dances the hand drags a piece of vest along
    if (rec && rec.dances && !rec.dances.includes(src.clips[idx].name)) idx = pickDance(src.clips, rec.dances);
    const raw = src.clips[idx];
    let clip = raw;
    if (ready) {
      try { clip = bakeRetarget(rec, kind, idx) || rotationOnly(raw); }
      catch (e) { console.warn('[ИИндус] переназначение танца не вышло:', rec.file, e.message); clip = rotationOnly(raw); }
    }
    const action = mixer.clipAction(clip);
    action.timeScale = chore.sync === 'разнобой' ? 0.9 + Math.random() * 0.35 : groupSpeed;
    action.time = chore.sync === 'унисон' ? 0
      : chore.sync === 'канон' ? (i / n) * clip.duration        // a wave: each dancer starts with an offset
      : Math.random() * clip.duration;
    action.play();
    // every dancer looks different: clothes and hair get their own colour.
    // Stars (Modi, Spider-Man, the policeman) are not recoloured so they stay recognisable.
    let who;
    if (ready) {
      who = rec.file.replace('.glb', '');
      // accessories (hats, beads, glasses) are gone: they sat badly on the downloaded figures. Variety comes from
      // the set of models plus recoloured clothes and hair on ordinary (non-star) people.
      if (!rec.featured && rec.file !== 'police.glb' && !rec.noDye) recolorPerson(obj);
    } else who = dressUp(obj, forcedCostume, kind);
    obj.scale.setScalar(chore.sync === 'разнобой' ? 0.92 + Math.random() * 0.16 : 0.97 + Math.random() * 0.06);   // in a routine heights are more even
    if (isLead) { obj.rotation.y = 0; obj.scale.setScalar(1.05); action.timeScale = 0.75; who += '/солист'; }
    scene.add(obj);
    // soft shadow under a dancer: on a backdrop photo people look like they float without it
    const shadow = new THREE.Mesh(DANCER_SHADOW_GEO, new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.5 }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.set(obj.position.x, 0.005, obj.position.z);
    scene.add(shadow);
    dancers.push({ obj, mixer, who, base: obj.scale.x, lead: !!isLead, file: rec && rec.file, shadow, hips: boneMap(obj).Hips || null, ry, mannequin: !ready });
    if (rec && peopleCache.has(rec.file)) peopleCache.get(rec.file).usedAt = performance.now();
  }
  arrangeStage();
  console.debug(`[ИИндус] композиция: ${chore.formation}, ${chore.sync}`);
}
// Cows live apart from the dancers. Their built-in animations are unusable: the Cow Dance clip is recorded on a
// biped skeleton (Bip01) and makes the cow rear up, the Polish cow spins its root bone and hangs upside down.
// The dance follows the meme: the cow stands on four legs facing the viewer, sways to the beat, hops on every beat
// and nods. It never turns around fully, otherwise the body would hit the dancers.
let cows = [], cowToken = 0, cowFreeze = false;   // cowFreeze is only for debug screenshots
async function spawnCows(n) {
  clearCows();
  const token = ++cowToken;
  const herd = people.filter((p) => p.kind === 'cow');
  if (!herd.length) return;
  for (let i = 0; i < n; i++) {
    const rec = (forcedPerson && herd.find((h) => h.file === forcedPerson)) || rnd(herd);
    const loaded = peopleCache.get(rec.file) || await loadPerson(rec).catch(() => null);
    if (token !== cowToken) return;                     // a new celebration started while these were loading
    if (!loaded || !loaded.cow || !running) continue;
    const obj = skeletonClone(loaded.holder);
    obj.rotation.order = 'YXZ';                         // yaw in world space, roll and pitch in the cow's axes
    const nb = loaded.cow.nod && obj.getObjectByName(loaded.cow.nod.name);
    const legs = (loaded.cow.legs || []).map((L) => ({ ...L, bones: L.names.map((n) => obj.getObjectByName(n)) })).filter((L) => L.bones.every(Boolean));
    // soft shadow on the floor: a cow standing behind the dancers looks like it floats without it
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(loaded.cow.W * 1.6, loaded.cow.L * 1.15),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.55 }));
    shadow.rotation.order = 'YXZ';
    shadow.rotation.x = -Math.PI / 2;
    obj.visible = shadow.visible = false;
    cows.push({ obj, shadow, file: rec.file, dims: loaded.cow, x: 0, z: 0, psi: 0, side: 1, phase: Math.random() * 2,
      nod: nb ? { bone: nb, axis: loaded.cow.nod.axis, rest: loaded.cow.nod.rest } : null, legs });
    scene.add(shadow, obj);
  }
  // arrangeStage (called from spawnDancers) gives the spot; a cow gets one only if it hides nobody
}
function clearCows() { cowToken++; for (const c of cows) scene.remove(c.obj, c.shadow); cows = []; }

// ---------- animals ----------
// back: big ones (elephant, camel, tiger, zebu) stand far behind the dancers at the outer edge of the frame, at
// three quarters to the reel; crowd: the dancing chimp takes the edge of the stage like a cow (layout counts it);
// corner: the macaque sits at the bottom corner of the reel in front of everyone. Chosen by celebration theme.
let beasts = [], beastToken = 0;
function clearBeasts() { beastToken++; for (const b of beasts) { scene.remove(b.obj, b.shadow); } beasts = []; }
function pickAnimals(themeName) {
  const all = people.filter((p) => p.kind === 'animal'), fit = (p) => (p.themes || []).includes(themeName);
  const pick = (place) => { const pool = all.filter((p) => p.place === place); const good = pool.filter(fit); return rnd(good.length ? good : pool); };
  const out = [];
  if (Math.random() < 0.85) out.push(pick('back'));
  if (Math.random() < 0.45) out.push(pick(Math.random() < 0.55 ? 'crowd' : 'corner'));
  return out.filter(Boolean);
}
// where the animal is on screen horizontally (NDC): projection of its bounding box
function screenSpanOf(obj, dims) {
  obj.updateMatrixWorld(true);
  let lo = Infinity, hi = -Infinity; const v = new THREE.Vector3();
  for (const x of [-dims.W / 2, dims.W / 2]) for (const y of [0, dims.H]) for (const z of [-dims.L / 2, dims.L / 2]) {
    v.set(x, y, z); obj.localToWorld(v).project(camera); lo = Math.min(lo, v.x); hi = Math.max(hi, v.x);
  }
  return [lo, hi];
}
async function spawnAnimals(list) {
  clearBeasts();
  const token = ++beastToken;
  for (const rec of list) {
    const loaded = peopleCache.get(rec.file) || await loadPerson(rec).catch(() => null);
    if (token !== beastToken || !running) return;
    if (!loaded || !loaded.animal) continue;
    const obj = skeletonClone(loaded.holder), dims = loaded.animal;
    obj.rotation.order = 'YXZ';
    const mixer = loaded.clips.length ? new THREE.AnimationMixer(obj) : null;
    if (mixer) { const a = mixer.clipAction(rnd(loaded.clips)); a.time = Math.random() * a.getClip().duration; a.play(); }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.45 }));
    shadow.rotation.x = -Math.PI / 2; shadow.scale.set(dims.W * 1.4, dims.L * 1.2, 1);
    obj.visible = shadow.visible = false;                      // arrangeStage gives the spot
    scene.add(shadow, obj);
    if (rec.place === 'crowd') {                               // the chimp dances in the crowd and queues with the cows
      cows.push({ obj, shadow, file: rec.file, dims: { L: dims.L, W: dims.W, H: dims.H }, x: 0, z: 0, psi: 0, side: 1, phase: 0, nod: null, legs: [], mixer, beast: true });
      continue;
    }
    beasts.push({ obj, shadow, rec, dims, mixer, phase: Math.random() * 6.28, psi: 0 });
  }
}
// ---------- street: tuk-tuks, scooters with riders, mad dogs ----------
// They drive and run along their own depth lanes, the corridors between the rows that arrangeStage sets, across
// the whole frame, and vanish behind the reel, which acts as a window. Our own Indian models ride the scooters.
let traffic = [], trafficToken = 0;
function clearTraffic() { trafficToken++; for (const v of traffic) scene.remove(v.group, v.shadow); traffic = []; }
// rider pose: bones are aimed in given directions (rider space: +z forward along the road, +y up)
function riderPose(obj) {
  const B = boneMap(obj), dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
  obj.updateMatrixWorld(true);
  const pose = [['Spine', dir(0, 1, 0.12)], ['Spine1', dir(0, 1, 0.18)], ['Spine2', dir(0, 1, 0.12)], ['Neck', dir(0, 1, 0.1)],
    ['LeftUpLeg', dir(0.18, -0.12, 1)], ['RightUpLeg', dir(-0.18, -0.12, 1)], ['LeftLeg', dir(0.04, -1, 0.25)], ['RightLeg', dir(-0.04, -1, 0.25)],
    ['LeftFoot', dir(0, -0.35, 1)], ['RightFoot', dir(0, -0.35, 1)],
    ['LeftArm', dir(0.32, -0.42, 1)], ['RightArm', dir(-0.32, -0.42, 1)], ['LeftForeArm', dir(0.06, -0.2, 1)], ['RightForeArm', dir(-0.06, -0.2, 1)]];
  for (const [n, d] of pose) if (B[n]) aimBone(B[n], d.clone().applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion())));
  obj.updateMatrixWorld(true);
  return B.Hips ? B.Hips.getWorldPosition(new THREE.Vector3()).applyMatrix4(obj.matrixWorld.clone().invert()) : new THREE.Vector3(0, 0.9, 0);
}
async function spawnTraffic(themeName) {
  clearTraffic();
  const token = ++trafficToken;
  const veh = people.filter((p) => p.kind === 'vehicle'), dogs = people.filter((p) => p.kind === 'dog');
  const low = G === GFX.low;
  const plan = [...shuffle(veh.filter((v) => v.type === 'scooter')).slice(0, low ? 1 : 2), ...shuffle(veh.filter((v) => v.type === 'tuktuk')).slice(0, low ? 1 : 2), ...shuffle(dogs).slice(0, 2)];
  for (const rec of plan) {
    const loaded = peopleCache.get(rec.file) || await loadPerson(rec).catch(() => null);
    if (token !== trafficToken || !running) return;
    if (!loaded || !loaded.animal) continue;
    const group = new THREE.Group(), body = skeletonClone(loaded.holder);
    group.add(body);
    let mixer = null;
    if (loaded.clips.length) { mixer = new THREE.AnimationMixer(body); const a = mixer.clipAction(loaded.clips[0]); a.timeScale = rec.type === 'dog' ? 1.25 : 1; a.time = Math.random() * a.getClip().duration; a.play(); }
    // scooter rider: one of the people already loaded (sometimes Modi), now and then two of them
    if (rec.type === 'scooter') {
      const humans = people.filter((p) => (p.kind === 'm' || p.kind === 'f') && peopleCache.has(p.file) && !p.noProps && p.file !== SPIDEY_FILE);
      const riders = humans.length ? [rnd(humans), ...(Math.random() < 0.35 ? [rnd(humans)] : [])] : [];
      riders.forEach((h, i) => {
        const r = skeletonClone(peopleCache.get(h.file).holder);
        if (!h.featured) recolorPerson(r);
        const hips = riderPose(r), seatZ = -0.08 * loaded.animal.L - i * 0.42, seatY = 0.62 * rec.height + 0.04 * i;
        r.position.set(-hips.x, seatY - hips.y, seatZ - hips.z);
        group.add(r);
      });
    }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.4 }));
    shadow.rotation.x = -Math.PI / 2; shadow.scale.set(loaded.animal.L * 1.15, loaded.animal.W * 1.5, 1);
    group.visible = shadow.visible = false;                    // arrangeStage gives the lane
    scene.add(shadow, group);
    const speed = rec.type === 'dog' ? 3.2 + Math.random() * 2 : rec.type === 'scooter' ? 3.5 + Math.random() * 2 : 2.4 + Math.random() * 1.2;
    traffic.push({ group, shadow, mixer, rec, dims: loaded.animal, speed, dir: Math.random() < 0.5 ? 1 : -1, x: 0, z: 0, lane: null, wait: Math.random() * 3, phase: Math.random() * 6.28, bark: 0 });
  }
  if (token === trafficToken) placeTraffic();
}
// Lanes are the middles of the corridors between rows (LANE_GAP, set by arrangeStage). Scooters and tuk-tuks drive
// exactly on their lane, no offsets, because each corridor is sized for their width. In one lane everyone has the same
// direction and speed and the vehicles are half a loop apart, so nobody catches up or drives through oncoming traffic.
let lanes = { dog: -3.3, scooter: -6.2, tuktuk: -8.5 };
const LANE_SPEED = { scooter: 4.4, tuktuk: 3.0 };
let laneDir = { scooter: 1, tuktuk: -1 };
function placeTraffic() {
  laneDir.scooter = Math.random() < 0.5 ? 1 : -1; laneDir.tuktuk = -laneDir.scooter;      // scooters and tuk-tuks go in opposite directions
  const byType = { dog: [], scooter: [], tuktuk: [] };
  for (const v of traffic) (byType[v.rec.type] || byType.dog).push(v);
  for (const [type, list] of Object.entries(byType)) list.forEach((v, k) => {
    v.z = lanes[type];
    const hw = halfWAt(v.z) + 3;                                // three metres past the frame edge on each side
    v.lane = hw;
    if (type === 'dog') { v.x = (Math.random() * 2 - 1) * hw; }
    else {
      v.dir = laneDir[type]; v.speed = LANE_SPEED[type]; v.wait = 0;
      v.x = -hw + ((k + Math.random() * 0.3) / list.length) * 2 * hw;    // evenly around the loop
    }
    v.group.visible = v.shadow.visible = true;
  });
}
function updateTraffic(dt, t) {
  for (const v of traffic) {
    if (!v.group.visible) continue;
    if (v.mixer) v.mixer.update(dt);
    const dog = v.rec.type === 'dog';
    if (v.wait > 0) v.wait -= dt;
    else v.x += v.dir * v.speed * dt;
    if (Math.abs(v.x) > v.lane) {
      if (dog) {                                               // a dog turns at the edge and runs back
        v.dir = -v.dir; v.x = Math.sign(v.x) * v.lane; v.wait = 0.2; v.speed = 3.2 + Math.random() * 2.2;
      } else v.x -= v.dir * 2 * v.lane;                        // a vehicle that left the frame comes back in from the other side, spacing stays the same
    }
    // dogs dash around: they weave in depth inside their corridor and suddenly change direction
    let z = v.z;
    if (dog) { z += Math.sin(t * 2.3 + v.phase) * 0.18; if (Math.random() < dt * 0.25) v.dir = -v.dir; }
    const bob = v.rec.type === 'scooter' ? Math.sin(t * 9 + v.phase) * 0.01 : v.rec.type === 'tuktuk' ? Math.abs(Math.sin(t * 7 + v.phase)) * 0.015 : 0;
    v.group.position.set(v.x, bob, z);
    v.group.rotation.y = v.dir > 0 ? Math.PI / 2 : -Math.PI / 2;     // the model faces +z and drives along x
    v.shadow.position.set(v.x, 0.004, z); v.shadow.rotation.z = 0;
  }
}

// debugging: depth gap between each vehicle (its half-width) and the nearest person or cow (their half-depth)
function trafficGaps() {
  const zs = [...dancers.filter((d) => d.placed).map((d) => ({ z: d.obj.position.z, h: 0.45, who: 'человек' })),
    ...cows.filter((c) => c.placed && !c.beast).map((c) => ({ z: c.z, h: (c.dims.L / 2) * Math.abs(Math.cos(Math.abs(c.psi) - COW_SWAY)) + (c.dims.W / 2) * Math.abs(Math.sin(Math.abs(c.psi) - COW_SWAY)), who: 'корова' }))];
  return traffic.filter((v) => v.rec.type !== 'dog').map((v) => {
    let gap = Infinity, who = '';
    for (const o of zs) { const g = Math.abs(o.z - v.z) - o.h - v.dims.W / 2; if (g < gap) { gap = g; who = o.who; } }
    return { type: v.rec.type, file: v.rec.file, z: +v.z.toFixed(2), halfW: +(v.dims.W / 2).toFixed(2), gap: +gap.toFixed(2), who };
  });
}

function updateBeasts(dt, t) {
  for (const b of beasts) {
    if (b.mixer) b.mixer.update(dt);
    else {                                                     // no animation (macaque): breathes, looks around, hops to the beat
      b.obj.rotation.y = b.psi + Math.sin(t * 0.7 + b.phase) * 0.35;
      b.obj.position.y = Math.abs(Math.sin(t * BEAT_HZ * Math.PI + b.phase)) * 0.03 * (0.5 + beat);
      b.obj.scale.setScalar(1 + 0.015 * Math.sin(t * 2.2 + b.phase));
    }
  }
}
let blobTex = null;
function blobTexture() {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  r.addColorStop(0, 'rgba(0,0,0,0.75)'); r.addColorStop(0.6, 'rgba(0,0,0,0.35)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return (blobTex = new THREE.CanvasTexture(c));
}

// Gods are statues with no skeleton for our dances. They float behind the dancers as idols: they turn slowly,
// sway in the air, and a golden halo behind them pulses with the beat.
let haloTex = null;
function haloTexture() {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  r.addColorStop(0, 'rgba(255,240,180,0.95)'); r.addColorStop(0.35, 'rgba(255,200,80,0.55)');
  r.addColorStop(0.7, 'rgba(255,150,30,0.18)'); r.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,215,90,0.9)'; g.lineWidth = 5; g.beginPath(); g.arc(128, 128, 78, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 24; i++) {                                     // rays
    const a = (i / 24) * Math.PI * 2;
    g.strokeStyle = 'rgba(255,220,120,0.35)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(128 + Math.cos(a) * 84, 128 + Math.sin(a) * 84); g.lineTo(128 + Math.cos(a) * 124, 128 + Math.sin(a) * 124); g.stroke();
  }
  haloTex = new THREE.CanvasTexture(c);
  return haloTex;
}
let gods = [], godToken = 0;
async function spawnGods(n) {
  clearGods();
  const token = ++godToken;          // statues are heavy: a new celebration can start while one is loading
  const pantheon = people.filter((p) => p.kind === 'god');
  if (!pantheon.length) return;
  const picks = [...pantheon].sort(() => Math.random() - 0.5).slice(0, n);
  for (let i = 0; i < picks.length; i++) {
    const rec = picks[i];
    const loaded = peopleCache.get(rec.file) || await loadPerson(rec).catch(() => null);
    if (token !== godToken) return;
    if (!loaded || !running) continue;
    const obj = skeletonClone(loaded.holder);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0),
      new THREE.MeshBasicMaterial({ map: haloTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    obj.visible = halo.visible = false;                        // arrangeStage gives a spot in the upper part of the frame
    scene.add(halo, obj);
    gods.push({ obj, halo, base: 1.5, haloDy: 1.2, dims: loaded.god || { W: 1, D: 0.6, H: 1.9 }, phase: Math.random() * 6.28 });
  }
  arrangeStage({ keep: true });                                // people are placed already, gods take what is left
}
function clearGods() { godToken++; for (const g of gods) { scene.remove(g.obj); scene.remove(g.halo); } gods = []; }

const DANCER_SHADOW_GEO = new THREE.PlaneGeometry(0.85, 0.6), _sh = new THREE.Vector3();
function clearDancers() {
  for (const d of dancers) { scene.remove(d.obj); if (d.shadow) { scene.remove(d.shadow); d.shadow.material.dispose(); } }
  dancers = [];
}

// ---------- the web show ----------
// Spider-Man in front of the crowd shoots webs straight at the screen, where his hand points. The rhythm builds up:
// a single shot, another single after 2 s, a double after 1 s, a triple after another 1 s. The web from the triple
// starts to drip as white goo and the goo caption (#spcap) pops up. The loop repeats while the celebration lasts.
// The strand flies in 3D (from the hand to a point in front of the camera); splats and drips are drawn on a 2D canvas.
const SPIDEY_FILE = 'spidey2.glb';
const SHOW_CYCLE = 12;                                        // s, length of one loop
const SHOW_SHOTS = [[0.8], [2.8], [3.8, 4.1], [4.9, 5.15, 5.4]];
const DRIP_AT = 6.0, CAPTION_AT = 6.6, SCREEN_DIST = 0.9;     // the screen is a plane 0.9 m in front of the camera
const webfx = $('webfx'), wctx = webfx.getContext('2d');
let show = null, splats = [], strands = [];
function startShow(lead) {
  stopShow();
  show = { t0: null, lead, cycle: -1, plan: [], dripped: false, captioned: false };   // the clock starts on the first frame
}
function stopShow() {
  show = null; splats = [];
  for (const st of strands) scene.remove(st.mesh);
  strands = [];
  $('spcap').classList.remove('on');
  wctx.clearRect(0, 0, webfx.width, webfx.height);
}
// where to shoot on this loop: screen points (NDC); the triple fans out from left to right
function planCycle() {
  const r = (a, b) => a + Math.random() * (b - a);
  return SHOW_SHOTS.flatMap((group, g) => group.map((at, j) => ({
    at, group: g, fired: false,
    ndc: g === 3 ? new THREE.Vector2(-0.6 + j * 0.6 + r(-0.12, 0.12), r(0.05, 0.55)) : new THREE.Vector2(r(-0.8, 0.8), r(-0.15, 0.7)),
  })));
}
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _tq = new THREE.Quaternion(), _tq2 = new THREE.Quaternion();
// a point on the glass in front of the camera that the ray to the given screen point passes through
function screenPoint(ndc, out) {
  out.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize().multiplyScalar(SCREEN_DIST).add(camera.position);
  return out;
}
// turn a bone toward a world target with weight w (0: as in the dance, 1: exactly on target)
function aimToward(b, child, target, w) {
  if (!b || !child || w <= 0) return;
  const p = b.getWorldPosition(_t1), d = child.getWorldPosition(_t2).sub(p).normalize();
  const want = target.clone().sub(p).normalize();
  _tq.setFromUnitVectors(d, want);
  _tq2.identity().slerp(_tq, w);
  const world = _tq2.multiply(b.getWorldQuaternion(new THREE.Quaternion()));
  b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
  b.updateMatrixWorld(true);
}
// Signature gesture: middle and ring fingers pressed to the palm, index and little finger straight, palm toward the
// target, wrist bent back. Finger bend axes are computed once in rest pose: axis = finger x palm normal.
// Anatomy gives the palm side: for the left hand normal = finger x (index - little), for the right hand the opposite.
const CURL = { Middle: [1.3, 1.5, 1.1], Ring: [1.25, 1.45, 1.05] };
let curlDbg = 1, sideDbg = null;                   // debugging: 0 means no finger curl; which hand shoots
function handRig(d) {
  if (d.handRig) return d.handRig;
  const B = d.bones || (d.bones = boneMap(d.obj)), out = {}, P = (b) => b.getWorldPosition(new THREE.Vector3());
  d.obj.updateMatrixWorld(true);
  for (const side of ['Left', 'Right']) {
    const hand = B[side + 'Hand'], idx = B[side + 'HandIndex1'], pin = B[side + 'HandPinky1'], mid = B[side + 'HandMiddle1'];
    if (!hand || !idx || !pin || !mid) continue;
    const f = P(mid).sub(P(hand)).normalize(), across = P(idx).sub(P(pin));
    const palm = new THREE.Vector3().crossVectors(f, across).normalize().multiplyScalar(side === 'Left' ? 1 : -1);
    const fingers = [];
    for (const [name, angles] of Object.entries(CURL)) for (let k = 1; k <= 3; k++) {
      const b = B[`${side}Hand${name}${k}`]; if (!b) continue;
      const next = B[`${side}Hand${name}${k + 1}`] || b.children.find((c) => c.isBone);
      const dir = next ? P(next).sub(P(b)).normalize() : f.clone();
      const axisW = new THREE.Vector3().crossVectors(dir, palm).normalize();
      fingers.push({ b, angle: angles[k - 1], axis: axisW.applyQuaternion(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize() });
    }
    // palm in hand space, so its direction is known in any pose
    const hq = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    out[side] = { fingers, palmL: palm.clone().applyQuaternion(hq), fingL: f.clone().applyQuaternion(hq) };
  }
  return (d.handRig = out);
}
function aimArm(d, side, target, w) {
  const B = d.bones || (d.bones = boneMap(d.obj)), H = handRig(d)[side];
  d.obj.updateMatrixWorld(true);
  aimToward(B[side + 'Arm'], B[side + 'ForeArm'], target, w);
  aimToward(B[side + 'ForeArm'], B[side + 'Hand'], target, w);
  const hand = B[side + 'Hand'];
  if (hand && H) {
    // hand: palm toward the target, fingers up (wrist bent back); the finger/palm basis is turned as a whole
    const hw = hand.getWorldQuaternion(new THREE.Quaternion()), hp = hand.getWorldPosition(new THREE.Vector3());
    const f = H.fingL.clone().applyQuaternion(hw), pa = H.palmL.clone().applyQuaternion(hw);
    const pd = target.clone().sub(hp).normalize(), up = new THREE.Vector3(0, 1, 0);
    const fd = up.addScaledVector(pd, -up.dot(pd)).normalize();
    const cur = new THREE.Matrix4().makeBasis(f, pa, new THREE.Vector3().crossVectors(f, pa));
    const want = new THREE.Matrix4().makeBasis(fd, pd, new THREE.Vector3().crossVectors(fd, pd));
    const q = new THREE.Quaternion().setFromRotationMatrix(want.multiply(cur.transpose()));
    const world = new THREE.Quaternion().slerp(q, w).multiply(hw);
    hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
    hand.updateMatrixWorld(true);
    // middle and ring fingers to the palm
    for (const F of H.fingers) F.b.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(F.axis, F.angle * w * curlDbg));
    hand.updateMatrixWorld(true);
  }
}
function handPos(d, side) {
  const B = d.bones || (d.bones = boneMap(d.obj));
  // the web comes from under the wrist on the palm side, where his web shooter is
  const h = B[side + 'Hand'] || d.obj, H = d.handRig && d.handRig[side], p = h.getWorldPosition(new THREE.Vector3());
  if (H) p.addScaledVector(H.palmL.clone().applyQuaternion(h.getWorldQuaternion(new THREE.Quaternion())), 0.03);
  return p;
}
function fireWeb(shot, now) {
  const d = show.lead, side = shot.side;
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.012, 1, 6, 1, true), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  strands.push({ mesh, d, side, ndc: shot.ndc, born: now, shot });
  webSfx('thwip');
}
// Web splat on the screen. Geometry is computed directly in screen coordinates (no canvas rotation), so that while
// melting the nodes and drips move straight down. Nodes are where spokes cross rings; each has a weight, how much it
// sags once the web starts to melt.
function makeSplat(shot, now) {
  const r = (a, b) => a + Math.random() * (b - a), R = r(80, 130) * Math.min(1.4, innerHeight / 800), rot = r(0, 6.28);
  const nS = 11 + Math.floor(Math.random() * 3), rings = [0.16, 0.3, 0.45, 0.6, 0.76, 0.92];
  const spokes = Array.from({ length: nS }, (_, j) => ({ a: rot + (j / nS) * Math.PI * 2 + r(-0.16, 0.16), len: R * r(0.95, 1.25), w: r(0.8, 1.25) }));
  const nodes = rings.map((f) => spokes.map((sp) => {
    const rr = f * R * r(0.88, 1.1);
    return { x: Math.cos(sp.a) * rr, y: Math.sin(sp.a) * rr, drop: r(15, 65) * (0.4 + f), dx: r(-6, 6), f };
  }));
  // drips start at the lower nodes (the lower the node, the more likely it drips)
  const cand = nodes.flat().filter((n) => n.y > -R * 0.2).sort(() => Math.random() - 0.5).slice(0, 5 + Math.floor(Math.random() * 3));
  const drips = cand.map((n) => ({ n, max: R * r(1.3, 4.2), v: r(45, 100), w: r(4.8, 8.5) * Math.min(1.4, innerHeight / 800), delay: r(0, 0.5), ph: r(0, 6.28) }));
  // a couple of stray strands past the edge, splashes from the hit
  const strays = Array.from({ length: 3 }, () => { const a = r(0, 6.28); return { a, from: R * r(0.9, 1.1), to: R * r(1.3, 1.7) }; });
  splats.push({ x: (shot.ndc.x + 1) / 2 * innerWidth, y: (1 - shot.ndc.y) / 2 * innerHeight, R, spokes, nodes, drips, strays,
    born: now, group: shot.group, dripAt: null, blob: [r(0, 6.28), r(0, 6.28)] });
  webSfx('splat');
}
function updateShow(now, t) {
  if (show.t0 === null) show.t0 = now + 0.4;                  // first frame after the scene appears: its shaders are still compiling
  const T = Math.max(0, now - show.t0), cyc = Math.floor(T / SHOW_CYCLE), tc = T - cyc * SHOW_CYCLE;
  if (cyc !== show.cycle) {
    show.cycle = cyc; show.plan = planCycle(); show.dripped = false; show.captioned = false;
    splats = []; $('spcap').classList.remove('on');
  }
  const leadX = show.lead.obj.getWorldPosition(new THREE.Vector3()).project(camera).x;
  let best = null, bw = 0;
  for (const shot of show.plan) {
    shot.side = shot.side || sideDbg || (shot.ndc.x < leadX ? 'Right' : 'Left');   // he faces us, so his right hand is on the left of the screen
    if (!shot.fired && tc >= shot.at) { shot.fired = true; fireWeb(shot, now); }
    const k = tc - shot.at;                                              // the arm rises in advance and stays up after the shot
    const w = k < -0.25 ? 0 : k < 0 ? (k + 0.25) / 0.25 : k < 0.35 ? 1 : k < 0.7 ? 1 - (k - 0.35) / 0.35 : 0;
    if (w > bw) { bw = w; best = shot; }
  }
  if (best) aimArm(show.lead, best.side, screenPoint(best.ndc, new THREE.Vector3()), THREE.MathUtils.smoothstep(bw, 0, 1));
  // strand: from the hand to the glass in 0.16 s, then it fades
  for (const st of strands) {
    const age = now - st.born, from = handPos(st.d, st.side), to = screenPoint(st.ndc, new THREE.Vector3());
    const tip = from.clone().lerp(to, Math.min(1, age / 0.16));
    const len = from.distanceTo(tip);
    st.mesh.position.copy(from).add(tip).multiplyScalar(0.5);
    st.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(from).normalize());
    st.mesh.scale.set(1, Math.max(0.001, len), 1);
    if (age >= 0.16 && !st.hit) { st.hit = true; makeSplat(st.shot, now); }
    st.mesh.material.opacity = age < 0.16 ? 0.95 : Math.max(0, 0.95 - (age - 0.16) / 0.35);
  }
  strands = strands.filter((st) => { if (st.mesh.material.opacity > 0) return true; scene.remove(st.mesh); return false; });
  if (!show.dripped && tc >= DRIP_AT) { show.dripped = true; for (const sp of splats) if (sp.group === 3) sp.dripAt = now; }
  if (!show.captioned && tc >= CAPTION_AT) { show.captioned = true; const c = $('spcap'); c.classList.remove('on'); void c.offsetWidth; c.classList.add('on'); webSfx('splat'); }
  if (tc > SHOW_CYCLE - 1.2) $('spcap').classList.remove('on');
  drawWebfx(now, tc);
}
function drawWebfx(now, tc) {
  const dpr = Math.min(devicePixelRatio, 2);
  if (webfx.width !== Math.round(innerWidth * dpr)) { webfx.width = Math.round(innerWidth * dpr); webfx.height = Math.round(innerHeight * dpr); }
  const g = wctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, innerWidth, innerHeight);
  const endFade = tc > SHOW_CYCLE - 1.5 ? Math.max(0, (SHOW_CYCLE - tc) / 1.5) : 1;
  for (const sp of splats) {
    const age = now - sp.born;
    // melt m: 0 is a fresh web, 1 is goo. The triple shot melts completely; single shots sag a little and fade.
    let m, alpha = endFade;
    if (sp.dripAt) m = Math.min(1, (now - sp.dripAt) / 1.6);
    else { m = Math.min(0.18, Math.max(0, age - 0.5) * 0.12); if (sp.group !== 3) alpha *= Math.max(0, 1 - Math.max(0, age - 2.2) / 0.8); }
    if (alpha > 0) drawSplat(g, sp, age, sp.dripAt ? now - sp.dripAt : 0, m, alpha);
  }
}
// Web and goo are drawn with the same substance: a white mass with a thin dark outline (otherwise it disappears
// on a white feed), a cream body and a highlight. A fresh web is thin strands of this mass. As it melts, the strands
// thicken and sag under their own weight, drops gather at the nodes, and drips run down from the lower nodes.
const ease = (x) => x * x * (3 - 2 * x);
function drawSplat(g, sp, age, tMelt, m, alpha) {
  const k = Math.min(1, age / 0.12);
  const sc = k < 1 ? 0.35 + 0.75 * k : 1 + 0.08 * Math.exp(-(age - 0.12) * 9) * Math.sin((age - 0.12) * 45);   // splat on impact
  const me = ease(m), sag = Math.pow(m, 1.4);
  const P = (n) => ({ x: sp.x + n.x * sc + n.dx * me, y: sp.y + n.y * sc + n.drop * sag });
  const C = { x: sp.x, y: sp.y + 6 * sag };
  const W = 1.8 + 7 * Math.pow(m, 0.85);                                   // strand thickness
  const strands = new Path2D(), thin = new Path2D();
  sp.spokes.forEach((s, j) => {                                           // spokes: from the centre out through the nodes
    let prev = C;
    const path = s.w > 1.1 ? strands : thin;
    path.moveTo(prev.x, prev.y);
    for (const ring of sp.nodes) { const q = P(ring[j]); path.lineTo(q.x, q.y); prev = q; }
    const tip = { x: sp.x + Math.cos(s.a) * s.len * sc, y: sp.y + Math.sin(s.a) * s.len * sc + 30 * sag };
    path.lineTo(tip.x, tip.y);
  });
  for (const ring of sp.nodes) for (let j = 0; j < ring.length; j++) {     // rings: sag toward the centre and down
    const a = P(ring[j]), b = P(ring[(j + 1) % ring.length]);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, cx = C.x + (mx - C.x) * 0.84, cy = C.y + (my - C.y) * 0.84 + 16 * sag;
    thin.moveTo(a.x, a.y); thin.quadraticCurveTo(cx, cy, b.x, b.y);
  }
  for (const s of sp.strays) {
    thin.moveTo(sp.x + Math.cos(s.a) * s.from * sc, sp.y + Math.sin(s.a) * s.from * sc + 20 * sag);
    thin.lineTo(sp.x + Math.cos(s.a) * s.to * sc, sp.y + Math.sin(s.a) * s.to * sc + 40 * sag);
  }
  // drops at the nodes and a blob in the centre grow as it melts
  const blobs = new Path2D();
  const cr = sp.R * (0.07 + 0.3 * me);
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2, rr = cr * (1 + 0.15 * Math.sin(3 * a + sp.blob[0] + tMelt) + 0.08 * Math.sin(5 * a + sp.blob[1]));
    i ? blobs.lineTo(C.x + Math.cos(a) * rr, C.y + Math.sin(a) * rr * 1.08) : blobs.moveTo(C.x + Math.cos(a) * rr, C.y + Math.sin(a) * rr * 1.08);
  }
  blobs.closePath();
  if (m > 0.2) for (const ring of sp.nodes) for (const n of ring) { const q = P(n), br = W * 0.55 * ease((m - 0.2) / 0.8) + W * 0.3; blobs.moveTo(q.x + br, q.y); blobs.arc(q.x, q.y, br, 0, Math.PI * 2); }
  // drips grow from the nodes, speed up and end in a heavy drop; their thickness is uneven
  const drips = new Path2D(), shine = new Path2D();
  if (m > 0.25) for (const d of sp.drips) {
    const td = Math.max(0, tMelt - 0.4 - d.delay); if (!td) continue;
    const o = P(d.n), L = Math.min(d.max, d.v * Math.pow(td, 1.7)), w0 = d.w * (0.6 + 0.4 * me);
    const Wd = (y) => w0 * (0.7 + 0.25 * Math.sin(y * 0.05 + d.ph) + 0.35 * Math.min(1, y / 30));
    const N = Math.max(2, Math.ceil(L / 7));
    drips.moveTo(o.x - w0, o.y);
    for (let i = 0; i <= N; i++) { const y = (i / N) * L; drips.lineTo(o.x - Wd(y), o.y + y); }
    drips.arc(o.x, o.y + L, Wd(L) * 1.45, Math.PI, 0, true);
    for (let i = N; i >= 0; i--) { const y = (i / N) * L; drips.lineTo(o.x + Wd(y), o.y + y); }
    drips.closePath();
    if (L > 12) { shine.moveTo(o.x - w0 * 0.35, o.y + 4); shine.lineTo(o.x - w0 * 0.35, o.y + L * 0.85); }
  }
  g.save();
  g.globalAlpha = alpha;
  g.lineCap = 'round'; g.lineJoin = 'round';
  const body = m < 0.5 ? '#ffffff' : '#f7f6ec';
  // 1) outline
  g.strokeStyle = `rgba(50,50,44,${0.32 + 0.28 * m})`;
  g.lineWidth = W + 2.2; g.stroke(strands);
  g.lineWidth = W * 0.75 + 2; g.stroke(thin);
  g.lineWidth = 2.2; g.stroke(blobs); g.stroke(drips);
  // 2) body; the melted mass gets a soft shadow so it seems to lie on the screen over a white feed
  g.strokeStyle = body; g.fillStyle = body;
  if (m > 0.2) { g.shadowColor = `rgba(0,0,0,${0.3 * m})`; g.shadowBlur = 5; g.shadowOffsetY = 2; }
  g.lineWidth = W; g.stroke(strands);
  g.lineWidth = W * 0.75; g.stroke(thin);
  g.fill(blobs); g.fill(drips);
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
  // 3) highlights, so it reads as wet
  if (m > 0.15) {
    g.globalAlpha = alpha * Math.min(1, (m - 0.15) * 2);
    g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1, W * 0.28);
    g.save(); g.translate(-W * 0.25, -W * 0.25); g.stroke(strands); g.restore();
    g.lineWidth = 1.8; g.stroke(shine);
    g.beginPath(); g.arc(C.x - cr * 0.25, C.y - cr * 0.25, cr * 0.5, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
  }
  g.restore();
}
// shot and splat sounds are synthesized, so no audio files are needed
function webSfx(kind) {
  if (!actx || actx.state !== 'running' || !settings.sound) return;
  const t0 = actx.currentTime, len = kind === 'thwip' ? 0.16 : 0.22;
  const buf = actx.createBuffer(1, Math.ceil(actx.sampleRate * len), actx.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf;
  const f = actx.createBiquadFilter(); f.type = kind === 'thwip' ? 'bandpass' : 'lowpass';
  f.frequency.setValueAtTime(kind === 'thwip' ? 3200 : 900, t0); f.frequency.exponentialRampToValueAtTime(kind === 'thwip' ? 700 : 180, t0 + len);
  const gn = actx.createGain(); gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(0.35 * settings.volume, t0 + 0.01); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  src.connect(f).connect(gn).connect(actx.destination); src.start(t0); src.stop(t0 + len);
}

// Holi powder
const POWDER_N = 700;
let powder = null;
function makePowder() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(POWDER_N * 3), col = new Float32Array(POWDER_N * 3), vel = new Float32Array(POWDER_N * 3);
  const color = new THREE.Color();
  for (let i = 0; i < POWDER_N; i++) resetParticle(i, pos, col, vel, color, true);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 0.16, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .9 });
  const pts = new THREE.Points(geo, mat);
  pts.userData.vel = vel;
  return pts;
}
function resetParticle(i, pos, col, vel, color, initial) {
  const P = PARTICLE[theme.particle] || PARTICLE.powder;
  const down = P.vy[0] < 0;
  pos[i * 3] = (Math.random() - .5) * 9;
  pos[i * 3 + 1] = initial ? Math.random() * 3.4 : (down ? 3.4 : -0.3);
  pos[i * 3 + 2] = (Math.random() - .5) * 4;
  vel[i * 3] = (Math.random() - .5) * P.spread;
  vel[i * 3 + 1] = P.vy[0] + Math.random() * (P.vy[1] - P.vy[0]);
  vel[i * 3 + 2] = (Math.random() - .5) * P.spread * 0.7;
  color.setHex(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
}
function updatePowder(dt) {
  const pos = powder.geometry.attributes.position.array, vel = powder.userData.vel, col = powder.geometry.attributes.color.array;
  const color = new THREE.Color();
  const down = (PARTICLE[theme.particle] || PARTICLE.powder).vy[0] < 0;
  for (let i = 0; i < POWDER_N; i++) {
    pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    if (down) { pos[i * 3] += Math.sin(pos[i * 3 + 1] * 3 + i) * dt * 0.35; }   // petals sway
    if (down ? pos[i * 3 + 1] < -0.4 : pos[i * 3 + 1] > 3.4) resetParticle(i, pos, col, vel, color, false);
  }
  powder.geometry.attributes.position.needsUpdate = true;
}

// ---------- what falls from above ----------
// Emoji used to fall; now these are particles drawn on a 2D canvas above the models. The kind comes from the
// celebration theme or from the popup setting: confetti, marigold and rose petals, gulal (coloured Holi powder),
// Diwali gold sparks, a rain of rupees, the old emoji, or nothing. Over the reel itself the particles are
// semi-transparent and do not hide the video.
const FALL_KINDS = ['confetti', 'petals', 'gulal', 'sparks', 'rupees', 'emoji'];
const fallCv = $('fall'), fctx = fallCv.getContext('2d');
let fallOn = false, fallParts = [], fallAcc = 0, fallLast = 0;
const fallKind = () => {
  const k = settings.fall || 'theme';
  if (k === 'none') return null;
  return FALL_KINDS.includes(k) ? k : theme.fall || 'confetti';
};
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const RUPEE_NOTES = [['#9a8fbf', '#6e6399', '100'], ['#e9c46a', '#b8912f', '200'], ['#b9b8ae', '#85847a', '500'], ['#d9779f', '#a8456d', '2000']];
function spawnFall(kind, initial) {
  const r = (a, b) => a + Math.random() * (b - a), W = innerWidth, H = innerHeight, k = Math.min(1.6, H / 800);
  const p = { kind, x: r(-20, W + 20), y: initial ? r(-H * 0.2, H) : r(-60, -10), rot: r(0, 6.28), vr: r(-2.5, 2.5), flip: r(0, 6.28), vf: r(3, 8),
    ph: r(0, 6.28), sway: r(15, 45) * k, age: 0 };
  const pal = theme.palette.map(hex);
  if (kind === 'confetti') Object.assign(p, { vy: r(70, 150) * k, w: r(9, 14) * k, h: r(15, 24) * k, color: rnd(pal), round: Math.random() < 0.25 });
  if (kind === 'petals') Object.assign(p, { vy: r(35, 80) * k, w: r(13, 20) * k, h: r(20, 30) * k, vf: r(1.5, 4),
    color: rnd(['#ff8c00', '#ffa31a', '#ffb300', '#ff7a00', '#e8132e', '#ff4d6d', '#fff3e0']) });
  if (kind === 'gulal') Object.assign(p, { x: Math.random() < 0.5 ? r(-40, W * 0.3) : r(W * 0.7, W + 40), y: initial ? r(H * 0.2, H) : H + r(10, 60),
    vy: -r(40, 90) * k, vx: r(-25, 25) * k, R: r(30, 70) * k, grow: r(20, 45) * k, life: r(3.5, 6),
    color: rnd(['#ff2d95', '#22c55e', '#facc15', '#3b82f6', '#a855f7', '#fb923c', '#ef4444']) });
  if (kind === 'sparks') Object.assign(p, { vy: r(80, 200) * k, vx: r(-30, 30) * k, R: r(2, 3.6) * k, life: r(1.8, 3.5), px: null, py: null,
    color: rnd(['#fff4b0', '#ffd24a', '#ffb000', '#ffe9a8']) });
  if (kind === 'rupees') Object.assign(p, { vy: r(60, 120) * k, w: r(46, 60) * k, note: rnd(RUPEE_NOTES), vf: r(2, 5), vr: r(-1.2, 1.2) });
  if (kind === 'emoji') Object.assign(p, { vy: r(90, 180) * k, size: r(22, 50) * k, ch: rnd(theme.emoji), vf: 0 });
  fallParts.push(p);
}
function startRain() {
  stopRain();
  fallOn = true; fallLast = 0;
  const kind = fallKind();
  if (kind) for (let i = 0; i < 25; i++) spawnFall(kind, true);        // start with a few already in frame instead of an empty sky
}
function stopRain() { fallOn = false; fallParts = []; fctx.clearRect(0, 0, fallCv.width, fallCv.height); }
let fallDrawn = 0;
function updateFall(now) {
  if (fallLast && now - fallDrawn < 30) return;                     // the particle layer runs at 30 fps, which is enough for the eye
  fallDrawn = now;
  const dpr = Math.min(devicePixelRatio, G.pr, 1.5);
  if (fallCv.width !== Math.round(innerWidth * dpr) || fallCv.height !== Math.round(innerHeight * dpr)) {
    fallCv.width = Math.round(innerWidth * dpr); fallCv.height = Math.round(innerHeight * dpr);
  }
  const dt = fallLast ? Math.min(0.12, (now - fallLast) / 1000) : 0; fallLast = now;
  const kind = fallKind(), g = fctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, innerWidth, innerHeight);
  if (!fallOn) return;
  // how many per second: depends on the kind, the intensity and the graphics level
  const RATE = { confetti: 28, petals: 16, gulal: 3, sparks: 30, rupees: 6, emoji: 7 };
  const cap = G === GFX.low ? 70 : G === GFX.medium ? 130 : 200;
  if (kind) { fallAcc += dt * RATE[kind] * settings.fx; while (fallAcc >= 1) { fallAcc--; if (fallParts.length < cap) spawnFall(kind, false); } }
  const R = reelRect, H = innerHeight;
  fallParts = fallParts.filter((p) => {
    p.age += dt;
    p.flip += p.vf * dt; p.rot += p.vr * dt;
    if (p.kind === 'gulal') { p.x += p.vx * dt; p.y += p.vy * dt; p.R += p.grow * dt; }
    else if (p.kind === 'sparks') { p.px = p.x; p.py = p.y; p.vy += 60 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    else { p.y += p.vy * dt * (0.85 + 0.15 * Math.sin(p.flip)); p.x += Math.sin(p.ph + p.age * 1.7) * p.sway * dt; }
    if (p.y > H + 60 || (p.life && p.age > p.life) || p.y < -200) return false;
    const overReel = R && p.x > R.x && p.x < R.x + R.w && p.y > R.y && p.y < R.y + R.h;
    g.globalAlpha = overReel ? 0.4 : 1;
    drawFall(g, p);
    return true;
  });
  g.globalAlpha = 1;
}
// Particle sprites are drawn once and then only copied. Drawing gradients, banknote text and spark glow over the
// whole screen every frame is expensive; with software rendering it even stopped video decoding.
const spriteCache = new Map();
function sprite(key, w, h, paint) {
  let c = spriteCache.get(key);
  if (!c) {
    c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
    paint(c.getContext('2d'), c.width, c.height);
    spriteCache.set(key, c);
  }
  return c;
}
const shade = (col, k) => { const c = new THREE.Color(col).multiplyScalar(k); return '#' + c.getHexString(); };
function fallSprite(p) {
  switch (p.kind) {
    case 'confetti': return p.round
      ? sprite('cr' + p.color, 32, 32, (g, w) => { g.fillStyle = p.color; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 1, 0, Math.PI * 2); g.fill(); })
      : sprite('c' + p.color, 20, 32, (g, w, h) => {
        g.fillStyle = p.color; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, 0, w * 0.35, h);                    // highlight on the paper
      });
    case 'petals': return sprite('p' + p.color, 40, 60, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, p.color); grd.addColorStop(1, shade(p.color, 0.55));
      g.fillStyle = grd; g.beginPath(); g.moveTo(w / 2, 1);
      g.bezierCurveTo(w, h * 0.15, w * 0.9, h * 0.85, w / 2, h - 1); g.bezierCurveTo(w * 0.1, h * 0.85, 0, h * 0.15, w / 2, 1); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(w / 2, 6); g.lineTo(w / 2, h - 8); g.stroke();   // vein
    });
    case 'gulal': return sprite('g' + p.color, 128, 128, (g, w) => {
      const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      grd.addColorStop(0, p.color); grd.addColorStop(0.45, p.color + 'aa'); grd.addColorStop(1, p.color + '00');
      g.fillStyle = grd; g.fillRect(0, 0, w, w);
    });
    case 'sparks': return sprite('s', 48, 48, (g, w) => {
      const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      grd.addColorStop(0, '#fffbe6'); grd.addColorStop(0.18, '#ffd24a'); grd.addColorStop(0.45, 'rgba(255,140,0,0.55)'); grd.addColorStop(1, 'rgba(255,100,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, w);
    });
    case 'rupees': { const [bg, dark, val] = p.note; return sprite('r' + val, 120, 56, (g, w, h) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.strokeStyle = dark; g.lineWidth = 2.5; g.strokeRect(4, 4, w - 8, h - 8);
      g.globalAlpha = 0.35; g.fillStyle = dark; g.beginPath(); g.arc(w * 0.22, h / 2, h * 0.3, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      g.fillStyle = dark; g.font = `700 ${Math.round(h * 0.5)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('₹' + val, w * 0.6, h / 2 + 1);
    }); }
    case 'emoji': return sprite('e' + p.ch, 64, 64, (g, w) => { g.font = '52px serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(p.ch, w / 2, w / 2 + 3); });
  }
  return null;
}
function drawFall(g, p) {
  const img = fallSprite(p); if (!img) return;
  g.save();
  g.translate(p.x, p.y);
  if (p.kind === 'confetti') {
    g.rotate(p.rot); const f = Math.cos(p.flip);                      // flips in the air, now face-on, now edge-on
    g.scale(1, Math.abs(f) < 0.08 ? 0.08 : f);
    const w = p.round ? p.w * 1.2 : p.w, h = p.round ? p.w * 1.2 : p.h;
    if (f < 0) g.globalAlpha *= 0.8;                                   // the back side is a little paler
    g.drawImage(img, -w / 2, -h / 2, w, h);
  } else if (p.kind === 'petals') {
    g.rotate(p.rot); g.scale(Math.cos(p.flip) * 0.4 + 0.6, 1);
    g.drawImage(img, -p.w / 2, -p.h / 2, p.w, p.h);
  } else if (p.kind === 'gulal') {
    g.globalAlpha *= Math.max(0, 1 - p.age / p.life) * 0.6;
    g.drawImage(img, -p.R, -p.R, p.R * 2, p.R * 2);
  } else if (p.kind === 'sparks') {
    g.restore(); g.save();
    g.globalAlpha *= Math.max(0, 1 - p.age / p.life) * (0.7 + 0.3 * Math.sin(p.age * 30 + p.ph));   // they twinkle
    if (p.px !== null) { g.strokeStyle = '#ffae00'; g.lineWidth = p.R * 0.8; g.lineCap = 'round'; g.beginPath(); g.moveTo(p.px, p.py - (p.y - p.py) * 4); g.lineTo(p.x, p.y); g.stroke(); }
    const S = p.R * 5; g.drawImage(img, p.x - S / 2, p.y - S / 2, S, S);
  } else if (p.kind === 'rupees') {
    const w = p.w, h = w * 0.47, f = Math.cos(p.flip);
    g.rotate(p.rot); g.scale(1, f * 0.7 + (f >= 0 ? 0.3 : -0.3));
    g.drawImage(img, -w / 2, -h / 2, w, h);
  } else if (p.kind === 'emoji') {
    g.rotate(p.rot * 0.3); g.drawImage(img, -p.size / 2, -p.size / 2, p.size, p.size);
  }
  g.restore();
}

// ---------- firework: a burst of sparks from one point (Diwali theme) ----------
let fireworksTimer = null;
function boomAt(x, y) {
  const n = Math.round(26 * settings.fx);
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.width = d.style.height = 4 + Math.random() * 4 + 'px';
    d.style.borderRadius = '50%';
    d.style.left = x + 'px'; d.style.top = y + 'px';
    d.style.background = ['#ffd700', '#fff3b0', '#ff8c00', '#fff'][i % 4];
    d.style.boxShadow = '0 0 10px #ffb300';
    const a = (i / n) * Math.PI * 2, r = 70 + Math.random() * 130 * settings.fx;
    d.style.setProperty('--dx', Math.cos(a) * r + 'px');
    d.style.setProperty('--dy', Math.sin(a) * r + 90 + 'px');
    d.style.setProperty('--rot', '0deg');
    d.style.animationDuration = 0.9 + Math.random() * 0.7 + 's';
    d.addEventListener('animationend', () => d.remove());
    $('fire').appendChild(d);
  }
}
function startFireworks() {
  stopFireworks();
  fireworksTimer = setInterval(() => {
    const x = innerWidth * (0.1 + Math.random() * 0.8), y = innerHeight * (0.08 + Math.random() * 0.35);
    boomAt(x, y);
  }, 900);
}
function stopFireworks() { clearInterval(fireworksTimer); fireworksTimer = null; }

// ---------- fire sparks from under the reel, confetti, a heart on like ----------
let flameTimer = null;
function startFlames() {
  stopFlames();
  flameTimer = setInterval(() => {
    if (!reelRect) return;
    const n = Math.round(2 * settings.fx);
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'flame';                                   // an ember spark instead of the fire emoji
      const side = Math.random();
      let x, y;
      if (side < 0.6) { x = reelRect.x + Math.random() * reelRect.w; y = reelRect.y + reelRect.h - 10; }          // bottom
      else if (side < 0.8) { x = reelRect.x - 14; y = reelRect.y + Math.random() * reelRect.h; }                   // left edge
      else { x = reelRect.x + reelRect.w - 14; y = reelRect.y + Math.random() * reelRect.h; }                       // right edge
      d.style.left = x + 'px'; d.style.top = y + 'px';
      d.style.width = d.style.height = 4 + Math.random() * 7 * settings.fx + 'px';
      d.style.setProperty('--dy', -(120 + Math.random() * 220 * settings.fx) + 'px');
      d.style.setProperty('--rot', (Math.random() * 40 - 20) + 'deg');
      d.style.animationDuration = 1.2 + Math.random() * 1.2 + 's';
      d.addEventListener('animationend', () => d.remove());
      $('fire').appendChild(d);
    }
  }, 160);
}
function stopFlames() { clearInterval(flameTimer); flameTimer = null; $('fire').replaceChildren(); }

function confettiBurst() {
  if (!reelRect) return;
  const colors = theme.palette.map((c) => '#' + c.toString(16).padStart(6, '0'));
  const n = Math.round(90 * settings.fx);
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    const fromLeft = i % 2 === 0;
    d.style.left = (fromLeft ? reelRect.x : reelRect.x + reelRect.w) + 'px';
    d.style.top = reelRect.y + 'px';
    d.style.background = colors[i % colors.length];
    const ang = (fromLeft ? Math.PI + 0.2 : -0.2) + (Math.random() - 0.5) * 1.4; // fanning out and up
    const dist = 200 + Math.random() * 400 * settings.fx;
    d.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    d.style.setProperty('--dy', (Math.sin(ang) * dist * 0.6 + 300 + Math.random() * 300) + 'px');
    d.style.setProperty('--rot', Math.random() * 1080 - 540 + 'deg');
    d.style.animationDuration = 1.3 + Math.random() * 1.2 + 's';
    d.addEventListener('animationend', () => d.remove());
    $('fire').appendChild(d);
  }
}

function heartPop() {
  const h = $('heart');
  if (reelRect) { h.style.left = reelRect.x + reelRect.w / 2 + 'px'; h.style.top = reelRect.y + reelRect.h / 2 + 'px'; }
  h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop');
  for (let i = 0; i < 14; i++) {
    const m = document.createElement('div');
    m.className = 'mini-heart'; m.textContent = ['❤️', '🧡', '💛', '💚', '🤍'][i % 5];
    m.style.left = h.style.left || '50%'; m.style.top = h.style.top || '50%';
    const a = Math.random() * Math.PI * 2, r = 80 + Math.random() * 160;
    m.style.setProperty('--dx', Math.cos(a) * r + 'px'); m.style.setProperty('--dy', Math.sin(a) * r - 60 + 'px');
    m.addEventListener('animationend', () => m.remove());
    document.body.appendChild(m);
  }
}

// ---------- sound hit on trigger ----------
let sfx = [];
const sfxLoaded = fetch(chrome.runtime.getURL('assets/sfx/sfx.json')).then((r) => r.json()).then((s) => { sfx = s; }).catch(() => {});
async function playHit() {
  await sfxLoaded;
  if (!sfx.length || !settings.sound) return;
  const a = new Audio(chrome.runtime.getURL('assets/sfx/' + sfx[Math.floor(Math.random() * sfx.length)].file));
  a.volume = Math.min(1, settings.volume * 1.2);
  a.play().catch(() => {});
}

// ---------- music ----------
const audio = new Audio();
let lastSong = null, fadeTimer = null;
function pickSong() {
  if (!songs.length) return null;
  const want = [theme.name, ...theme.tags];
  const tagged = songs.filter((s) => s !== lastSong && want.some((t) => (s.tags || []).includes(t)));
  const pool = tagged.length ? tagged : songs.filter((s) => s !== lastSong);
  return pool[Math.floor(Math.random() * pool.length)] || songs[0];
}
async function playSong() {
  await songsLoaded;
  if (!running || !settings.sound) return;
  const song = pickSong();
  if (!song) return;
  lastSong = song;
  clearInterval(fadeTimer);
  audio.src = chrome.runtime.getURL('assets/songs/' + song.file);
  audio.volume = settings.volume;
  $('song').textContent = '♪ ' + song.title;
  try {
    await audio.play();
  } catch (e) {
    // autoplay is not allowed inside the iframe, so the parent page plays the music
    window.parent.postMessage({ type: 'IINDU_AUDIO_BLOCKED', src: audio.src, reason: String(e?.message || e) }, parentOrigin);
  }
}
audio.addEventListener('ended', () => { if (running && settings.sound) playSong(); });
function stopSong() {
  clearInterval(fadeTimer);
  if (audio.paused) return;
  const step = audio.volume / 8;
  fadeTimer = setInterval(() => {
    audio.volume = Math.max(0, audio.volume - step);
    if (audio.volume <= 0.001) { clearInterval(fadeTimer); audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }, 50);
}

// ---------- start / stop ----------
let running = false, raf = 0;
const clock = new THREE.Clock();

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio, G.pr));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', () => { resize(); if (running) { matchCamera(curBackdrop); arrangeStage(); } });

let lastRender = 0;
function animate() {
  if (!running) return;
  raf = requestAnimationFrame(animate);
  const now = performance.now();
  if (G.fps && now - lastRender < 1000 / G.fps - 3) return;       // economy mode: 30 fps
  lastRender = now;
  governor(now);
  const dt = frozenT === null ? Math.min(clock.getDelta(), 0.05) : 0;
  const t = frozenT === null ? clock.elapsedTime : frozenT;
  updateBeat(t);
  for (const d of dancers) { d.mixer.update(dt); d.obj.scale.setScalar(d.base * (1 + 0.07 * beat)); if (d.mannequin) poseMannequin(d.obj); }
  updateBeasts(dt, t);
  updateTraffic(dt, t);
  for (const d of dancers) if (d.shadow && d.hips) { d.hips.getWorldPosition(_sh); d.shadow.position.set(_sh.x, 0.005, _sh.z); }
  if (show) updateShow(frozenT === null ? now / 1000 : frozenT, t);
  updateFall(frozenT === null ? now : frozenT * 1000);     // after the dance pose: the lead's arm turns toward the target
  for (const g of gods) {
    g.obj.rotation.y = Math.sin(t * 0.5 + g.phase) * 0.45;   // they sway facing the viewer: many statues are flat and invisible edge-on
    g.obj.position.y = g.base + Math.sin(t * 1.3 + g.phase) * 0.08;            // they float
    g.halo.position.y = g.obj.position.y + g.haloDy;
    g.halo.material.opacity = 0.75 + 0.25 * beat;                              // the halo breathes to the beat
    g.halo.rotation.z += dt * 0.25;
  }
  for (const c of cows) {
    if (c.mixer) { c.mixer.update(dt); continue; }             // the dancing chimp has its own animation
    if (cowFreeze) break;
    const ph = t * BEAT_HZ + c.phase, f = ph % 1;
    const sway = Math.sin(ph * Math.PI);                                   // there and back over two beats
    c.obj.rotation.y = c.psi + sway * COW_SWAY;
    c.obj.rotation.z = sway * 0.07;                                         // roll follows the sway
    c.obj.rotation.x = Math.sin(ph * Math.PI * 2) * 0.04;                   // the body dips on every beat
    c.obj.position.y = 4 * f * (1 - f) * 0.06 * (0.6 + beat);               // a hop on every beat
    c.shadow.rotation.y = c.obj.rotation.y;
    c.shadow.material.opacity = 0.55 - c.obj.position.y * 2;                // the shadow fades during the jump
    if (c.nod) c.nod.bone.quaternion.setFromAxisAngle(c.nod.axis, 0.3 * Math.sin(ph * Math.PI * 2)).multiply(c.nod.rest);
    // the legs trot: on each beat a diagonal pair lifts (left front + right back, then the other pair)
    for (const L of c.legs) {
      const pair = L.front === (L.side === 'L') ? 0 : 1, fp = (ph + pair) % 2, lift = fp < 1 ? Math.sin(fp * Math.PI) : 0;
      L.bones[0].quaternion.setFromAxisAngle(L.axis[0], -0.32 * lift).multiply(L.rest[0]);                 // thigh forward
      L.bones[1].quaternion.setFromAxisAngle(L.axis[1], (L.front ? 0.75 : -0.4) * lift).multiply(L.rest[1]);   // knee bends
    }
  }
  updatePowder(dt);
  powder.material.size = 0.16 * (1 + 0.7 * beat);
  $('caption').style.transform = `scale(${1 + 0.06 * beat})`;
  $('flash').style.opacity = String(0.22 * beat * settings.fx);
  spots.forEach((l) => {
    const a = t * 1.3 + l.userData.phase;
    l.position.set(Math.cos(a) * 3, 2.2 + Math.sin(t * 2 + l.userData.phase) * 0.6, Math.sin(a) * 2 + 1);
  });
  if (camOverride) { camera.position.set(...camOverride.pos); camera.lookAt(...camOverride.target); }
  else { camera.position.set(Math.sin(t * 0.7) * CAM_SWAY, camY, 4.4); camera.lookAt(0, lookY, 0); }
  // the fire frame goes first, as a background: dancers, cows and gods are drawn over it, not the other way round
  renderer.autoClear = false;
  renderer.clear();
  // the city backdrop goes before everything; it fades in when it changes
  const bo = bgMat.uniforms.uOpacity;
  bo.value += (bgTarget - bo.value) * Math.min(1, dt * 4);
  if (bgMat.uniforms.uTex.value && bo.value > 0.01) {
    const pr = renderer.getPixelRatio();
    bgMat.uniforms.uRes.value.set(innerWidth * pr, innerHeight * pr); bgMat.uniforms.uPR.value = pr; bgMat.uniforms.uTime.value = t;
    bgMat.uniforms.uShift.value = camera.position.x * 0.012;
    if (reelRect) { bgMat.uniforms.uRect.value.set(reelRect.x, reelRect.y, reelRect.w, reelRect.h); bgMat.uniforms.uHasRect.value = 1; } else bgMat.uniforms.uHasRect.value = 0;
    renderer.render(bgScene, fireCam);
  }
  if (reelRect) {
    const pr = renderer.getPixelRatio();
    fireMat.uniforms.uTime.value = t; fireMat.uniforms.uPR.value = pr; fireMat.uniforms.uBeat.value = beat; fireMat.uniforms.uFx.value = settings.fx;
    fireMat.uniforms.uRes.value.set(innerWidth * pr, innerHeight * pr);
    fireMat.uniforms.uRect.value.set(reelRect.x, reelRect.y, reelRect.w, reelRect.h);
    renderer.render(fireScene, fireCam);
  }
  renderer.clearDepth();
  // the reel is a window: its rectangle is written to the depth buffer as the near plane, so nothing from the scene
  // (people, vehicles, dogs, web strands) is drawn over the video; everything passes behind it
  if (reelRect) {
    occluder.position.set(((reelRect.x + reelRect.w / 2) / innerWidth) * 2 - 1, 1 - ((reelRect.y + reelRect.h / 2) / innerHeight) * 2, -0.0005);
    occluder.scale.set((reelRect.w / innerWidth) * 2, (reelRect.h / innerHeight) * 2, 1);
    renderer.render(occScene, fireCam);
  }
  renderer.render(scene, camera);
  renderer.autoClear = true;
}

function applyTheme() {
  const next = pickTheme();
  const changed = next.name !== theme.name;
  theme = next;
  PALETTE = theme.palette;
  document.documentElement.style.setProperty('--hue', theme.hue);
  document.documentElement.style.setProperty('--hue2', theme.palette.length > 3 ? '#' + theme.palette[3].toString(16).padStart(6, '0') : '#138808');
  const [c1, c2, c3] = theme.fire;
  fireMat.uniforms.uC1.value.setRGB(...c1); fireMat.uniforms.uC2.value.setRGB(...c2); fireMat.uniforms.uC3.value.setRGB(...c3);
  if (changed && powder) {                                   // recolour and restart the particles for the new theme
    const g = powder.geometry, color = new THREE.Color();
    for (let i = 0; i < POWDER_N; i++) resetParticle(i, g.attributes.position.array, g.attributes.color.array, powder.userData.vel, color, true);
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }
  if (theme.fireworks) startFireworks(); else stopFireworks();
  return changed;
}

let celebrationId = 0;
async function start({ id = 0, score, rect }) {
  if (running && id && id === celebrationId) return;          // same celebration, nothing to do
  celebrationId = id;
  const restart = running;                                    // already celebrating: this is the next reel, not the first one
  applyTheme();
  running = true;
  reelRect = rect || null;
  $('flash').classList.remove('on'); void $('flash').offsetWidth; $('flash').classList.add('on');
  setTimeout(() => $('flash').classList.remove('on'), 900);
  $('caption').classList.remove('on'); void $('caption').offsetWidth; $('caption').classList.add('on');
  $('conf').textContent = `ИИндус уверен на ${Math.round(score * 100)}%`;
  setRect(rect);
  confettiBurst();
  startFlames();
  playHit();
  ensureAnalyser();
  startRain();
  // music is not restarted on every reel: the theme is random, so the track would be cut every 15 seconds.
  // A new track starts when the celebration starts again or the previous track ends, and it matches the current theme.
  if (settings.sound && (!restart || audio.paused)) { $('song').textContent = ''; playSong(); }
  try {
    await Promise.all([loadAssets(), danceMetaLoaded, peopleLoaded, backdropsLoaded]);
    if (!running) return;
    // cast for the theme: load the themed models but wait at most 2.5 s; the late ones appear on the next reel
    const plan = castFor(theme.name);
    const loading = Promise.all(plan.filter((r) => !peopleCache.has(r.file)).map((r) => loadPerson(r).catch(() => null)));
    await Promise.race([loading, new Promise((ok) => setTimeout(ok, peopleCache.size >= 9 && !theme.show ? 2500 : 60000))]);
    if (!running) return;
    if (!powder) { powder = makePowder(); scene.add(powder); }
    powder.geometry.setDrawRange(0, G.particles);
    gfxCheckAt = performance.now() + 2500; lastFrameAt = 0;
    resize();
    if (settings.backdrop !== false) backdropOn(theme.name); else backdropOff();
    // the web show: Spider-Man leads, no cows (there is no room for them in front of the crowd)
    const lead = theme.show === 'spidey' ? people.find((p) => p.file === SPIDEY_FILE && peopleCache.has(p.file)) : null;
    if (!lead) stopShow();
    // cows first: they take the edges of the stage and the dancers line up in the space left
    if (settings.cows && !lead) await spawnCows(Math.random() < 0.5 ? 1 : 2); else clearCows();
    if (!running) return;
    // animals: big ones far in the background, the chimp at the edge of the stage (before the dancers, so the layout counts it)
    if (settings.animals !== false) await spawnAnimals(pickAnimals(theme.name).filter((r) => !lead || r.place !== 'crowd')); else clearBeasts();
    if (!running) return;
    spawnDancers(Math.max(MIN_PEOPLE, Math.min(G.maxDancers, settings.dancers | 0)), lead ? { formation: rnd(['два_ряда', 'шеренга', 'полукруг']), sync: 'канон' } : null, { lead });
    evictPeople(new Set(dancers.map((d) => d.file)));
    if (lead) startShow(dancers.find((d) => d.lead));
    if (settings.traffic !== false) spawnTraffic(theme.name); else clearTraffic();
    if (settings.gods !== false && G.gods) spawnGods(Math.min(G.gods, Math.random() < 0.6 ? 1 : 2));
    canvas.classList.remove('hidden');
    if (!restart) { clock.start(); animate(); }
  } catch (e) {
    console.error('[ИИндус] не удалось загрузить модельки:', e);
  }
}
function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(raf);
  stopShow();
  clearBeasts();
  clearTraffic();
  backdropOff();
  clearDancers();
  clearCows();
  clearGods();
  canvas.classList.add('hidden');
  $('caption').classList.remove('on'); $('caption').style.transform = '';
  $('frame').classList.remove('on');
  $('flash').style.opacity = '0';
  stopRain();
  stopFlames();
  stopFireworks();
  stopSong();
  celebrationId = 0;
}
function setRect(rect) {
  if (!rect) return;
  reelRect = rect;
  const f = $('frame');
  Object.assign(f.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
  f.classList.add('on');
}

// live confidence indicator (real time)
let meterTimer = null;
let lastParts = null;
function showScore({ score, threshold, top, parts, running: fx }) {
  lastParts = parts || lastParts;
  const m = $('meter');
  const pct = Math.round(score * 100);
  $('mPct').textContent = pct + '%';
  $('mFill').style.width = pct + '%';
  $('mThr').style.left = Math.round(threshold * 100) + '%';
  $('mTop').textContent = parts ? `сцена ${Math.round(parts.scene * 100)}% · лицо ${Math.round(parts.face * 100)}% (${parts.guess})` : (top?.length ? top[0].label : '');
  m.classList.add('on');
  m.classList.toggle('hot', score >= threshold);
  if (running) $('conf').textContent = `ИИндус уверен на ${pct}%`;
  clearTimeout(meterTimer);
  meterTimer = setTimeout(() => m.classList.remove('on'), 3000);
}

let hudTimer = null;
function showHud(text, kind) {
  const h = $('hud');
  h.textContent = text;
  h.className = 'on ' + (kind || '');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => h.classList.remove('on'), kind === 'info' ? 2500 : 4000);
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent || !ev.data?.type) return;
  const m = ev.data;
  switch (m.type) {
    case 'IINDU_SETTINGS': {
      const prevFall = settings.fall;
      settings = { ...settings, ...m.settings };
      setGraphics(settings.graphics);
      if (running && settings.fall !== prevFall) startRain();         // the falling particles setting changed: show it right away
      }
      audio.volume = settings.volume;
      if (running && !settings.sound) stopSong();
      break;
    case 'IINDU_START':
      if (m.settings) settings = { ...settings, ...m.settings };
      setGraphics(settings.graphics);
      start(m);
      break;
    case 'IINDU_RECT': setRect(m.rect); break;
    case 'IINDU_STOP': stop(); break;
    case 'IINDU_HUD': showHud(m.text, m.kind); break;
    case 'IINDU_LIKE': heartPop(); break;
    case 'IINDU_SCORE': showScore(m); break;
  }
});

// for debugging and tests
Object.defineProperty(window, '__iindu', { value: { audio, get running() { return running; }, get dancers() { return dancers.length; }, get theme() { return theme.name; }, get celebration() { return celebrationId; }, get rect() { return reelRect; }, get lastParts() { return lastParts; },
  get who() { return dancers.map((d) => d.who); },
  get cows() { return cows.length; },
  cowPose(x, psi, freeze) { cowFreeze = !!freeze; cows.forEach((c, i) => { c.x = x + i * 2.6; c.psi = psi; c.obj.position.x = c.x; c.shadow.position.x = c.x; c.obj.rotation.set(0, psi, 0); }); return cows.length; },
  get chore() { return chore; },
  spawnGods(n, file) { return (async () => { if (file) { const r = people.find((p) => p.file === file); clearGods(); if (r) { const keep = people; people = [r]; await spawnGods(1); people = keep; } } else await spawnGods(n || 2); return gods.length; })(); },
  spawnChore(formation, sync, n) { spawnDancers(n || settings.dancers, { formation, sync }); return chore; },
  spawnCows(n, file) { forcedPerson = file || null; return spawnCows(n || 2).then(() => { forcedPerson = null; return cows.map((c) => c.file); }); },
  spawnPerson(file, n, first = 0) { forcedPerson = file; return (async () => { const rec = people.find((p) => p.file === file); if (!rec) return 'нет такой';
    await loadPerson(rec); clearDancers(); const loaded = peopleCache.get(file);
    for (let i = 0; i < (n || 3); i++) {
      const obj = skeletonClone(loaded.holder);
      obj.position.set((i - ((n || 3) - 1) / 2) * 1.05, 0, 0); obj.rotation.y = 0;
      const mixer = new THREE.AnimationMixer(obj);
      const src = assets[rec.kind === 'f' ? 'f' : 'm'];
      const ci = (first + i) % src.clips.length;
      const clip = bakeRetarget(rec, rec.kind === 'f' ? 'f' : 'm', ci) || rotationOnly(src.clips[ci]);
      const a = mixer.clipAction(clip); a.time = clip.duration * (0.2 + 0.3 * i); a.play();
      scene.add(obj); dancers.push({ obj, mixer, who: file, base: 1 });
    }
    forcedPerson = null; return dancers.map((d) => d.who); })(); },
  // fitting: one model in several looks, pose frozen at frame t, close-up camera on the upper body
  lookTest(file, looks, t = 0.3, yaw = 0) { return (async () => {
    const rec = people.find((p) => p.file === file); if (!rec) return 'нет такой';
    await Promise.all([loadAssets(), loadPerson(rec)]); clearDancers(); clearCows(); clearGods();
    const kind = rec.kind === 'f' ? 'f' : 'm', loaded = peopleCache.get(file), out = [];
    looks.forEach((name, i) => {
      const obj = skeletonClone(loaded.holder);
      obj.position.set((i - (looks.length - 1) / 2) * 0.62, 0, 0); obj.rotation.y = yaw;
      // props are attached in rest pose, as in real use, and only then the dance frame is applied
      const one = { тюрбан: (o) => turban(o, 0xff9933), фуражка: (o) => { cap(o, 0x3b4a2f); epaulettes(o); }, венок: flowerCrown,
        очки: (o) => glasses(o), дхол: dhol, лента: (o) => sash(o, 0xff2d55), гирлянда: garland }[name];
      if (one) { const rig = propRig(obj, file); one(rig); rig.finish(); }
      const mixer = new THREE.AnimationMixer(obj), clip = bakeRetarget(rec, kind, 0);
      const a = mixer.clipAction(clip); a.play(); mixer.setTime(t); a.timeScale = 0;
      scene.add(obj); dancers.push({ obj, mixer, who: file + '/' + name, base: 1 }); out.push(name);
    });
    camOverride = { pos: [0, 1.45, 2.3], target: [0, 1.3, 0] };
    return out; })(); },
  camReset() { camOverride = null; },
  cam(pos, target) { camOverride = pos ? { pos, target } : null; return true; },   // camera without freezing time
  curl(k) { curlDbg = k; return k; },
  boneDebug(file) { return (async () => { const rec = people.find((p) => p.file === file); await loadPerson(rec); const h = peopleCache.get(file).holder, B = boneMap(h);
    const need = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftUpLeg', 'LeftFoot'];
    let err = null; try { const c = bakeRetarget(rec, rec.kind === 'f' ? 'f' : 'm', 2); err = c ? 'clip ' + c.tracks.length : 'null'; } catch (e) { err = 'throw ' + e.message; }
    return { have: need.filter((n) => B[n]), missing: need.filter((n) => !B[n]), bones: Object.keys(B).length, sample: Object.keys(B).slice(0, 12), retarget: err }; })(); },
  side(s) { sideDbg = s || null; return sideDbg; },
  fingerInfo() { if (!show) return null; const H = handRig(show.lead); const B = show.lead.bones, P = (b) => b.getWorldPosition(new THREE.Vector3());
    return Object.fromEntries(Object.entries(H).map(([side, h]) => { const hw = B[side + 'Hand'].getWorldQuaternion(new THREE.Quaternion());
      const palm = h.palmL.clone().applyQuaternion(hw), th = P(B[side + 'HandThumb1']).sub(P(B[side + 'Hand']));
      const tip = B[side + 'HandMiddle3'] ? P(B[side + 'HandMiddle3']).sub(P(B[side + 'HandMiddle1'])).normalize() : null;
      return [side, { palmDotThumb: +palm.dot(th.normalize()).toFixed(2), palmDotMidCurl: tip ? +palm.dot(tip).toFixed(2) : null, nf: h.fingers.length }]; })); },
  get stage() { const f = (a) => `${a.filter((e) => e.placed).length}/${a.length}`; return { dancers: f(dancers), cows: f(cows), gods: f(gods), beasts: f(beasts),
    why: stageWhy, zF: lanes.dog + LANE_GAP.dog, reel: reelRect, traffic: trafficGaps(), rects: dancers.filter((d) => d.placed).map((d) => [Math.round(d.rect.l), Math.round(d.rect.r), Math.round(d.rect.t), Math.round(d.rect.b), +d.obj.position.z.toFixed(2)]) }; },
  get dances() { return assets ? assets.m.clips.map((c) => c.name) : []; },
  get danceMeta() { return danceMeta; },
  kindOf(file) { const r = people.find((p) => p.file === file); return r ? r.kind : ''; },
  forceTheme(name) { forcedTheme = name || null; return forcedTheme; },
  leadHand() { if (!show) return null; const d = show.lead, B = d.bones || boneMap(d.obj);
    return ['Left', 'Right'].map((s) => B[s + 'Hand'] && B[s + 'Hand'].getWorldPosition(new THREE.Vector3()).toArray()); },
  // play the show frame by frame up to tc and freeze time, for screenshots of a given moment
  showSim(tc) { if (!show) return null; frozenT = 1000; show.t0 = 1000 - tc; show.cycle = -1;
    for (const st of strands) scene.remove(st.mesh); strands = []; splats = [];
    for (let x = 0; x <= tc; x += 1 / 30) updateShow(1000 - tc + x, 0);
    return { splats: splats.length, strands: strands.length }; },
  get show() { return show ? { cycle: show.cycle, splats: splats.length, strands: strands.length, lead: show.lead && show.lead.who } : null; },
  clearDancers() { clearDancers(); return 0; },
  // one model in rest pose at the origin; returns its bounds so the caller can aim the camera
  // Mesh flaps: play each dance frame by frame and count mesh edges that got longer than cm centimetres compared
  // with rest pose (on welded scans a hand drags a piece of clothing along). flap is how many such edges there are at
  // the worst moment of the dance (95th percentile over frames), maxCm is the worst stretch. rom tries other joint
  // limits without touching people.json. test/e2e/dance-fit.js picks a model's dances from this measurement.
  stretchScan(file, { fps = 5, cm = 3, rom = null } = {}) { return (async () => {
    const rec0 = people.find((p) => p.file === file); if (!rec0) return 'нет такой';
    await Promise.all([loadAssets(), loadPerson(rec0)]);
    const rec = rom ? { ...rec0, rom } : rec0;
    const kind = rec.kind === 'f' ? 'f' : 'm', loaded = peopleCache.get(file), out = [];
    const obj = skeletonClone(loaded.holder);
    const meshes = []; obj.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    const v = new THREE.Vector3();
    const posOf = (m) => { const n = m.geometry.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld); v.toArray(a, i * 3); } return a; };
    const edgesOf = (m) => { const idx = m.geometry.index, E = new Set();
      const add = (x, y) => E.add(x < y ? x * 4194304 + y : y * 4194304 + x);
      if (idx) for (let t = 0; t < idx.count; t += 3) { const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2); add(a, b); add(b, c); add(a, c); }
      return [...E].map((k) => [Math.floor(k / 4194304), k % 4194304]); };
    const len = (P, a, b) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    obj.updateMatrixWorld(true);
    const rest = meshes.map((m) => { const P = posOf(m), E = edgesOf(m); return { E, L: E.map(([a, b]) => len(P, a, b)) }; });
    for (let ci = 0; ci < assets[kind].clips.length; ci++) {
      for (const k of [...retargetCache.keys()]) if (k.startsWith(file + '|')) retargetCache.delete(k);
      const clip = bakeRetarget(rec, kind, ci); if (!clip) continue;
      const mixer = new THREE.AnimationMixer(obj); mixer.clipAction(clip).play();
      const counts = []; let maxCm = 0;
      for (let t = 0; t < clip.duration; t += 1 / fps) {
        mixer.setTime(t); obj.updateMatrixWorld(true);
        let bad = 0;
        meshes.forEach((m, mi) => { const P = posOf(m), R = rest[mi];
          for (let k = 0; k < R.E.length; k++) { const d = (len(P, R.E[k][0], R.E[k][1]) - R.L[k]) * 100; if (d > cm) bad++; if (d > maxCm) maxCm = d; } });
        counts.push(bad);
      }
      mixer.stopAllAction(); mixer.uncacheRoot(obj);
      counts.sort((a, b) => a - b);
      out.push({ dance: ci, name: clip.name.split(':')[0], flap: counts[Math.floor(counts.length * 0.95)] || 0, maxCm: +maxCm.toFixed(1) });
    }
    for (const k of [...retargetCache.keys()]) if (k.startsWith(file + '|')) retargetCache.delete(k);
    return out; })(); },
  showModel(file, yaw = 0.3) { return (async () => {
    const rec = people.find((p) => p.file === file); if (!rec) return null;
    await loadPerson(rec); clearDancers(); clearCows(); clearGods();
    const obj = skeletonClone(peopleCache.get(file).holder); obj.rotation.y = yaw;
    scene.add(obj); dancers.push({ obj, mixer: new THREE.AnimationMixer(obj), who: file, base: 1 });
    const b = robustBox(obj);
    return { min: b.min.toArray(), max: b.max.toArray() }; })(); },
  freeze(t = 1, cam = null) { frozenT = t; if (powder) powder.visible = false; if (cam) camOverride = cam; return true; },
  // placement of the model inside its holder (offset and scale computed at load time), for before/after comparisons
  sceneXform(file) { const c = peopleCache.get(file); if (!c) return null; const g = c.holder.children[0];
    return { p: g.position.toArray(), s: g.scale.toArray(), r: g.rotation.toArray().slice(0, 3) }; },
  setSceneXform(file, x) { const c = peopleCache.get(file); if (!c || !x) return false; const g = c.holder.children[0];
    g.position.fromArray(x.p); g.scale.fromArray(x.s); g.rotation.set(...x.r); g.updateMatrixWorld(true); return true; },
  setPeopleDir(d) { peopleDir = d; peopleCache.clear(); fitCache.clear(); retargetCache.clear(); return d; },
  get gfx() { return { level: gfxLevel, mode: gfxMode, gpu: gpuName, fps: lastFps, pr: renderer.getPixelRatio(), aa: renderer.userData.aa }; },
  headDebug(file) { const c = peopleCache.get(file); if (!c) return null; const root = c.holder; root.updateMatrixWorld(true);
    const hb = boneMap(root).Head, hp = hb.getWorldPosition(new THREE.Vector3()), out = [], v = new THREE.Vector3();
    root.traverse((o) => { if (!o.isSkinnedMesh) return; const hist = {}; const P = o.geometry.attributes.position, SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
      for (let i = 0; i < P.count; i += 3) { o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld); if (v.y < hp.y + 0.03) continue;
        let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = SW.getComponent(i, k); if (w > bw) { bw = w; best = SI.getComponent(i, k); } }
        const n = o.skeleton.bones[best].name; hist[n] = (hist[n] || 0) + 1; }
      out.push([o.name, [].concat(o.material).map((m) => m.name).join(','), o.visible, hist]); });
    return out; },
  get fits() { const out = {}; for (const [k, f] of fitCache) { if (!f.head) continue; const G = headGeom(f.head), T = f.torso;
    out[k] = { top: +G.top.toFixed(3), chin: +G.chin.toFixed(3), eyeY: +G.eyeY.toFixed(3), eyes: !!f.head.eyes,
      eyeL: f.head.eyes && f.head.eyes.l.c.toArray().map((v) => +v.toFixed(3)), headBox: f.head.all.box.min.toArray().concat(f.head.all.box.max.toArray()).map((v) => +v.toFixed(3)),
      torsoBox: T && T.box.min.toArray().concat(T.box.max.toArray()).map((v) => +v.toFixed(3)) }; } return out; },
  spawnCostume(name, n) { forcedCostume = name || null; spawnDancers(n || settings.dancers); forcedCostume = null; return dancers.map((d) => d.who); },
  setTheme(name) {
    theme = { name, ...(THEMES[name] || THEMES.default) }; lastThemeName = name;
    PALETTE = theme.palette;
    document.documentElement.style.setProperty('--hue', theme.hue);
    const [c1, c2, c3] = theme.fire;
    fireMat.uniforms.uC1.value.setRGB(...c1); fireMat.uniforms.uC2.value.setRGB(...c2); fireMat.uniforms.uC3.value.setRGB(...c3);
    if (powder) { const g = powder.geometry, col = new THREE.Color();
      for (let i = 0; i < POWDER_N; i++) resetParticle(i, g.attributes.position.array, g.attributes.color.array, powder.userData.vel, col, true);
      g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; }
    if (theme.fireworks) startFireworks(); else stopFireworks();
    stopRain(); startRain(); return theme.name; } } });

$('title').textContent = TITLE;
resize();
loadAssets().catch((e) => console.warn('[ИИндус] предзагрузка моделек не удалась:', e));
window.parent.postMessage({ type: 'IINDU_READY' }, parentOrigin);
