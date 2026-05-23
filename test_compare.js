const fs = require('fs');
const text = fs.readFileSync('D:/AI/ch18.txt','utf-8');
const kb = JSON.parse(fs.readFileSync('D:/AI/long-novel-gpt/提示词/prompt_knowledge_base.json','utf-8'));
const cats = kb.categories;
const catalog = cats.map(c => {
  const k = c.synonyms.slice(0,8).join(',');
  if (c.bootstrap) {
    const b = c.bootstrap;
    return 'id='+c.id+'='+c.name+'|entry:'+b.entry_conditions+'|sig:'+(b.confirm_signals||[]).slice(0,5).join(',')+'|kw:'+k;
  }
  return 'id='+c.id+'='+c.name+'|kw:'+k;
}).join('\n');

const sys = '从原文逐字完整复制连续段落(>=60字)，不得改写。格式:### 场景名 (置信度:0.x)\n> 原文段落';
const body = JSON.stringify({
  model: 'huihui_ai/gemma-4-abliterated:e2b', stream: false,
  messages: [
    { role: 'system', content: sys },
    { role: 'user', content: 'catalog:\n'+catalog+'\n\nallowed:'+JSON.stringify(cats.map(c=>c.id))+'\n\ntext:\n'+text }
  ],
  temperature: 0.7, max_tokens: 3000
});

function locate(e,t) {
  let i = t.indexOf(e);
  if (i===-1) {
    const nE=e.replace(/[\s\r\n\u3000]+/g,''), nT=t.replace(/[\s\r\n\u3000]+/g,'');
    i = nT.indexOf(nE);
    if (i!==-1) {
      let a=0,b=0;
      while(b<i&&a<t.length) { if(/[\s\r\n\u3000]/.test(t[a]))a++;else{a++;b++} }
      i=a;
    }
  }
  if (i===-1) {
    for(let w=Math.min(40,e.length);w>=10;w-=5) {
      for(let k=0;k<=e.length-w;k++) {
        const p=t.indexOf(e.slice(k,k+w));
        if(p!==-1){i=p;break;}
      }
      if(i!==-1)break;
    }
  }
  return i;
}

function snapSent(s,e,t,w) {
  const S=/[。！？\n]/;
  let a=s; for(let k=0;k<w&&a>0;k++,a--) { if(S.test(t[a-1])) break; }
  let b=e; for(let k=0;k<w&&b<t.length;k++,b++) { if(S.test(t[b])) { b++; break; } }
  return {start:a, end:b};
}

console.log('=== COMPARISON: System vs 2.txt ===\n');
console.log('2.txt scenes (expected): 丝袜足交, 按摩, 张力增强, 私密接触\n');

fetch('http://localhost:11434/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},body})
.then(r=>r.json()).then(d=>{
  const raw = d?.message?.content || '';
  console.log('--- RAW AI OUTPUT ---');
  console.log(raw);
  console.log('--- PARSED ---\n');

  const sections = raw.split(/^###\s*/m).filter(Boolean);
  let ok = 0;

  for (const sec of sections) {
    const lines = sec.split('\n');
    const heading = lines[0].trim();
    const nm = heading.match(/^(.+?)\s*[(（]\s*置信度?\s*[:：]\s*([0-9.]+)\s*[)）]/);
    if (!nm) { console.log('SKIP: no match for heading "'+heading.slice(0,40)+'"'); continue; }

    let cat = cats.find(c => c.id === nm[1].trim());
    if (!cat) cat = cats.find(c => c.name === nm[1].trim());
    if (!cat) cat = cats.find(c => nm[1].includes(c.name) || c.name.includes(nm[1]));
    if (!cat) { console.log('SKIP: unknown scene "'+nm[1].trim()+'"'); continue; }

    const ev = [];
    for (let i=1;i<lines.length;i++) {
      const l = lines[i].trim();
      if (l.startsWith('>')) ev.push(l.replace(/^>\s*/,''));
      else if (ev.length > 0) break;
    }
    const evidence = ev.join('');
    if (!evidence || evidence.length < 12) { console.log('SKIP '+cat.name+': short ev'); continue; }

    const idx = locate(evidence, text);
    if (idx < 0) { console.log('FAIL '+cat.name+': locate fail'); continue; }

    const snapped = snapSent(idx, idx+evidence.length, text, 60);
    if (snapped.end-snapped.start < 12 || snapped.end-snapped.start > 250) {
      console.log('SKIP '+cat.name+': bad range '+(snapped.end-snapped.start)); continue;
    }

    ok++;
    const tag = text.slice(snapped.start, Math.min(snapped.start+160, snapped.end)).replace(/[\r\n]/g,' ').trim();
    console.log('✓ ['+cat.name+'] ['+snapped.start+'-'+snapped.end+'] '+(snapped.end-snapped.start)+'字');
    console.log('  '+tag+'\n');
  }

  // Compare with 2.txt
  const found = new Set();
  for (const sec of sections) {
    const nm = (sec.split('\n')[0]||'').match(/^(.+?)\s*[(（]/);
    if (nm) {
      let cat = cats.find(c => c.id === nm[1].trim() || c.name === nm[1].trim());
      if (cat) found.add(cat.name);
    }
  }

  const expected = ['丝袜足交场景', '按摩场景', '张力增强场景', '私密接触场景'];
  console.log('--- COMPARISON ---');
  for (const e of expected) {
    const match = found.has(e) ? '✓ MATCH' : '✗ MISSING';
    console.log('  '+e+': '+match);
  }

  console.log('\nAccepted: '+ok+' tags');
}).catch(e => console.error(e.message));
