#!/usr/bin/env python3
"""Dances for the overlay -> extension/assets/dances/dances.glb (+ dances.json).

    python3 scripts/make-dances.py          # download what is missing (in chunks, with pauses) and build
    python3 scripts/make-dances.py --list   # what we take
    python3 scripts/make-dances.py Zombie_FW 94_06   # try single records -> assets-src/dances/preview/

Three sources, all of which allow including the data in a product (each has its own terms, see dances.json and CREDITS.md):
  * AIST++ (Google, annotations under CC BY 4.0): street dance by professional dancers, hip-hop, locking, popping,
    house, krump, waacking, jazz. The pose is SMPL parameters (joint rotations). The SMPL body model itself is not
    used: the rotations are applied to our own skeleton with our own bone lengths (SMPL_OFF).
  * 100STYLE (Ian Mason et al., CC BY 4.0): a hundred movement styles, chicken, zombie, robot, penguin and more.
    BVH; we take the walking variant (_FW) and remove the travel.
  * CMU Graphics Lab Motion Capture Database ("may include in commercially-sold products, may not resell the data
    directly, even in converted form"): Indian dance (subject 94) and pantomimes such as the dancing bear and the
    hippo ballerina (subject 55).
Only the needed records are read from the AIST++ and 100STYLE archives (300 MB and 1.5 GB), in HTTP Range chunks.

The result. The overlay moves a dance onto a model by looking only at the source joint positions (each bone's
direction to its child, the pelvis basis, foot height; bakeRetarget in overlay.js). So the GLB holds a skeleton
with Mixamo bone names (Hips, Spine, LeftArm, ...) and no rotations, and the animation is joint positions per frame.
For each record:
  * forward kinematics (a parser per format), units -> metres, up is +Y;
  * source joints -> Mixamo joints (JOINTS for CMU, SMPL_MAP, BVH_MAP);
  * horizontal pelvis drift is removed (the smoothed path is subtracted) so the sway stays in place; the floor
    comes from the lowest foot; the neck and head no longer lean back;
  * the part of the record that loops best is cut out (pose and speed match at both ends), the seam gets a 0.4 s
    crossfade, 30 fps; the loop is then turned to face the camera on average (+Z);
  * arm reach (reach) and leg lift (kick, thigh angle from vertical) are stored. For models with fragile skinning
    (the second Modi's vest is welded to his hands, his long kurta splits on high steps) the overlay takes only
    calm dances; test/e2e/dance-fit.js picks them.
Sources are cached in assets-src/dances/ (not in git). The finished dances.glb is in git: it may be redistributed
and nobody has to rebuild it.
"""
import json, math, os, pickle, re, struct, sys, time, urllib.request, zipfile
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from remote_zip import RemoteFile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'assets-src', 'dances')
OUT_DIR = os.path.join(ROOT, 'extension', 'assets', 'dances')
FPS_IN, FPS = 120, 30
UNIT = (1 / 0.45) * 0.0254                     # ASF length unit: 0.45 -> inch; converted to metres
AIST_URL = 'https://github.com/google/aistplusplus_dataset/releases/download/v1.0/motions.zip'
STYLE_URL = 'https://zenodo.org/records/8127870/files/100STYLE.zip?download=1'
SOURCES = {
    'aist': {'name': 'AIST++', 'author': 'Google LLC; AIST Dance Video Database', 'license': 'CC BY 4.0',
             'url': 'https://google.github.io/aistplusplus_dataset/'},
    '100style': {'name': '100STYLE', 'author': 'Ian Mason, Sebastian Starke, Taku Komura', 'license': 'CC BY 4.0',
                 'url': 'https://www.ianxmason.com/100style/'},
    'cmu': {'name': 'CMU Graphics Lab Motion Capture Database', 'author': 'Carnegie Mellon University (NSF EIA-0196217)',
            'license': 'можно включать в продукты, нельзя перепродавать сами данные', 'url': 'http://mocap.cs.cmu.edu/'},
}
GENRE = {'HO': 'хаус', 'JB': 'балетный джаз', 'JS': 'стрит-джаз', 'KR': 'крамп', 'LH': 'хип-хоп LA', 'LO': 'локинг',
         'MH': 'хип-хоп', 'PO': 'поппинг', 'WA': 'вакинг', 'BR': 'брейк'}

