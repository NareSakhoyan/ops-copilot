import { createGoogleEmbedder, type Embedder } from '../src/rag/embed.js';

// Five query/passage pairs = ten distinct sentences in each language.
export const calibration = [
  { language: 'hy', passage: 'Հանձնարարությունը ստեղծվում է միայն օգտատիրոջ հաստատումից հետո։', query: 'Ե՞րբ կարելի է ստեղծել հանձնարարությունը։' },
  { language: 'hy', passage: 'Կորցրած գործարքի պատճառը գրանցեք որպես բարձր գին կամ մրցակցի առաջարկ։', query: 'Ինչպե՞ս գրանցել գործարքի կորստի պատճառը։' },
  { language: 'hy', passage: 'Առաքման հասցեն և բեռի քաշը պետք է ստուգել մինչև փոխադրումը։', query: 'Ի՞նչ տվյալներ ստուգել բեռը առաքելուց առաջ։' },
  { language: 'hy', passage: 'Մուտքի նշանը գործում է տասնհինգ րոպե, իսկ թարմացման նշանը պտտվում է յուրաքանչյուր օգտագործման ժամանակ։', query: 'Որքա՞ն ժամանակ է գործում մուտքի նշանը։' },
  { language: 'hy', passage: 'Յուրաքանչյուր կազմակերպություն տեսնում է միայն իր տվյալները՝ tenant մեկուսացման շնորհիվ։', query: 'Կարո՞ղ է կազմակերպությունը տեսնել մեկ այլ կազմակերպության տվյալները։' },
  { language: 'en', passage: 'A task is created only after the user approves the proposed action.', query: 'When can the assistant create a task?' },
  { language: 'en', passage: 'Record a lost deal reason such as a high price or a competing offer.', query: 'How should a lost deal reason be recorded?' },
  { language: 'en', passage: 'Verify the shipping address and cargo weight before dispatch.', query: 'What must be checked before shipping cargo?' },
  { language: 'en', passage: 'Access tokens expire after fifteen minutes and refresh tokens rotate on every use.', query: 'How long does an access token remain valid?' },
  { language: 'en', passage: 'Tenant isolation ensures each organization can access only its own data.', query: 'Can an organization read another organization’s records?' },
] as const;

function cosine(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0) / (Math.hypot(...left) * Math.hypot(...right));
}
export async function checkEmbeddings(embedder: Embedder) {
  const passages = await embedder.embedPassages(calibration.map((pair) => pair.passage));
  const queries: number[][] = [];
  for (const pair of calibration) queries.push(await embedder.embedQuery(pair.query));
  const dimensions = new Set([...passages, ...queries].map((vector) => vector.length));
  if (dimensions.size !== 1) throw new Error('Embedding diagnostic returned inconsistent dimensions.');
  const pairs: { language: 'hy' | 'en'; kind: 'related' | 'unrelated'; query: string; passage: string; similarity: number }[] = [];
  for (const [queryIndex, pair] of calibration.entries()) {
    for (const [passageIndex, candidate] of calibration.entries()) {
      if (pair.language !== candidate.language) continue;
      pairs.push({ language: pair.language, kind: queryIndex === passageIndex ? 'related' : 'unrelated', query: pair.query, passage: candidate.passage, similarity: cosine(queries[queryIndex] ?? [], passages[passageIndex] ?? []) });
    }
  }
  const groups = (['hy', 'en'] as const).flatMap((language) => (['related', 'unrelated'] as const).map((kind) => {
    const values = pairs.filter((pair) => pair.language === language && pair.kind === kind).map((pair) => pair.similarity);
    return { language, kind, count: values.length, min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
  }));
  return { dimension: [...dimensions][0], pairs, groups };
}

if (import.meta.main) {
  try {
    const result = await checkEmbeddings(createGoogleEmbedder());
    console.log(`Returned dimension: ${String(result.dimension)}`);
    console.table(result.pairs);
    console.table(result.groups);
    console.log('Choose KB_REFUSAL_THRESHOLD using these scores and representative KB questions; no threshold is selected automatically.');
  } catch {
    console.error('Embedding check failed. Verify explicit EMBED_RPM/RPD/TPM, model, dimension, credentials, and the local quota file. Credentials and provider error details are suppressed.');
    process.exitCode = 1;
  }
}
