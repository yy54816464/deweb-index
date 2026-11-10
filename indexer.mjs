#!/usr/bin/env node
/**
 * DeWEB indexer for GitHub Actions.
 * Reads SiteRegistry FileSet logs + container.token() and writes:
 *   public/site-index.json
 *   data/state.json
 *
 * No private key. Etherscan V2 when ETHERSCAN_API_KEY is set; public RPC fallback.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const STATE_FILE = path.join(DATA, 'state.json');
const INDEX_FILE = path.join(PUBLIC, 'site-index.json');
const CHAINS = {
  bsc: {
    key:'bsc', chainId:56, area:null, start:120000000,
    registry:'0xd006ffdd5ae313b17729621a00999cd3c71ce5e6',
    factory:'0x68224f668083c29e9800be2a646d42d18cedf7e2',
    rpcs:['https://bsc-rpc.publicnode.com','https://bsc-dataseed.bnbchain.org','https://56.rpc.thirdweb.com','https://bsc-mainnet.public.blastapi.io']
  },
  xlayer: {
    key:'xlayer', chainId:196, area:2, start:70000000,
    registry:'0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6',
    factory:'0x1f09daefa827f02cbb40967cc91b259763760761',
    rpcs:['https://rpc.xlayer.tech','https://xlayerrpc.okx.com','https://xlayer.drpc.org','https://196.rpc.thirdweb.com']
  }
};
const FILE_SET_TOPIC='0x13b9b0f05b22c496a9d9a29e7041c56c04670dc98ab327448870f18eb07b6773';
const SEL={cpuCount:'0xa94da8a7',cpuAt:'0x4bc7cbbd',name:'0x06fdde03',token:'0xfc0c546a'};
if (process.env.BSC_RPC_URL) CHAINS.bsc.rpcs.unshift(process.env.BSC_RPC_URL);
if (process.env.XLAYER_RPC_URL) CHAINS.xlayer.rpcs.unshift(process.env.XLAYER_RPC_URL);
const EXTRA_CPU = {
  bsc: {
    '0x648ac770ce961148ae6e9f4c8d1e62758987e26d': 474,
    '0xc38c95899cd21522ef5db37cd6be4cb422cef58a': 1188
  }
};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const ES_KEY = String(process.env.ETHERSCAN_API_KEY || '').trim();
const ES_BASE = 'https://api.etherscan.io/v2/api';
if (process.env.GITHUB_ACTIONS && !ES_KEY){
  console.error('ETHERSCAN_API_KEY is missing in GitHub Actions secrets.');
  process.exit(1);
}
let esLast = 0;
async function esThrottle(){
  const wait = Math.max(0, 400 - (Date.now() - esLast));
  if (wait) await sleep(wait);
  esLast = Date.now();
}
async function esQuery(net, params){
  await esThrottle();
  const u = new URL(ES_BASE);
  u.searchParams.set('chainid', String(net.chainId));
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (ES_KEY) u.searchParams.set('apikey', ES_KEY);
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('Etherscan HTTP ' + r.status);
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.message || 'Etherscan error');
  if (j && j.status === '0'){
    if (/no records|no logs|not found/i.test(String(j.message || ''))) return [];
    const detail = j.result != null ? String(j.result) : '';
    throw new Error(String(j.message || 'Etherscan status 0') + (detail ? ': ' + detail : ''));
  }
  return j ? j.result : null;
}
const arg=(name,def)=>process.env[name]??def;

function load(file, fallback){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){return fallback;} }
function save(file,obj){ fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(obj,null,2)); }
function hex(n){ return '0x'+BigInt(n).toString(16); }
function pad(h){ return String(h).replace(/^0x/,'').padStart(64,'0'); }
function addr(h){ const b=String(h||'').replace(/^0x/,''); return b.length>=40?'0x'+b.slice(-40):''; }
function word(h,i){ const b=String(h||'').replace(/^0x/,''); return '0x'+b.slice(i*64,(i+1)*64); }
function uint(h){ try{return BigInt(h);}catch(e){return null;} }
function decodeString(h){
  try{
    const b=String(h||'').replace(/^0x/,''); if(b.length<128)return '';
    const len=Number(BigInt('0x'+b.slice(64,128))); if(!len||len>200)return '';
    const a=new Uint8Array(len); for(let i=0;i<len;i++)a[i]=parseInt(b.substr(128+i*2,2),16);
    return new TextDecoder().decode(a).trim();
  }catch(e){return '';}
}
function stateFor(state,net){
  state.chains ||= {};
  const s=state.chains[net.key] ||= {cursor:0,cpu:{next:0,count:0,map:{},filled:{}},names:{},pending:{},sites:{}};
  s.cpu ||= {next:0,count:0,map:{},filled:{}}; s.cpu.filled ||= {}; s.names ||= {}; s.pending ||= {}; s.sites ||= {};
  return s;
}
let turn = {};
async function rpc(net, method, params){
  let last;
  for(let a=0;a<net.rpcs.length;a++){
    const u=net.rpcs[(a+(turn[net.key]||0))%net.rpcs.length];
    try{
      const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method,params:params||[]})});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json();
      if(j.error) throw new Error(j.error.message||'rpc error');
      turn[net.key]=(turn[net.key]||0)+1;
      return j.result;
    }catch(e){ last=e; await sleep(120); }
  }
  throw last || new Error('rpc unavailable');
}
async function rpcBatch(net,calls){
  const out=[]; const size=10;
  for(let i=0;i<calls.length;i+=size){
    const part=calls.slice(i,i+size);
    let done=null;
    for(let a=0;a<net.rpcs.length && !done;a++){
      try{
        const r=await fetch(net.rpcs[(a+(turn[net.key]||0))%net.rpcs.length],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(part.map((c,n)=>({jsonrpc:'2.0',id:n+1,method:'eth_call',params:[{to:c.to,data:c.data},'latest']}))) });
        if(!r.ok) continue;
        const j=await r.json();
        if(!Array.isArray(j)) continue;
        j.sort((x,y)=>x.id-y.id);
        done=j.map(x=>x.result||null);
      }catch(e){}
    }
    if(!done) done=part.map(()=>null);
    out.push(...done);
    await sleep(100);
  }
  return out;
}
async function ensureCpu(net,st){
  for (const [addr,idx] of Object.entries(EXTRA_CPU[net.key] || {})) {
    st.cpu.map[addr] = idx;
    st.cpu.filled[idx] = 1;
  }
  const count=Number(uint(await rpc(net,'eth_call',[{to:net.factory,data:SEL.cpuCount},'latest'])))||st.cpu.count||0;
  st.cpu.count=count;
  const limit=Math.min(count, Number(arg('CPU_MAX','1490')));
  const priority=String(arg('CPU_PRIORITY','')).split(',').map(x=>Number(x)).filter(x=>Number.isInteger(x)&&x>=0&&x<limit);
  const order=[];
  const seen={};
  for(const i of priority){ if(!seen[i]){ seen[i]=1; order.push(i); } }
  for(let i=0;i<limit;i++){ if(!seen[i] && !st.cpu.filled[i]){ seen[i]=1; order.push(i); } }
  const missing=order;
  for(let i=0;i<missing.length;i+=40){
    const part=missing.slice(i,i+40);
    const res=await rpcBatch(net,part.map(n=>({to:net.factory,data:SEL.cpuAt+pad(n)})));
    res.forEach((r,j)=>{ const a=addr(r); if(a && !/^0x0{40}$/.test(a)){ st.cpu.map[a.toLowerCase()]=part[j]; st.cpu.filled[part[j]]=1; } });
    await sleep(100);
  }
  return count;
}
async function getLogs(net,from,to){
  const out=[]; const span=1000;
  for(let f=from;f<=to;f+=span){
    const t=Math.min(to,f+span-1);
    if (ES_KEY){
      let page=1;
      while (true){
        let rows;
        try {
          rows=await esQuery(net,{module:'logs',action:'getLogs',address:net.registry,topic0:FILE_SET_TOPIC,fromBlock:f,toBlock:t,page:page,offset:1000});
        } catch(e){
          // Etherscan free keys can reject a range or be rate-limited.
          // Fall back to the public RPC for this window rather than failing.
          try{
            rows=await rpc(net,'eth_getLogs',[{address:net.registry,fromBlock:hex(f),toBlock:hex(t),topics:[FILE_SET_TOPIC]}]);
          }catch(e2){
            if (t>f){
              const mid=Math.floor((f+t)/2);
              out.push(...await getLogs(net,f,mid));
              out.push(...await getLogs(net,mid+1,t));
              rows=null;
              break;
            }
            throw e2;
          }
        }
        if (!Array.isArray(rows) || !rows.length) break;
        out.push(...rows);
        if (rows.length < 1000) break;
        page++;
        if (page > 20) break;
      }
    } else {
      try{ out.push(...(await rpc(net,'eth_getLogs',[{address:net.registry,fromBlock:hex(f),toBlock:hex(t),topics:[FILE_SET_TOPIC]}]))); }
      catch(e){ await sleep(500); }
    }
  }
  return out;
}
async function scan(net,st,from,to){
  const logs=await getLogs(net,from,to);
  for(const l of logs){
    const c=addr(l.topics&&l.topics[1]); if(!c) continue;
    const k=c.toLowerCase(); if(!st.pending[k]) st.pending[k]={to:c,count:0}; st.pending[k].count++;
  }
  const keys=Object.keys(st.pending).slice(0,180);
  if(keys.length){
    const tokens=await rpcBatch(net,keys.map(k=>({to:st.pending[k].to,data:SEL.token})));
    const wanted=[];
    tokens.forEach((r,i)=>{
      const chainId=uint(word(r,0)), cpu=addr(word(r,1)), tokenId=uint(word(r,2));
      if(chainId===null||tokenId===null||Number(chainId)!==net.chainId) return;
      const ci=st.cpu.map[(cpu||'').toLowerCase()];
      if(ci===undefined) return;
      wanted.push({k:keys[i],cpu,ci,tokenId:Number(tokenId)});
    });
    const addrs=[...new Set(wanted.map(w=>w.cpu.toLowerCase()))].filter(a=>!st.names[a]);
    if(addrs.length){
      const names=await rpcBatch(net,addrs.map(a=>({to:a,data:SEL.name})));
      addrs.forEach((a,i)=>{ st.names[a]=decodeString(names[i])||''; });
    }
    for(const w of wanted){
      const nm=net.area===null?(w.tokenId+'.'+w.ci+'.tape'):(w.tokenId+'.'+net.area+'.'+w.ci+'.tape');
      const sub=net.area===null?(w.tokenId+'-'+w.ci):(w.tokenId+'-'+net.area+'-'+w.ci);
      st.sites[nm]={name:nm,sub,chain:net.key,tokenId:w.tokenId,cpuIdx:w.ci,area:net.area,
        cpuName:st.names[w.cpu.toLowerCase()]||('CPU '+w.ci),files:st.pending[w.k].count,
        title:(st.names[w.cpu.toLowerCase()]||('CPU '+w.ci))+' · #'+w.tokenId,
        url:'https://'+sub+'.tapekit.org/'};
      delete st.pending[w.k];
    }
  }
  st.cursor=Math.max(st.cursor||0,to);
}
async function main(){
  fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(PUBLIC,{recursive:true});
  const state=load(STATE_FILE,{updatedAt:null,chains:{}});
  const index=load(INDEX_FILE,{updatedAt:null,count:0,sites:[]});
  const window=Number(arg('SCAN_WINDOW','100000'));
  const chains=(arg('CHAINS','bsc')||'bsc').split(',').map(s=>s.trim()).filter(Boolean);
  for(const key of chains){
    const net=CHAINS[key]; if(!net) continue;
    const st=stateFor(state,net);
    console.log('['+key+'] syncing cpu...');
    const count=await ensureCpu(net,st);
    const latest=Number(uint(await rpc(net,'eth_blockNumber',[])));
    let from=Number(arg('FROM_BLOCK','0'))||0;
    if(!from) from=st.cursor?st.cursor+1:net.start;
    let to=Math.min(latest, from+window-1);
    if(from>latest){ from=Math.max(net.start,latest-2000); to=latest; }
    console.log('['+key+'] logs '+from+'..'+to+' cpu='+Object.keys(st.cpu.map).length+'/'+count);
    await scan(net,st,from,to);
    state.updatedAt=new Date().toISOString();
    state.chains[key]=st;
    save(STATE_FILE,state);
    console.log('['+key+'] sites='+Object.keys(st.sites).length+' pending='+Object.keys(st.pending).length);
  }
  const sites=[];
  for(const key of Object.keys(state.chains||{})) for(const site of Object.values(state.chains[key].sites||{})) sites.push(site);
  sites.sort((a,b)=>b.files-a.files||a.name.localeCompare(b.name));
  const featured=load(path.join(DATA,'featured.json'),[]);
  const out={updatedAt:new Date().toISOString(),count:sites.length,sites,featured:Array.isArray(featured)?featured:[]};
  save(INDEX_FILE,out);
  console.log('WROTE '+INDEX_FILE+' count='+sites.length);
}
main().catch(e=>{ console.error(e); process.exit(1); });