# (source, record, title, tags, longest loop in seconds). Tags: street for modern street dance,
# rofl for funny styles, indian for Indian dance. The overlay mixes them per celebration theme.
CLIPS = [('aist', n, f'{GENRE[n[1:3]]} ({n.split("_")[3]})', ['street'], 12) for n in [
    'gHO_sFM_cAll_d19_mHO5_ch06', 'gJS_sFM_cAll_d01_mJS3_ch04', 'gKR_sFM_cAll_d28_mKR2_ch03', 'gKR_sFM_cAll_d29_mKR2_ch10',
    'gLH_sFM_cAll_d16_mLH4_ch05', 'gLH_sFM_cAll_d17_mLH4_ch12', 'gLO_sFM_cAll_d13_mLO2_ch03', 'gLO_sFM_cAll_d14_mLO2_ch10',
    'gMH_sFM_cAll_d22_mMH3_ch04', 'gMH_sFM_cAll_d23_mMH3_ch11', 'gPO_sFM_cAll_d10_mPO1_ch02', 'gPO_sFM_cAll_d11_mPO1_ch09',
    'gWA_sFM_cAll_d25_mWA0_ch01', 'gWA_sFM_cAll_d26_mWA0_ch08', 'gBR_sFM_cAll_d04_mBR0_ch01']
] + [('100style', n + '_FW', title, ['rofl'], 10) for n, title in [
    ('Chicken', 'Курица'), ('Zombie', 'Зомби'), ('Robot', 'Робот'), ('Penguin', 'Пингвин'), ('Dinosaur', 'Динозавр'),
    ('Flapping', 'Машет крыльями'), ('WildArms', 'Дикие руки'), ('WiggleHips', 'Виляет бёдрами'), ('SwingShoulders', 'Плечами'),
    ('LawnMower', 'Газонокосилка'), ('Teapot', 'Чайник'), ('Superman', 'Супермен'), ('KarateChop', 'Каратист'), ('Swimming', 'Пловец'),
    ('Aeroplane', 'Самолётик'), ('WhirlArms', 'Мельница'), ('HighKnees', 'Высокие колени'), ('Monk', 'Монах')]
] + [
    ('cmu', '55_12', 'Танцующий медведь', ['rofl'], 10), ('cmu', '55_20', 'Бегемот-балерина', ['rofl'], 10),
    ('cmu', '55_27', 'Танцующий муравей', ['rofl'], 10), ('cmu', '55_25', 'Танцующий зверь', ['rofl'], 10),
] + [('cmu', f'94_{i:02d}', f'Индийский танец {i}', ['indian'], 14) for i in (6, 9, 11, 16)]

# Mixamo joint -> how to get it from CMU bone ends (end(x) is the end of bone x)
JOINTS = {
    'Hips': ('root',), 'Spine': ('end', 'lowerback'), 'Spine1': ('end', 'upperback'),
    'Spine2': ('mid', 'upperback', 'thorax'), 'Neck': ('end', 'thorax'), 'Head': ('end', 'upperneck'),
    'HeadTop_End': ('end', 'head'),
}
for s, c in (('Left', 'l'), ('Right', 'r')):
    JOINTS.update({
        f'{s}Shoulder': ('lerp', 'thorax', f'{c}clavicle', 0.25), f'{s}Arm': ('end', f'{c}clavicle'),
        f'{s}ForeArm': ('end', f'{c}humerus'), f'{s}Hand': ('end', f'{c}radius'), f'{s}HandMiddle1': ('end', f'{c}hand'),
        f'{s}HandThumb1': ('end', f'{c}thumb'),
        f'{s}UpLeg': ('end', f'{c}hipjoint'), f'{s}Leg': ('end', f'{c}femur'), f'{s}Foot': ('end', f'{c}tibia'),
        f'{s}ToeBase': ('end', f'{c}foot'), f'{s}Toe_End': ('end', f'{c}toes'),
    })
