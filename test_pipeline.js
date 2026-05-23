const fs = require('fs');
const text = fs.readFileSync('D:/AI/ch18.txt','utf-8');
const kb = JSON.parse(fs.readFileSync('D:/AI/long-novel-gpt/提示词/prompt_knowledge_base.json','utf-8'));
const cats = kb.categories;

function extractKeywords(cat) {
  const kws = [];
  if (cat.synonyms) kws.push(...cat.synonyms);
  if (cat.bootstrap?.confirm_signals) {
    for (const s of cat.bootstrap.confirm_signals) {
      if (s.length >= 2 && !kws.includes(s)) kws.push(s);
    }
  }
  return kws;
}

function buildCatalog(cats) {
  return cats.map(c => {
    const kws = extractKeywords(c).slice(0, 24);
    const kwStr = kws.length ? kws.join(',') : '(none)';
    if (c.bootstrap) {
      const b = c.bootstrap;
      return 'id='+c.id+'='+c.name+' | entry:'+b.entry_conditions+' | signals:'+(b.confirm_signals||[]).slice(0,5).join(',')+' | keywords:'+kwStr;
    }
    return 'id='+c.id+'='+c.name+' | keywords:'+kwStr;
  }).join('\n');
}

function snapToSentence(start, end, fullText) {
  const SENT = /[.!\n]/;
  let s = start;
  for (let k = 0; k < 45 && s > 0; k++, s--) { if (SENT.test(fullText[s - 1])) break; }
  let e = end;
  for (let k = 0; k < 45 && e < fullText.length; k++, e++) { if (SENT.test(fullText[e])) { e++; break; } }
  return { start: s, end: e };
}

function locateEvidence(evidence, fullText) {
  let idx = fullText.indexOf(evidence);
  if (idx === -1) {
    const normEv = evidence.replace(/[\s\r\n\u3000]+/g, '');
    const normText = fullText.replace(/[\s\r\n\u3000]+/g, '');
    idx = normText.indexOf(normEv);
    if (idx !== -1) {
      let origPos = 0, normPos = 0;
      while (normPos < idx && origPos < fullText.length) {
        if (/[\s\r\n\u3000]/.test(fullText[origPos])) { origPos++; }
        else { origPos++; normPos++; }
      }
      idx = origPos;
    }
  }
  if (idx === -1) {
    for (let win = Math.min(40, evidence.length); win >= 15; win -= 5) {
      for (let k = 0; k <= evidence.length - win; k++) {
        const pos = fullText.indexOf(evidence.slice(k, k + win));
        if (pos !== -1) { idx = pos; break; }
      }
      if (idx !== -1) break;
    }
  }
  return idx;
}

const MIN_TAG_LEN = 12;
const MAX_TAG_LEN = 250;
const MIN_CONFIDENCE = 0.55;
const catalog = buildCatalog(cats);

const systemPrompt = `You are a scene analysis assistant. Identify all matching scenes from the catalog.
Rules:
1. evidence must be verbatim from the original text (>=30 chars), covering the full scene paragraph
2. Each evidence must be locatable in the original text
3. confidence >= 0.5 to output
4. Max 1 longest fragment per category
5. Max 6 matches total

Output JSON: {"matches":[{"categoryId":"","confidence":0.x,"evidence":"verbatim text >=30 chars"}]}`;

const body = JSON.stringify({
  model: 'huihui_ai/gemma-4-abliterated:e2b', stream: false,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'catalog:\n'+catalog+'\n\nallowed_ids: '+JSON.stringify(cats.map(c=>c.id))+'\n\ntext:\n'+text }
  ],
  temperature: 0.3, max_tokens: 2000
});

console.log('=== FULL PIPELINE TEST ===');
console.log('Chapter: ' + text.length + ' chars | Categories: ' + cats.length);
console.log('');

fetch('http://localhost:11434/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body})
  .then(r => r.json()).then(d => {
    let json = d?.message?.content;
    const md = json.match(/```(?:json)?\s*([\s\S]*?)```/); if (md) json = md[1].trim();
    const b = json.indexOf('{'); if (b > 0) json = json.slice(b);

    try {
      const parsed = JSON.parse(json);
      const rawMatches = (parsed.matches || []);
      console.log('AI returned: ' + rawMatches.length + ' matches');

      const aiTags = [];
      for (const m of rawMatches) {
        if (m.confidence < MIN_CONFIDENCE) { console.log('  SKIP ' + m.categoryId + ': low conf ' + m.confidence); continue; }
        const cat = cats.find(c => c.id === m.categoryId);
        if (!cat) { console.log('  SKIP ' + m.categoryId + ': unknown cat'); continue; }
        if (!m.evidence || m.evidence.length < 12) { console.log('  SKIP ' + cat.name + ': short ev ' + (m.evidence?.length||0)); continue; }

        const idx = locateEvidence(m.evidence, text);
        if (idx < 0) {
          console.log('  FAIL ' + cat.name + ': locate failed. ev=' + m.evidence.slice(0,60));
          continue;
        }

        const snapped = snapToSentence(idx, idx + m.evidence.length, text);
        if (snapped.end - snapped.start < MIN_TAG_LEN) { console.log('  FAIL ' + cat.name + ': snapped too short'); continue; }
        if (snapped.end - snapped.start > MAX_TAG_LEN) { snapped.end = Math.min(snapped.start + MAX_TAG_LEN, text.length); }

        aiTags.push({ categoryId: m.categoryId, name: cat.name, start: snapped.start, end: snapped.end, source: 'ai', confidence: m.confidence });
        console.log('  OK [' + cat.name + '] conf:' + (m.confidence*100).toFixed(0) + '% ['+snapped.start+'-'+snapped.end+'] '+(snapped.end-snapped.start)+' chars');
        const snippet = text.slice(snapped.start, Math.min(snapped.start+100, snapped.end)).replace(/[\r\n]/g,' ').trim();
        console.log('    \"' + snippet + ((snapped.end-snapped.start)>100?'...':'') + '\"');
      }

      console.log('');
      console.log('=== RESULT: ' + aiTags.length + ' tags ===');

      if (aiTags.length === 0) {
        console.log('NO TAGS! Raw AI response:');
        console.log((d?.message?.content||'').slice(0,800));
      }

    } catch(e) {
      console.log('PARSE ERROR: ' + e.message);
      console.log('Raw: ' + (d?.message?.content||'').slice(0,600));
    }
  }).catch(e => console.error('FETCH ERROR: ' + e.message));
