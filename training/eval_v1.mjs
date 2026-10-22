// v1 prompts (the very first extension version) by group: how many frames are at or above the threshold
import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers';
import fs from 'fs';
env.cacheDir = './.hf';
const POS = ['a photo of Indian people','a video of people from India','Indian people dancing to Bollywood music','a scene from a Bollywood movie','an Indian man with a mustache','an Indian woman wearing a saree','a Sikh man wearing a turban','a busy street in India with rickshaws','an Indian wedding with colorful clothes','a Hindu temple','Indian street food being cooked','a sign written in Hindi'];
const NEG = ['a photo of white European people','a photo of Russian people','a photo of East Asian people','a photo of Black African people','a photo of Latin American people','a photo of Middle Eastern Arab people','a person talking to the camera in a room','a city street in Europe','a city street in America','a music concert','a football match','a cat','a dog','a car','a video game','an anime cartoon','a landscape with nature','a screenshot of text','a meme with text','food on a plate','a black screen'];
const tok = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32');
const model = await CLIPTextModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', { dtype: 'q8' });
const { text_embeds } = await model(tok([...POS, ...NEG], { padding: true, truncation: true }));
const T = text_embeds.normalize(2, -1).tolist();
const softmax = (a) => { const m = Math.max(...a); const e = a.map((x) => Math.exp(x - m)); const s = e.reduce((p, q) => p + q, 0); return e.map((x) => x / s); };
for (const f of ['emb_scene_b32.json', 'emb_reelsim_b32.json']) {
  const items = JSON.parse(fs.readFileSync(f)).items;
  const g = {};
  for (const it of items) {
    const p = softmax(T.map((t) => 100 * t.reduce((a, v, i) => a + v * it.emb[i], 0)));
    const zs = p.slice(0, POS.length).reduce((a, b) => a + b, 0);
    (g[it.group] ||= []).push(zs);
  }
  console.log('==', f);
  for (const k of ['georgian', 'caucasus', 'slavic', 'turkish', 'mideast', 'ind_dance', 'hf_ind_dance', 'ind_wedding']) if (g[k]) console.log(`  ${k.padEnd(12)} n=${g[k].length} v1 zero-shot ≥0.5: ${(g[k].filter((v) => v >= 0.5).length / g[k].length).toFixed(2)}  ≥0.6: ${(g[k].filter((v) => v >= 0.6).length / g[k].length).toFixed(2)}  mean ${(g[k].reduce((a, b) => a + b, 0) / g[k].length).toFixed(2)}`);
}