PARENT = {'Hips': None, 'Spine': 'Hips', 'Spine1': 'Spine', 'Spine2': 'Spine1', 'Neck': 'Spine2', 'Head': 'Neck', 'HeadTop_End': 'Head'}
for s in ('Left', 'Right'):
    PARENT.update({f'{s}Shoulder': 'Spine2', f'{s}Arm': f'{s}Shoulder', f'{s}ForeArm': f'{s}Arm', f'{s}Hand': f'{s}ForeArm',
                   f'{s}HandMiddle1': f'{s}Hand', f'{s}HandThumb1': f'{s}Hand',
                   f'{s}UpLeg': 'Hips', f'{s}Leg': f'{s}UpLeg', f'{s}Foot': f'{s}Leg', f'{s}ToeBase': f'{s}Foot', f'{s}Toe_End': f'{s}ToeBase'})
NAMES = list(PARENT)                            # parents before children


def fetch(name):
    os.makedirs(os.path.join(CACHE, 'cmu'), exist_ok=True)
    path = os.path.join(CACHE, 'cmu', name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        subj = name.split('_')[0].split('.')[0]
        url = f'http://mocap.cs.cmu.edu/subjects/{subj}/{name}'
        print('  качаю', url, flush=True)
        import ssl
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE   # the CMU site serves an incomplete certificate chain
        data = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=60, context=ctx).read()
        open(path, 'wb').write(data)
        time.sleep(1.5)                         # "Please don't crawl this database": one file at a time
    return path


def rot(ax, ay, az):                            # XYZ Euler angles in degrees, like transforms3d 'sxyz': Rz*Ry*Rx
    x, y, z = np.radians([ax, ay, az])
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def parse_asf(path):
    txt = open(path).read()
    bones = {}
    for blk in re.findall(r'begin(.*?)end', txt.split(':bonedata')[1].split(':hierarchy')[0], re.S):
        name = re.search(r'name\s+(\S+)', blk).group(1)
        d = np.array([float(v) for v in re.search(r'direction\s+(\S+)\s+(\S+)\s+(\S+)', blk).groups()])
        L = float(re.search(r'length\s+(\S+)', blk).group(1))
        ax = [float(v) for v in re.search(r'axis\s+(\S+)\s+(\S+)\s+(\S+)', blk).groups()]
        dof = re.search(r'dof\s+([^\n]+)', blk)
        C = rot(*ax)
        bones[name] = {'dir': d, 'len': L * UNIT, 'C': C, 'Ci': C.T, 'dof': dof.group(1).split() if dof else []}
    parent = {}
    hier = txt.split(':hierarchy')[1]
    for line in re.findall(r'^\s*(\S.*)$', hier.split('begin')[1].split('end')[0], re.M):
        p, *kids = line.split()
        for k in kids: parent[k] = p
    order, todo = [], ['root']
    while todo:
        n = todo.pop(0)
        if n != 'root': order.append(n)
        todo += [k for k, p in parent.items() if p == n]
    return bones, parent, order


def parse_amc(path):
    frames, cur = [], None
    for line in open(path):
        line = line.strip()
        if not line or line[0] in '#:': continue
        if line.isdigit():
            cur = {}; frames.append(cur); continue
        name, *vals = line.split()
        cur[name] = [float(v) for v in vals]
    return frames


def fk(bones, parent, order, frame):
    """bone ends and the root position in metres (Y up)"""
    r = frame['root']
    M = {'root': rot(*r[3:6])}                  # the root has axis 0 0 0, so C = I
    P = {'root': np.array(r[:3]) * UNIT}
    for n in order:
        b = bones[n]
        e = [0.0, 0.0, 0.0]
        vals = frame.get(n, [])
        for i, d in enumerate(b['dof']):
            e['xyz'.index(d[1])] = vals[i] if i < len(vals) else 0.0
        M[n] = M[parent[n]] @ b['C'] @ rot(*e) @ b['Ci']
        P[n] = P[parent[n]] + b['len'] * (M[n] @ b['dir'])
    return P


def joints_of(P):
    out = {}
    for j, spec in JOINTS.items():
        k = spec[0]
        if k == 'root': out[j] = P['root']
        elif k == 'end': out[j] = P[spec[1]]
        elif k == 'mid': out[j] = (P[spec[1]] + P[spec[2]]) / 2
        elif k == 'lerp': out[j] = P[spec[1]] + spec[3] * (P[spec[2]] - P[spec[1]])
    return out


