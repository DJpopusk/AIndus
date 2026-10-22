// node text_embed.mjs <b32|b16> -> prompts_<b>.json with normalised prompt embeddings (for the extension and the prototype)
import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers';
import fs from 'fs';
env.cacheDir = './.hf';
const IDS = { b32: 'Xenova/clip-vit-base-patch32', b16: 'Xenova/clip-vit-base-patch16' };
const b = process.argv[2];

export const PROMPTS = {
  // cultural context of the scene; works without faces too
  context: [
    'Indian people dancing to Bollywood music', 'a Bollywood dance number from an Indian movie', 'a scene from a Bollywood movie',
    'Bharatanatyam classical Indian dance in a silk saree with temple jewelry', 'Bhangra dancers in colorful Punjabi dress with turbans',
    'Garba dance with dandiya sticks at Navratri', 'an Indian wedding with colorful clothes', 'a Hindu temple',
    'a busy street in India with rickshaws and crowds', 'Indian street food being cooked', 'a sign written in Hindi',
    'people celebrating Diwali or Holi', 'an Indian woman wearing a saree', 'a Sikh man wearing a turban',
    'a video of people from India', 'an Indian cricket match',
  ],
  // people (the zero-shot part is weak; the trained head backs it up)
  person: ['a photo of Indian people', 'a photo of a South Asian man', 'a photo of a South Asian woman', 'an Indian man with a mustache'],
  negative: [
    // folk and other dances, the main competitors of Indian dance
    'Georgian folk dancers in traditional chokha costumes', 'Caucasian lezginka dance with fast footwork', 'Georgian men dancing on their toes with swords',
    'a Caucasian wedding with lezginka dancing', 'Armenian or Azerbaijani folk dance ensemble', 'Russian folk dance in kokoshnik and sarafan',
    'Ukrainian hopak Cossack dance', 'a Russian wedding', 'Turkish folk dance halay in a circle', 'a Turkish wedding', 'Arabic dabke line dance at a wedding',
    'a belly dancer in a sequined costume', 'Persian dance in traditional Iranian dress', 'Uzbek or Kazakh folk dance in Central Asian costumes',
    'Greek or Balkan folk dance in a circle', 'a Spanish flamenco dancer in a ruffled dress', 'Latin salsa or samba dancers at a carnival',
    'African tribal dance in traditional attire', 'Chinese or Korean traditional dance in silk robes', 'Balinese or Thai dance with a golden headdress',
    'Irish step dancers', 'a ballet performance', 'a hip hop or breakdance battle', 'K-pop idols dancing on stage',
    'a folk dance ensemble in embroidered costumes at a European festival',
    // people of other groups
    'a photo of a white European man', 'a photo of a white European woman', 'a photo of Russian people', 'a photo of Georgian people from the Caucasus',
    'a photo of an East Asian man', 'a photo of an East Asian woman', 'a photo of Black African people', 'a photo of Latin American people',
    'a photo of a Middle Eastern Arab man', 'a photo of an Arab woman in a hijab', 'a photo of a Turkish man', 'a photo of a Persian man',
    'a classical oil painting portrait', 'a man wearing a hat', 'a person with a beard talking to the camera', 'a person talking to the camera in a room',
    // places and everything else
    'a city street in Europe', 'a city street in America', 'a city street in East Asia', 'a city street in the Middle East', 'a mosque',
    'a music concert', 'a football match', 'a cat', 'a dog', 'a car', 'a video game', 'an anime cartoon', 'a landscape with nature',
    'a screenshot of text', 'a meme with text', 'food on a plate', 'a black screen',
  ],
  // gate: is there a person / a large face in the frame
  gate: ['a close-up photo of a person\'s face', 'a photo of one or more people', 'a scene or object with no people in it', 'text, a diagram or a screenshot'],
};

if (b) {
  const tok = await AutoTokenizer.from_pretrained(IDS[b]);
  const model = await CLIPTextModelWithProjection.from_pretrained(IDS[b], { dtype: 'q8' });
  const out = { backbone: b, id: IDS[b], sets: {} };
  for (const [name, labels] of Object.entries(PROMPTS)) {
    const { text_embeds } = await model(tok(labels, { padding: true, truncation: true }));
    const E = text_embeds.normalize(2, -1).tolist();
    out.sets[name] = { labels, emb: E.map((e) => e.map((v) => +v.toFixed(5))) };
  }
  fs.writeFileSync(`prompts_${b}.json`, JSON.stringify(out));
  console.log('saved', `prompts_${b}.json`, Object.fromEntries(Object.entries(out.sets).map(([k, v]) => [k, v.labels.length])));
}
