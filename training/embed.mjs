// node embed.mjs <backbone> <list.json> <out.json>
// list.json: [{file, ...meta}] → out.json: {backbone, dim, items:[{...meta, emb:[...]}]}
import { AutoProcessor, CLIPVisionModelWithProjection, SiglipVisionModel, RawImage, env } from '@huggingface/transformers';
import fs from 'fs';

env.cacheDir = './.hf';
const BACKBONES = {
  b32: { id: 'Xenova/clip-vit-base-patch32', kind: 'clip' },
  b16: { id: 'Xenova/clip-vit-base-patch16', kind: 'clip' },
  siglip: { id: 'Xenova/siglip-base-patch16-224', kind: 'siglip' },
  l14: { id: 'Xenova/clip-vit-large-patch14', kind: 'clip' },
};
const [, , name, listFile, outFile, cropsFlag, dtypeArg] = process.argv;
const DTYPE = dtypeArg || process.env.DTYPE || 'q8';
const CROPS = cropsFlag === '--crops';
const bb = BACKBONES[name];
const list = JSON.parse(fs.readFileSync(listFile));
const processor = await AutoProcessor.from_pretrained(bb.id);
const model = bb.kind === 'clip'
  ? await CLIPVisionModelWithProjection.from_pretrained(bb.id, { dtype: DTYPE })
  : await SiglipVisionModel.from_pretrained(bb.id, { dtype: DTYPE });

const items = [];
let t = 0, n = 0;
for (const it of list) {
  try {
    const img = await RawImage.read(it.file);
    const embed = async (im) => { const out = await model(await processor(im)); return (out.image_embeds ?? out.pooler_output).normalize(2, -1).tolist()[0].map((v) => +v.toFixed(5)); };
    const t0 = performance.now();
    const rec = { ...it, emb: await embed(img) };
    if (CROPS) {
      const W = img.width, H = img.height;
      // top-centre (where the face usually is in a vertical video) and centre
      rec.emb_top = await embed(await img.clone().crop([Math.round(W * 0.2), 0, Math.round(W * 0.8), Math.round(H * 0.6)]));
      rec.emb_center = await embed(await img.clone().crop([Math.round(W * 0.15), Math.round(H * 0.15), Math.round(W * 0.85), Math.round(H * 0.85)]));
    }
    t += performance.now() - t0; n++;
    items.push(rec);
  } catch (e) { console.error('skip', it.file, e.message); }
  if (n % 200 === 0) console.error(`${name}: ${n}/${list.length} (${(t / n).toFixed(0)} ms/img)`);
}
fs.writeFileSync(outFile, JSON.stringify({ backbone: name, id: bb.id, dim: items[0].emb.length, msPerImg: +(t / n).toFixed(1), items }));
console.log(`${name}[${DTYPE}]: ${n} images, ${(t / n).toFixed(0)} ms/img, dim ${items[0].emb.length}`);