def load_clip(take):                             # CMU: ASF/AMC
    subj = take.split('_')[0]
    bones, parent, order = parse_asf(fetch(f'{subj}.asf'))
    frames = parse_amc(fetch(f'{take}.amc'))[:: FPS_IN // FPS]
    X = np.stack([np.stack([joints_of(fk(bones, parent, order, f))[n] for n in NAMES]) for f in frames])   # [frames, joints, 3]
    return X


_zips = {}
def zip_member(url, member, dest):
    """one file out of a large zip over the network (in chunks), cached on disk"""
    if not os.path.exists(dest) or os.path.getsize(dest) == 0:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if url not in _zips:
            _zips[url] = zipfile.ZipFile(RemoteFile(url))
        print('  беру из архива', member, flush=True)
        data = _zips[url].read(member)              # read first, so a network failure leaves no empty file in the cache
        open(dest, 'wb').write(data)
        time.sleep(0.5)
    return dest


def rodrigues(aa):                              # axis-angles [..., 3] -> matrices [..., 3, 3]
    th = np.linalg.norm(aa, axis=-1, keepdims=True)
    k = aa / np.maximum(th, 1e-8)
    K = np.zeros(aa.shape[:-1] + (3, 3))
    K[..., 0, 1], K[..., 0, 2], K[..., 1, 0] = -k[..., 2], k[..., 1], k[..., 2]
    K[..., 1, 2], K[..., 2, 0], K[..., 2, 1] = -k[..., 0], -k[..., 1], k[..., 0]
    th = th[..., None]
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * (K @ K)


def to_y_up(P, top, bottom):
    """rotate everything so the mean bottom->top vector points up (+Y)"""
    v = (P[:, top] - P[:, bottom]).mean(0); v /= np.linalg.norm(v)
    y = np.array([0.0, 1.0, 0.0]); c = float(v @ y)
    if c > 0.9999: return P
    if c < -0.9999: return P * np.array([1, -1, -1])
    ax = np.cross(v, y); ax /= np.linalg.norm(ax)
    R = rodrigues(ax * math.acos(c))
    return P @ R.T


# SMPL: 24 joints, their parents and OUR bone lengths in rest pose (T-pose, +X is the left side, +Z is forward).
# The SMPL body model (non-commercial licence) is not needed: only the rotations come from AIST++ (CC BY 4.0).
SMPL_PARENT = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21]
SMPL_OFF = np.array([
    [0, 0, 0], [0.07, -0.08, 0], [-0.07, -0.08, 0], [0, 0.11, -0.02], [0.03, -0.38, 0], [-0.03, -0.38, 0],
    [0, 0.13, 0], [-0.01, -0.40, -0.04], [0.01, -0.40, -0.04], [0, 0.06, 0.02], [0.02, -0.06, 0.12], [-0.02, -0.06, 0.12],
    [0, 0.21, -0.03], [0.08, 0.12, -0.02], [-0.08, 0.12, -0.02], [0, 0.09, 0.05], [0.11, 0.04, -0.01], [-0.11, 0.04, -0.01],
    [0.26, -0.01, -0.02], [-0.26, -0.01, -0.02], [0.25, 0.01, 0], [-0.25, 0.01, 0], [0.08, -0.01, -0.01], [-0.08, -0.01, -0.01]])
SMPL_MAP = {'Hips': 0, 'LeftUpLeg': 1, 'RightUpLeg': 2, 'Spine': 3, 'LeftLeg': 4, 'RightLeg': 5, 'Spine1': 6, 'LeftFoot': 7,
            'RightFoot': 8, 'Spine2': 9, 'LeftToeBase': 10, 'RightToeBase': 11, 'Neck': 12, 'LeftShoulder': 13, 'RightShoulder': 14,
            'Head': 15, 'LeftArm': 16, 'RightArm': 17, 'LeftForeArm': 18, 'RightForeArm': 19, 'LeftHand': 20, 'RightHand': 21,
            'LeftHandMiddle1': 22, 'RightHandMiddle1': 23}
# end points SMPL does not have: (from joint, offset in its frame)
SMPL_TIPS = {'HeadTop_End': (15, [0, 0.17, 0.0]), 'LeftToe_End': (10, [0, 0, 0.06]), 'RightToe_End': (11, [0, 0, 0.06]),
             'LeftHandThumb1': (20, [0.03, 0, 0.04]), 'RightHandThumb1': (21, [-0.03, 0, 0.04])}


