const fs = require('fs');
const text = fs.readFileSync('D:/AI/ch18.txt','utf-8');
const kb = JSON.parse(fs.readFileSync('D:/AI/long-novel-gpt/提示词/prompt_knowledge_base.json','utf-8'));
const cats = kb.categories;

const catalog = cats.map(c => {
  const kws = c.synonyms.slice(0,8).join(',');
  if (c.bootstrap) {
    const b = c.bootstrap;
    return 'id='+c.id+'='+c.name+' | entry:'+b.entry_conditions+' | signals:'+(b.confirm_signals||[]).slice(0,5).join(',')+' | kw:'+kws;
  }
  return 'id='+c.id+'='+c.name+' | kw:'+kws;
}).join('\n');

const system = '你是小说场景分析助手。根据场景清单，分析章节文本，识别所有可匹配的场景。\n\n规则：\n1. 对每个匹配的场景，用 > 引用原文的完整段落（≥60字连续原文），不得改写或总结\n2. 标注场景名称和置信度\n3. 同一类别最多1个最长段落\n4. 总共不超过5个\n5. 忽略境界/修为/状态栏等元数据\n\n输出格式示例：\n### 丝袜足交场景 (置信度:0.95)\n> 看着搭在腿上的玉足，陈墨一时有些愣神。难道这就是娘娘给他的奖励？感动……根本不敢动啊！';

const body = JSON.stringify({
  model: 'huihui_ai/gemma-4-abliterated:e2b', stream: false,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'catalog:\n'+catalog+'\n\nallowed:'+JSON.stringify(cats.map(c=>c.id))+'\n\ntext:\n'+text }
  ],
  temperature: 0.7, max_tokens: 3000
});

function locate(evidence, fullText) {
  let idx = fullText.indexOf(evidence);
  if (idx===-1) {
    const nE=evidence.replace(/[\s\r\n\u3000]+/g,''), nT=fullText.replace(/[\s\r\n\u3000]+/g,'');
    idx=nT.indexOf(nE);
    if(idx!==-1){let op=0,np=0;while(np<idx&&op<fullText.length){if(/[\s\r\n\u3000]/.test(fullText[op]))op++;else{op++;np++;}}idx=op;}
  }
  if(idx===-1){for(let w=Math.min(40,evidence.length);w>=15;w-=5){for(let k=0;k<=evidence.length-w;k++){const p=fullText.indexOf(evidence.slice(k,k+w));if(p!==-1){idx=p;break;}}if(idx!==-1)break;}}
  return idx;
}

console.log('=== AI EVIDENCE vs ORIGINAL TEXT VERIFICATION ===\n');

fetch('http://localhost:11434/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body})
.then(r=>r.json()).then(d=>{
  const aiOutput = d?.message?.content;
  const sections = aiOutput.split(/^###\s*/m).filter(Boolean);

  let matchCount = 0;
  let errorCount = 0;

  for (const section of sections) {
    const lines = section.split('\n');
    const heading = lines[0].trim();
    const nm = heading.match(/^(.+?)\s*[(（]\s*置信度?\s*[:：]\s*([0-9.]+)\s*[)）]/);
    if (!nm) continue;
    const sceneName = nm[1].trim();
    const confidence = parseFloat(nm[2]);

    // Fuzzy match category
    let cat = cats.find(c => c.name === sceneName);
    if (!cat) cat = cats.find(c => sceneName.includes(c.name) || c.name.includes(sceneName));
    if (!cat) cat = cats.find(c => sceneName.length>=4&&c.name.length>=4&&sceneName.slice(0,4)===c.name.slice(0,4));

    const evLines = [];
    for (let i=1;i<lines.length;i++) {
      const l=lines[i].trim();
      if(l.startsWith('>')) evLines.push(l.replace(/^>\s*/,''));
      else if(evLines.length>0) break;
    }
    const evidence = evLines.join('');

    if (!evidence || evidence.length < 12) {
      console.log('SKIP ['+sceneName+']: evidence too short ('+evidence.length+' chars)');
      continue;
    }

    matchCount++;
    console.log('--- Match #'+matchCount+': ['+sceneName+'] conf:'+confidence+' evidence:'+evidence.length+' chars ---');

    // VERIFY: Does evidence exist in original?
    const idx = locate(evidence, text);

    if (idx >= 0) {
      // Show the evidence side by side with original
      console.log('  LOCATED at position '+idx);
      console.log('  Evidence:  \"'+evidence.slice(0,120).replace(/[\r\n]/g,' ')+ (evidence.length>120?'…':'')+'\"');
      console.log('  Original:  \"'+text.slice(idx, Math.min(idx+120, text.length)).replace(/[\r\n]/g,' ')+ (evidence.length>120?'…':'')+'\"');

      // Check if evidence matches original character by character
      const origSlice = text.slice(idx, idx + Math.min(evidence.length, 200));
      if (origSlice.replace(/[\s\r\n\u3000]+/g,'') === evidence.replace(/[\s\r\n\u3000]+/g,'')) {
        console.log('  VERDICT: ✓ MATCH (whitespace-normalized)');
      } else {
        console.log('  VERDICT: ✗ MISMATCH - characters differ');
        errorCount++;
      }
    } else {
      console.log('  LOCATE: ✗ NOT FOUND in original text');
      console.log('  Evidence: \"'+evidence.slice(0,100)+'\"');
      // Try to find any substring
      let anyFound = false;
      for (let i=0; i<evidence.length-5; i++) {
        const sub = evidence.slice(i, i+5);
        if (text.includes(sub)) {
          console.log('  Partial match: \"'+sub+'\" at position '+text.indexOf(sub));
          anyFound = true;
          break;
        }
      }
      if (!anyFound) console.log('  VERDICT: ✗ HALLUCINATION - no substring found in text');
      errorCount++;
    }
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log('Total matches: ' + matchCount);
  console.log('Errors: ' + errorCount + ' (hallucinations or mismatches)');
  console.log('Success rate: ' + ((matchCount-errorCount)/matchCount*100).toFixed(0) + '%');
}).catch(e => console.error(e.message));