def load_aist(name):
    d = pickle.load(open(zip_member(AIST_URL, f'motions/{name}.pkl', os.path.join(CACHE, 'aist', name + '.pkl')), 'rb'))
    poses = np.asarray(d['smpl_poses']).reshape(-1, 24, 3)[::2]                # 60 -> 30 fps
    trans = np.asarray(d['smpl_trans'])[::2] / float(np.asarray(d['smpl_scaling']).ravel()[0])
    R = rodrigues(poses)
    n = len(poses)
    G, P = np.zeros((n, 24, 3, 3)), np.zeros((n, 24, 3))
    for j in range(24):
        p = SMPL_PARENT[j]
        if p < 0: G[:, j], P[:, j] = R[:, j], trans
        else: G[:, j] = G[:, p] @ R[:, j]; P[:, j] = P[:, p] + G[:, p] @ SMPL_OFF[j]
    out = np.zeros((n, len(NAMES), 3))
    for nm, j in SMPL_MAP.items(): out[:, NAMES.index(nm)] = P[:, j]
    for nm, (j, off) in SMPL_TIPS.items(): out[:, NAMES.index(nm)] = P[:, j] + G[:, j] @ np.array(off)
    return to_y_up(out, NAMES.index('Neck'), NAMES.index('Hips'))


def parse_bvh(text):
    tok = text.split()
    i, joints, stack = 0, [], []
    while tok[i] != 'MOTION':
        t = tok[i]
        if t in ('ROOT', 'JOINT'):
            joints.append({'name': tok[i + 1], 'parent': stack[-1] if stack else -1}); i += 2
        elif t == 'End':
            joints.append({'name': joints[stack[-1]]['name'] + '_end', 'parent': stack[-1], 'chan': []}); i += 2
        elif t == '{': stack.append(len(joints) - 1); i += 1
        elif t == '}': stack.pop(); i += 1
        elif t == 'OFFSET': joints[-1]['off'] = np.array([float(v) for v in tok[i + 1:i + 4]]); i += 4
        elif t == 'CHANNELS':
            k = int(tok[i + 1]); joints[-1]['chan'] = tok[i + 2:i + 2 + k]; i += 2 + k
        else: i += 1
    nf = int(tok[tok.index('Frames:', i) + 1]); ft = float(tok[tok.index('Time:', i) + 1])
    vals = np.array(tok[tok.index('Time:', i) + 2:], dtype=float).reshape(nf, -1)
    return joints, vals, ft


def axis_rot(axis, deg):
    t = np.radians(deg); c, s_ = np.cos(t), np.sin(t)
    R = np.zeros(deg.shape + (3, 3)); a = 'XYZ'.index(axis); b, cidx = [x for x in range(3) if x != a]
    R[..., a, a] = 1; R[..., b, b] = c; R[..., cidx, cidx] = c; R[..., b, cidx] = -s_; R[..., cidx, b] = s_
    return R


BVH_MAP = {'Hips': 'Hips', 'Spine': 'Chest', 'Spine1': 'Chest2', 'Spine2': 'Chest4', 'Neck': 'Neck', 'Head': 'Head', 'HeadTop_End': 'Head_end'}
for s_, c_ in (('Left', 'Left'), ('Right', 'Right')):
    BVH_MAP.update({f'{s_}Shoulder': f'{c_}Collar', f'{s_}Arm': f'{c_}Shoulder', f'{s_}ForeArm': f'{c_}Elbow', f'{s_}Hand': f'{c_}Wrist',
                    f'{s_}HandMiddle1': f'{c_}Wrist_end', f'{s_}HandThumb1': f'{c_}Wrist_end', f'{s_}UpLeg': f'{c_}Hip',
                    f'{s_}Leg': f'{c_}Knee', f'{s_}Foot': f'{c_}Ankle', f'{s_}ToeBase': f'{c_}Toe', f'{s_}Toe_End': f'{c_}Toe_end'})


def load_style(name):
    style = name.split('_')[0]
    path = zip_member(STYLE_URL, f'100STYLE/{style}/{name}.bvh', os.path.join(CACHE, '100style', name + '.bvh'))
    joints, vals, ft = parse_bvh(open(path).read())
    step = max(1, round(1 / ft / FPS))
    vals = vals[::step]; n = len(vals)
    G, P, col = [None] * len(joints), [None] * len(joints), 0
    for j, jt in enumerate(joints):
        R = np.broadcast_to(np.eye(3), (n, 3, 3)).copy(); pos = None
        for ch in jt.get('chan', []):
            v = vals[:, col]; col += 1
            if ch.endswith('position'):
                pos = np.zeros((n, 3)) if pos is None else pos; pos[:, 'XYZ'.index(ch[0])] = v
            else:
                R = R @ axis_rot(ch[0], v)
        p = jt['parent']
        if p < 0: G[j], P[j] = R, pos if pos is not None else np.zeros((n, 3))
        else: G[j] = G[p] @ R; P[j] = P[p] + G[p] @ jt['off']
    idx = {jt['name']: k for k, jt in enumerate(joints)}
    out = np.stack([P[idx[BVH_MAP[nm]]] for nm in NAMES], 1) * 0.01               # cm -> m
    return to_y_up(out, NAMES.index('Neck'), NAMES.index('Hips'))


def load(src, take):
    return {'cmu': load_clip, 'aist': load_aist, '100style': load_style}[src](take)


def reach(Y):
    """arm reach: 90th percentile of the hand's distance from the body axis (pelvis to neck), in arm lengths"""
    J = NAMES.index
    a, b = Y[:, J('Hips')], Y[:, J('Neck')]
    ab = b - a; ab2 = (ab * ab).sum(1, keepdims=True)
    out = []
    for s_ in ('Left', 'Right'):
        arm = (np.linalg.norm(Y[:, J(s_ + 'Arm')] - Y[:, J(s_ + 'ForeArm')], axis=1) + np.linalg.norm(Y[:, J(s_ + 'ForeArm')] - Y[:, J(s_ + 'Hand')], axis=1)).mean()
        p = Y[:, J(s_ + 'Hand')]
        t = np.clip(((p - a) * ab).sum(1, keepdims=True) / ab2, 0, 1)
        out.append(np.linalg.norm(p - (a + t * ab), axis=1) / arm)
    return float(np.percentile(np.maximum(*out), 90))


def facing(X):
    """body yaw around the vertical per frame (0 is facing +Z), unwrapped across +-180 degrees"""
    side = X[:, NAMES.index('LeftUpLeg')] - X[:, NAMES.index('RightUpLeg')]
    return np.unwrap(np.arctan2(-side[:, 2], side[:, 0]))                  # forward = side x Y


def turn(X, ang, pivot=None):
    """rotate around the vertical by -ang (a number or per frame), optionally around a pivot point (per frame)"""
    ang = np.broadcast_to(np.asarray(ang, dtype=float), (len(X),))
    c, s = np.cos(-ang)[:, None], np.sin(-ang)[:, None]
    P = X - pivot[:, None, :] if pivot is not None else X.copy()
    x, z = P[:, :, 0].copy(), P[:, :, 2].copy()
    P[:, :, 0] = c * x + s * z; P[:, :, 2] = -s * x + c * z
    return P + pivot[:, None, :] if pivot is not None else P


def smooth(v, w):                               # moving average with a 2w+1 window, edges padded by repetition
    v = np.asarray(v, dtype=float)
    pad = np.concatenate([np.repeat(v[:1], w, 0), v, np.repeat(v[-1:], w, 0)])
    k = np.ones(2 * w + 1) / (2 * w + 1)
    return np.convolve(pad, k, 'valid') if v.ndim == 1 else np.stack([np.convolve(pad[:, a], k, 'valid') for a in range(v.shape[1])], 1)


def kick(Y):
    """leg lift: 95th percentile of the thigh angle from vertical, degrees (the larger of the two legs)"""
    J = NAMES.index
    out = []
    for s_ in ('Left', 'Right'):
        d = Y[:, J(s_ + 'Leg')] - Y[:, J(s_ + 'UpLeg')]
        out.append(np.degrees(np.arccos(np.clip(-d[:, 1] / np.linalg.norm(d, axis=1), -1, 1))))
    return float(np.percentile(np.maximum(*out), 95))


def normalize(X, unwind=False):
    """unwind is for walking records (100STYLE): the actor walks in a circle, so the slow body turn is subtracted
    the same way as the drift on the floor. What remains is walking on the spot facing one way, with the sway kept.
    Dances do not get this, turns are part of a dance. face_camera() turns the loop to the camera after it is chosen."""
    iH = NAMES.index('Hips')
    if unwind:
        X = turn(X, smooth(facing(X), int(1.5 * FPS)), X[:, iH] * np.array([1.0, 0.0, 1.0]))
    # horizontal drift: subtract the smoothed (2 s) pelvis path
    sm = smooth(X[:, iH], 2 * FPS)
    X[:, :, 0] -= sm[:, None, 0]; X[:, :, 2] -= sm[:, None, 2]
    X = fix_neck(X)
    feet = [NAMES.index(n) for n in ('LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase')]
    X[:, :, 1] -= np.percentile(X[:, feet, 1].min(1), 5)                  # floor from the lowest foot
    return X


def face_camera(Y):
    """turn the finished loop to face the camera on average (+Z)"""
    f = facing(Y)
    return turn(Y, math.atan2(np.sin(f).mean(), np.cos(f).mean()))


def fix_neck(X, neck_to=10.0, head_to=0.0):
    """In CMU data the neck leans back on average (~15 degrees for subject 94, because of where the markers sit),
    while on our models it leans slightly forward, so the head tipped back on the model. The mean neck pitch is
    brought to neck_to degrees and the head to head_to (relative to the top of the spine, in the body plane);
    head movements stay as they were."""
    J = lambda n: NAMES.index(n)
    def frame_axes():
        up = X[:, J('Neck')] - X[:, J('Spine1')]; up /= np.linalg.norm(up, axis=1, keepdims=True)
        side = X[:, J('LeftArm')] - X[:, J('RightArm')]
        fwd = np.cross(side, up); fwd /= np.linalg.norm(fwd, axis=1, keepdims=True)
        return up, fwd, np.cross(up, fwd)                # axis of the forward tilt
    def pitch(v, up, fwd):
        v = v / np.linalg.norm(v, axis=1, keepdims=True)
        return np.degrees(np.arctan2((v * fwd).sum(1), (v * up).sum(1)))
    def rotate(v, k, deg):                               # Rodrigues: rotate v around axis k (per frame) by the angle
        t = np.radians(deg); k = k / np.linalg.norm(k, axis=1, keepdims=True)
        return v * math.cos(t) + np.cross(k, v) * math.sin(t) + k * (k * v).sum(1, keepdims=True) * (1 - math.cos(t))
    up, fwd, side = frame_axes()
    d = neck_to - pitch(X[:, J('Head')] - X[:, J('Neck')], up, fwd).mean()
    for n in ('Head', 'HeadTop_End'):                    # forward means turning from up to fwd, i.e. around up x fwd
        X[:, J(n)] = X[:, J('Neck')] + rotate(X[:, J(n)] - X[:, J('Neck')], side, d)
    d = head_to - pitch(X[:, J('HeadTop_End')] - X[:, J('Head')], up, fwd).mean()
    X[:, J('HeadTop_End')] = X[:, J('Head')] + rotate(X[:, J('HeadTop_End')] - X[:, J('Head')], side, d)
    return X


def best_loop(X, max_len, min_len=6.0, xfade=0.4):
    """the slice [a, b) that loops best, with the seam already smoothed"""
    n, cf = len(X), int(xfade * FPS)
    rel = X - X[:, :1]                                                    # pose relative to the pelvis
    vel = np.gradient(X, axis=0)
    act = np.linalg.norm(vel, axis=2).mean(1)                             # how much movement there is
    start = max(cf, min(FPS, n // 10))
    lo, hi = min(int(min_len * FPS), (n - start) * 2 // 3), int(max_len * FPS)   # a short record gets a shorter loop
    best = None
    for a in range(start, max(start + 1, n - lo), 3):
        for b in range(a + lo, min(n, a + hi), 3):
            pose = np.linalg.norm(rel[a] - rel[b], axis=1).mean() + abs(X[a, 0, 1] - X[b, 0, 1])
            v = np.linalg.norm(vel[a] - vel[b], axis=1).mean() * FPS * 0.1
            cost = (pose + v) / (act[a:b].mean() * FPS + 0.05)            # a rough seam is acceptable if the dance is lively
            if best is None or cost < best[0]: best = (cost, a, b)
    _, a, b = best
    Y = X[a:b].copy()
    for i in range(cf):                                                   # the tail blends into what came right before the start
        t = (i + 1) / cf
        Y[len(Y) - cf + i] = (1 - t) * X[b - cf + i] + t * X[a - cf + i]
    return Y, a / FPS, b / FPS


# ---------- GLB ----------
def write_glb(path, clips):
    rest = clips[0][1][0]                                                 # the skeleton's rest pose is the first frame of the first dance
    nodes = [{'name': 'CMU', 'children': [1]}]
    idx = {n: i + 1 for i, n in enumerate(NAMES)}
    for n in NAMES:
        p = PARENT[n]
        t = rest[NAMES.index(n)] - (rest[NAMES.index(p)] if p else 0)
        node = {'name': n, 'translation': [round(float(v), 5) for v in t]}
        kids = [idx[c] for c in NAMES if PARENT[c] == n]
        if kids: node['children'] = kids
        nodes.append(node)
    bin_, views, accs, anims = bytearray(), [], [], []

    def add(arr, typ, minmax=False):
        a = np.ascontiguousarray(arr, dtype='<f4')
        while len(bin_) % 4: bin_.append(0)
        views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': a.nbytes})
        bin_.extend(a.tobytes())
        acc = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': int(a.shape[0]), 'type': typ}
        if minmax: acc['min'] = [float(a.min())]; acc['max'] = [float(a.max())]
        accs.append(acc)
        return len(accs) - 1

    for name, X in clips:
        times = add(np.arange(len(X), dtype=np.float32) / FPS, 'SCALAR', True)
        samplers, channels = [], []
        for j, n in enumerate(NAMES):
            p = PARENT[n]
            local = X[:, j] - (X[:, NAMES.index(p)] if p else 0)
            samplers.append({'input': times, 'output': add(local, 'VEC3'), 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1, 'target': {'node': idx[n], 'path': 'translation'}})
        anims.append({'name': name, 'samplers': samplers, 'channels': channels})
    gltf = {'asset': {'version': '2.0', 'generator': 'make-dances.py',
                      'copyright': 'Motion data: AIST++ (Google LLC, CC BY 4.0); 100STYLE (Mason et al., CC BY 4.0); CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu (NSF EIA-0196217)'},
            'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': nodes, 'animations': anims,
            'buffers': [{'byteLength': len(bin_)}], 'bufferViews': views, 'accessors': accs}
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    while len(bin_) % 4: bin_.append(0)
    out = struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_))
    out += struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(bin_)) + b'BIN\0' + bytes(bin_)
    open(path, 'wb').write(out)


def main():
    if '--list' in sys.argv:
        for src, take, title, tags, mx in CLIPS: print(f'{src:9s} {take:28s} {title:30s} {",".join(tags):8s} ≤{mx} с')
        return
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    os.makedirs(OUT_DIR, exist_ok=True)
    clips, meta = [], []
    for src, take, title, tags, mx in CLIPS:
        if only and take not in only: continue
        try:
            X = normalize(load(src, take), unwind=src == '100style')
        except Exception as e:
            print(f'  {take}: не вышло — {e}', flush=True); continue
        Y, a, b = best_loop(X, mx)
        Y = face_camera(Y)
        r, kk = reach(Y), kick(Y)
        clips.append((take, Y.astype(np.float32)))
        meta.append({'take': take, 'title': title, 'source': src, 'tags': tags, 'reach': round(r, 2), 'kick': round(kk), 'from': round(a, 2), 'to': round(b, 2),
                     'seconds': round(len(Y) / FPS, 2)})
        print(f'  {src:9s} {take:28s} {title:30s} {a:5.1f}–{b:5.1f} с ({len(Y) / FPS:4.1f} с)  размах {r:.2f}  подъём ноги {kk:.0f}°', flush=True)
    if not clips:
        print('ничего не собрано'); sys.exit(1)
    # with a name filter it is a trial run: the main library is left alone
    out_dir = os.path.join(CACHE, 'preview') if only else OUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    write_glb(os.path.join(out_dir, 'dances.glb'), clips)
    json.dump({'fps': FPS, 'sources': SOURCES,
               'credit_cmu': 'The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.',
               'clips': meta}, open(os.path.join(out_dir, 'dances.json'), 'w'), ensure_ascii=False, indent=1)
    print(f'готово: {os.path.relpath(out_dir, ROOT)}/dances.glb ({os.path.getsize(os.path.join(out_dir, "dances.glb")) / 1e6:.1f} МБ), {len(clips)} танцев')


if __name__ == '__main__':
    main()
