import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';

// Optional development tool: runtime extension files have no npm dependencies.
let puppeteer;
try {
  ({default:puppeteer}=await import(process.env.PUPPETEER_MODULE || 'puppeteer-core'));
} catch (error) {
  throw new Error('UI smoke tests require the optional puppeteer-core package. Install it locally or set PUPPETEER_MODULE to its module path.', {cause:error});
}
const root=fileURLToPath(new URL('..',import.meta.url));
const firefoxExecutable=process.env.FIREFOX_BIN || (process.platform==='darwin'
  ? '/Applications/Firefox.app/Contents/MacOS/firefox'
  : '/usr/bin/firefox');
if(!existsSync(firefoxExecutable)) throw new Error(`Firefox was not found at ${firefoxExecutable}. Set FIREFOX_BIN to your Firefox executable.`);
const servedFiles=new Set(['popup.html','popup.js','popup.css','popup-input.js','history-search.js','favicon-cache.js','shortcut-settings.js','popup-tabs.js','core.js','preview.js','icons/icon.svg']);
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/fixture/')){
    const title=url.pathname.includes('atlas')?'Atlas Design':url.pathname.includes('notes')?'Atlas Notes':'Fixture';
    res.writeHead(200,{'Content-Type':'text/html'}).end(`<title>${title}</title><h1>${title}</h1>`);return;
  }
  try{
    const file=url.pathname==='/'?'popup.html':url.pathname.slice(1);
    if(!servedFiles.has(file)){res.writeHead(404).end();return;}
    const data=await readFile(join(root,file));
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html'}).end(data);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const errors=[];
const remoteRequests=[];
let passed=0;
function pass(name){passed++;console.log('PASS',name);}
function mutations(calls){return calls.filter(call=>['create','update','remove','search'].includes(call[0]));}

async function openCase({contextUrl,shortcut,failShortcutUpdate=false,favicon,cachedIcons=[],historyItems=[],deferHistory=false,failHistory=false}={}){
  const page=await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))remoteRequests.push(request.url());});
  await page.evaluateOnNewDocument((origin,options)=>{
    const {contextUrl,shortcut}=options;
    const records=new Map([
      [10,{id:10,windowId:1,active:true,status:'complete',title:'Current fixture',url:contextUrl??origin+'/fixture/current',lastAccessed:100}],
      [20,{id:20,windowId:1,active:false,title:'Atlas Design',url:origin+'/fixture/atlas?view=design#draft',lastAccessed:90}],
      [21,{id:21,windowId:1,active:false,title:'Atlas Notes',url:origin+'/fixture/notes',lastAccessed:80}],
      [30,{id:30,windowId:2,active:true,title:'Atlas foreign window',url:origin+'/fixture/foreign',lastAccessed:200}],
    ]);
    if(options.favicon)records.get(20).favIconUrl=options.favicon;
    const calls=[];
    const events={};
    let nextId=100;
    const copy=value=>JSON.parse(JSON.stringify(value));
    const event=name=>{
      const listeners=new Set();events[name]=listeners;
      return {addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)};
    };
    const storage=(initial={},scope='session')=>{
      const data=copy(initial);
      return {async get(key){return typeof key==='string'?{[key]:copy(data[key]??null)}:copy(data);},async set(values){Object.assign(data,copy(values));},async remove(key){calls.push(['storage-remove',scope,copy(key)]);for(const name of Array.isArray(key)?key:[key])delete data[name];},snapshot(){return copy(data);}};
    };
    const isMac=/Mac|iPhone|iPad/.test(navigator.platform);
    const defaultShortcut=isMac?'Command+Shift+K':/^Win/.test(navigator.platform)?'Ctrl+Shift+K':'Ctrl+Shift+Space';
    let currentShortcut=shortcut??defaultShortcut;
    const api={
      runtime:{id:'input-commit-smoke@test'},
      tabs:{
        async query(query){calls.push(['query',copy(query)]);return [...records.values()].filter(tab=>tab.windowId===(query.currentWindow?1:query.windowId)&&(!query.active||tab.active)).map(copy);},
        async get(id){calls.push(['get',id]);if(!records.has(id))throw new Error('Tab closed');return copy(records.get(id));},
        async update(id,properties){calls.push(['update',id,copy(properties)]);const tab=records.get(id);if(!tab)throw new Error('Tab closed');if(properties.active)for(const existing of records.values())if(existing.windowId===tab.windowId)existing.active=false;Object.assign(tab,properties);return copy(tab);},
        async create(properties){calls.push(['create',copy(properties)]);const tab={id:nextId++,...properties};if(tab.active)for(const existing of records.values())if(existing.windowId===tab.windowId)existing.active=false;records.set(tab.id,tab);return copy(tab);},
        async remove(id){calls.push(['remove',id]);records.delete(id);},
        onCreated:event('created'),onUpdated:event('updated'),onRemoved:event('removed'),onActivated:event('activated'),onMoved:event('moved'),onAttached:event('attached'),onDetached:event('detached'),onReplaced:event('replaced'),
      },
      search:{async get(){calls.push(['search-get']);throw new Error('The popup must not enumerate Firefox search engines');},async search(properties){calls.push(['search',copy(properties)]);records.get(properties.tabId).url=origin+'/fixture/search?q='+encodeURIComponent(properties.query);}},
      storage:{local:storage({searchEngine:'Legacy engine',...(options.cachedIcons.length?{faviconCacheV1:options.cachedIcons}:{})},'local'),session:storage()},
      windows:{async update(){throw new Error('Native popup should not focus another window');}},
      commands:{
        async getAll(){calls.push(['commands-getAll']);return [{name:'_execute_action',shortcut:currentShortcut}];},
        async update(details){calls.push(['commands-update',copy(details)]);if(details.name!=='_execute_action')throw new Error('Only the popup command may change');if(window.__popupFake.failShortcutUpdate)throw new Error('Fixture save failure');currentShortcut=details.shortcut;},
        async reset(name){calls.push(['commands-reset',name]);if(name!=='_execute_action')throw new Error('Only the popup command may reset');currentShortcut=defaultShortcut;},
      },
      history:{
        async search(query){
          calls.push(['history-search',copy(query)]);
          if(options.failHistory)throw new Error('Fixture history failure');
          const terms=query.text.toLowerCase().split(/\s+/);
          const items=copy(window.__popupFake.historyItems).filter(item=>terms.every(term=>`${item.title} ${item.url}`.toLowerCase().includes(term)));
          if(options.deferHistory)return new Promise(resolve=>window.__popupFake.pendingHistory.push({query:query.text,resolve:()=>resolve(items)}));
          return items;
        },
        onVisited:event('historyVisited'),onVisitRemoved:event('historyRemoved'),
      },
    };
    Object.defineProperty(window,'browser',{value:api,configurable:true});
    Object.defineProperty(window,'close',{value:()=>calls.push(['close']),configurable:true});
    window.__popupFake={
      calls,
      isMac,defaultShortcut,
      failShortcutUpdate:options.failShortcutUpdate,
      currentShortcut:()=>currentShortcut,
      localData:()=>api.storage.local.snapshot(),
      historyItems:copy(options.historyItems),pendingHistory:[],
      resolveHistory(query){const request=this.pendingHistory.find(item=>item.query===query&&!item.resolved);if(!request)throw new Error('No pending history query');request.resolved=true;request.resolve();},
      removeHistory(url){this.historyItems=this.historyItems.filter(item=>item.url!==url);for(const listener of events.historyRemoved)listener({allHistory:false,urls:[url]});},
      updateTab(id,changes){Object.assign(records.get(id),changes);for(const listener of events.updated)listener(id,copy(changes),copy(records.get(id)));},
      removeTab(id){const tab=records.get(id);records.delete(id);for(const listener of events.removed)listener(id,{windowId:tab.windowId});},
    };
  },origin,{contextUrl,shortcut,failShortcutUpdate,favicon,cachedIcons,historyItems,deferHistory,failHistory});
  await page.goto(origin,{waitUntil:'load',timeout:5000});
  await page.waitForFunction(()=>document.querySelector('#results').getAttribute('aria-busy')==='false');
  assert.equal(await page.$eval('#error',element=>element.textContent),'');
  assert.equal(await page.evaluate(()=>window.__popupFake.calls.some(call=>call[0]==='search-get')),false);
  await page.focus('#query');
  return page;
}
async function typeAtlas(page){
  await page.type('#query','atlas');
  assert.equal(await page.$$eval('[role=option]',rows=>rows.length),3);
  assert.equal(await page.$eval('#query',element=>element.value),'atlas');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.$eval('#query',element=>element.value),origin+'/fixture/notes');
  assert.equal(await page.$eval('[aria-selected=true]',element=>element.textContent.includes('Atlas Notes')),true);
}
async function waitClosed(page){await page.waitForFunction(()=>window.__popupFake.calls.some(call=>call[0]==='close'));}
async function openPreferences(page){
  await page.click('#settings-open');
  await page.waitForFunction(()=>!document.querySelector('#settings').hidden&&!document.querySelector('#shortcut-edit').disabled);
}
async function recordShortcut(page,{key,modifiers}){
  for(const modifier of modifiers)await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for(const modifier of [...modifiers].reverse())await page.keyboard.up(modifier);
}
async function shortcutPlatform(page){
  return page.evaluate(()=>({
    isMac:window.__popupFake.isMac,
    primary:window.__popupFake.isMac?'Meta':'Control',
    defaultShortcut:window.__popupFake.defaultShortcut,
    defaultDisplay:window.__popupFake.isMac?'⇧⌘K':window.__popupFake.defaultShortcut,
    customShortcut:window.__popupFake.isMac?'Command+Shift+U':'Alt+Shift+U',
    customDisplay:window.__popupFake.isMac?'⇧⌘U':'Alt+Shift+U',
  }));
}

try{
  browser=await puppeteer.launch({browser:'firefox',executablePath:firefoxExecutable,headless:true,timeout:15000,protocolTimeout:10000,defaultViewport:{width:1000,height:800}});
  console.log('BROWSER',await browser.version());
  {
    const page=await openCase({historyItems:[
      {title:'Atlas Design',url:origin+'/fixture/atlas?view=design#duplicate',lastVisitTime:100},
      {title:'Atlas Guide',url:origin+'/fixture/guide?token=hidden-secret#private-fragment',lastVisitTime:90},
      {title:'Atlas Guide older fragment',url:origin+'/fixture/guide?token=hidden-secret#older',lastVisitTime:80},
      {title:'Atlas unsafe',url:'javascript:alert(1)',lastVisitTime:70},
    ]});
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='history-search'),[]);
    await page.type('#query','atlas');
    await page.waitForSelector('[data-type=history]');
    assert.deepEqual(await page.$$eval('[role=option]',rows=>rows.map(row=>row.dataset.type)),['tab','tab','history','action']);
    assert.equal(await page.$eval('#results',element=>/hidden-secret|private-fragment/.test(element.textContent)),false);
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='history-search'),[['history-search',{text:'atlas',startTime:0,maxResults:100}]]);
    await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('#query',element=>element.value),origin+'/fixture/guide?token=hidden-secret#private-fragment');
    await page.keyboard.press('ArrowDown');assert.equal(await page.$eval('#query',element=>element.value),'atlas');
    await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');await waitClosed(page);
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[['create',{url:origin+'/fixture/guide?token=hidden-secret#private-fragment',active:true,windowId:1}]]);
    pass('history follows open tabs, removes duplicate/open URLs, hides URL secrets in labels, and opens its selected destination');await page.close();
  }
  for(const contextUrl of [undefined,'about:newtab','about:home']){
    const url='https://museum.example/collection';
    const favicon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGNgoBpIuP+fJDy4DcAFSDIA3Ub6G4Du9JHuApKjceBTInkGkAkAV12tBMUMrdIAAAAASUVORK5CYII=';
    const page=await openCase({contextUrl,historyItems:[{title:'Museum collection',url,lastVisitTime:100}],cachedIcons:[{origin:'https://museum.example',icon:favicon}]});
    await page.type('#query','museum');await page.waitForSelector('[data-type=history]');
    assert.equal(await page.$eval('[aria-selected=true]',element=>element.dataset.type),'history');
    assert.equal(await page.$eval('#query',element=>element.value),'museum');
    await page.waitForFunction(()=>document.querySelector('#query-icon img')?.naturalWidth>0&&document.querySelector('[data-type=history] .site-icon img')?.naturalWidth>0);
    await page.keyboard.press('Enter');await waitClosed(page);
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),contextUrl
      ? [['update',10,{url}]]:[['create',{url,active:true,windowId:1}]]);
    pass(`Enter opens a cached-icon history result from ${contextUrl??'an ordinary page'} with the correct tab reuse`);await page.close();
  }
  {
    const page=await openCase({deferHistory:true,historyItems:[{title:'Atlas guide',url:'https://atlas.example/guide'},{title:'Museum guide',url:'https://museum.example/guide'}]});
    await page.type('#query','atlas');await page.waitForFunction(()=>window.__popupFake.pendingHistory.some(item=>item.query==='atlas'));
    await page.click('#clear');await page.type('#query','museum');await page.waitForFunction(()=>window.__popupFake.pendingHistory.some(item=>item.query==='museum'));
    await page.evaluate(()=>window.__popupFake.resolveHistory('museum'));await page.waitForSelector('[data-type=history]');
    await page.evaluate(()=>window.__popupFake.resolveHistory('atlas'));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await page.$eval('[data-type=history]',element=>element.textContent.includes('Museum guide')),true);
    assert.equal(await page.$eval('#query',element=>element.value),'museum');
    pass('a slow old history query cannot replace the newest query or its results');await page.close();
  }
  {
    const page=await openCase({deferHistory:true,historyItems:[{title:'Museum guide',url:'https://museum.example/guide'}]});
    await page.type('#query','museum');await page.waitForFunction(()=>window.__popupFake.pendingHistory.some(item=>item.query==='museum'));
    await page.keyboard.press('ArrowDown');
    await page.evaluate(()=>window.__popupFake.resolveHistory('museum'));await page.waitForSelector('[data-type=history]');
    assert.equal(await page.$eval('[aria-selected=true]',element=>element.dataset.type),'action');
    assert.equal(await page.$eval('#query',element=>element.value),'museum');
    pass('arriving history results preserve an explicit keyboard selection of web search');await page.close();
  }
  {
    const url='https://museum.example/guide';
    const page=await openCase({historyItems:[{title:'Museum guide',url}]});
    await page.type('#query','museum');await page.waitForSelector('[data-type=history]');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowUp');
    await page.evaluate(url=>window.__popupFake.removeHistory(url),url);
    assert.equal(await page.$('[data-type=history]'),null);
    assert.equal(await page.$('[aria-selected=true]'),null);
    await page.keyboard.press('Enter');
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[]);
    assert.match(await page.$eval('#error',element=>element.textContent),/history result is no longer available/);
    pass('deleting a selected history result removes it immediately and blocks accidental replacement commits');await page.close();
  }
  {
    const page=await openCase({failHistory:true});
    await page.type('#query','museum');await page.waitForFunction(()=>document.querySelector('#error').textContent==='History could not be loaded.');
    await page.keyboard.press('Enter');await waitClosed(page);
    assert.equal(mutations(await page.evaluate(()=>window.__popupFake.calls)).find(call=>call[0]==='search')[1].query,'museum');
    pass('a history API failure leaves web search and tab actions usable');await page.close();
  }
  {
    const favicon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGNgoBpIuP+fJDy4DcAFSDIA3Ub6G4Du9JHuApKjceBTInkGkAkAV12tBMUMrdIAAAAASUVORK5CYII=';
    const page=await openCase({favicon});
    await page.type('#query','Atlas Design');
    await page.waitForFunction(()=>document.querySelector('#query-icon img')?.naturalWidth>0);
    assert.equal(await page.$eval('#query-icon img',image=>image.src),favicon);
    assert.equal(await page.$eval('[role=option] .site-icon img',image=>image.src),favicon);
    assert.equal(await page.$eval('[role=option] .site-icon img',image=>image.naturalWidth>0),true);
    pass('matching an open tab shows its actual favicon in the input and result row');await page.close();
  }
  for(const encoding of ['base64','url']){
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#ff7139" d="M0 0h16v16H0z"/><script>window.faviconScriptRan=true</script><image href="https://favicon-resource.invalid/tracker.png"/></svg>';
    const favicon=encoding==='base64'?'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'):'data:image/svg+xml,'+encodeURIComponent(svg);
    const page=await openCase({favicon});
    await page.type('#query','Atlas Design');
    await page.waitForFunction(()=>document.querySelector('#query-icon img')?.naturalWidth>0,{timeout:1500});
    assert.equal(await page.$eval('[role=option] .site-icon img',image=>image.naturalWidth>0),true);
    assert.equal(await page.evaluate(()=>window.faviconScriptRan),undefined);
    pass(`Firefox ${encoding} SVG favicons display in the input and matched tab row as non-executable images`);await page.close();
  }
  {
    const favicon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGNgoBpIuP+fJDy4DcAFSDIA3Ub6G4Du9JHuApKjceBTInkGkAkAV12tBMUMrdIAAAAASUVORK5CYII=';
    const page=await openCase({cachedIcons:[{origin:'https://visited.example',icon:favicon}]});
    await page.type('#query','visited.example/another-page');
    await page.waitForFunction(()=>document.querySelector('#query-icon img')?.naturalWidth>0);
    assert.equal(await page.$eval('[role=option] .site-icon img',image=>image.src),favicon);
    pass('a cached previously visited site shows its favicon in both the address input and navigation option');await page.close();
  }
  {
    const page=await openCase({favicon:'data:image/png;base64,aGVsbG8='});
    await page.type('#query','Atlas Design');
    await page.waitForFunction(()=>document.querySelector('#query-icon svg')&&document.querySelector('[role=option] .site-icon svg'));
    assert.equal(await page.$eval('#query-icon',element=>element.dataset.kind),'url');
    await page.keyboard.press('Enter');await waitClosed(page);
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[['update',20,{active:true}]]);
    pass('an invalid favicon falls back to a globe without preventing tab switching');await page.close();
  }
  {
    const favicon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGNgoBpIuP+fJDy4DcAFSDIA3Ub6G4Du9JHuApKjceBTInkGkAkAV12tBMUMrdIAAAAASUVORK5CYII=';
    const page=await openCase({favicon});
    await page.waitForFunction(()=>window.__popupFake.localData().faviconCacheV1?.length>0);
    await page.evaluate(()=>window.__popupFake.removeTab(20));
    await page.waitForFunction(()=>!document.querySelector('#results').textContent.includes('Atlas Design'));
    const cachedIcons=await page.evaluate(()=>window.__popupFake.localData().faviconCacheV1);
    await page.type('#query',origin+'/previously-visited');
    await page.waitForFunction(()=>document.querySelector('#query-icon img')?.naturalWidth>0&&document.querySelector('[role=option] .site-icon img')?.naturalWidth>0);
    assert.equal(await page.$$eval('[role=option]',rows=>rows.length),1);
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[]);
    await page.close();
    const reopened=await openCase({cachedIcons});
    await reopened.type('#query',origin+'/previously-visited');
    await reopened.waitForFunction(()=>document.querySelector('#query-icon img')?.naturalWidth>0&&document.querySelector('[role=option] .site-icon img')?.naturalWidth>0);
    pass('an observed tab icon survives tab closure and a new popup through local storage');await reopened.close();
  }
  {
    const page=await openCase();await typeAtlas(page);await page.keyboard.press('Enter');await waitClosed(page);
    const calls=await page.evaluate(()=>window.__popupFake.calls);
    assert.deepEqual(mutations(calls),[['update',21,{active:true}]]);
    assert.equal(calls.filter(call=>call[0]==='close').length,1);
    pass('plain Enter after arrow URL preview switches selected tab ID, without creating a tab');await page.close();
  }
  {
    const page=await openCase();await typeAtlas(page);await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');await waitClosed(page);
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[['create',{url:origin+'/fixture/notes',active:true,windowId:1}]]);
    pass('CtrlEnter after preview opens displayed URL in exactly one new tab');await page.close();
  }
  {
    const page=await openCase();await typeAtlas(page);await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('#query',element=>element.value),'atlas');
    assert.equal(await page.$eval('[aria-selected=true]',element=>element.dataset.action==='search'),true);
    assert.equal(await page.$eval('[data-action=search] .result-title',element=>element.textContent),'atlas');
    assert.equal(await page.$('[data-action=search] .result-description'),null);
    assert.equal(await page.$('[data-action=search] .result-meta-label'),null);
    await page.keyboard.press('Enter');await waitClosed(page);
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[
      ['create',{url:'about:blank',active:false,windowId:1}],['search',{query:'atlas',tabId:100}],['update',100,{active:true}],
    ]);
    pass('moving back to search action restores and searches original query, not preview URL');await page.close();
  }
  for(const contextUrl of ['about:newtab','about:home','about:blank']){
    const reusable=contextUrl!=='about:blank';
    {
      const page=await openCase({contextUrl});await typeAtlas(page);
      await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');await waitClosed(page);
      const calls=await page.evaluate(()=>window.__popupFake.calls);
      assert.deepEqual(mutations(calls),reusable
        ? [['update',10,{url:origin+'/fixture/notes'}]]
        : [['create',{url:origin+'/fixture/notes',active:true,windowId:1}]]);
      assert.equal(calls.filter(call=>call[0]==='close').length,1);
      pass(reusable
        ? `CtrlEnter from ${contextUrl} reuses the current tab for the displayed URL without creating or removing tabs`
        : 'CtrlEnter from about:blank preserves the original tab and creates one destination tab');await page.close();
    }
    {
      const page=await openCase({contextUrl});await typeAtlas(page);await page.keyboard.press('ArrowDown');
      assert.equal(await page.$eval('#query',element=>element.value),'atlas');
      assert.equal(await page.$eval('[aria-selected=true]',element=>element.dataset.action==='search'),true);
      await page.keyboard.press('Enter');await waitClosed(page);
      const calls=await page.evaluate(()=>window.__popupFake.calls);
      assert.deepEqual(mutations(calls),reusable
        ? [['search',{query:'atlas',tabId:10}]]
        : [['create',{url:'about:blank',active:false,windowId:1}],['search',{query:'atlas',tabId:100}],['update',100,{active:true}]]);
      assert.equal(calls.filter(call=>call[0]==='close').length,1);
      pass(reusable
        ? `search action from ${contextUrl} searches in the current tab without creating or removing tabs`
        : 'search action from about:blank preserves the original tab and creates one destination tab');await page.close();
    }
  }
  {
    const page=await openCase();await typeAtlas(page);
    const rows=await page.$$eval('[role=option]',items=>items.map(item=>item.textContent));
    await page.evaluate(()=>window.__popupFake.updateTab(21,{title:'Atlas Notes updated'}));
    await page.waitForFunction(()=>document.querySelector('[aria-selected=true]')?.textContent.includes('Atlas Notes updated'));
    assert.equal(await page.$eval('#query',element=>element.value),origin+'/fixture/notes');
    assert.equal(await page.$$eval('[role=option]',items=>items.length),rows.length);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('#query',element=>element.value),'atlas');
    pass('async tab refresh preserves preview, filtered result count, and original draft');await page.close();
  }
  {
    const page=await openCase();await page.type('#query','notes');await page.keyboard.press('ArrowUp');
    // With one tab match and an action, Up moves from tab to action; Down returns to tab preview.
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('#query',element=>element.value),origin+'/fixture/notes');
    await page.evaluate(()=>window.__popupFake.removeTab(21));
    await page.waitForFunction(()=>document.querySelectorAll('[role=option]').length===1);
    assert.equal(await page.$eval('#query',element=>element.value),'notes');
    assert.equal(await page.$eval('#query-icon',element=>element.dataset.kind),'search');
    assert.equal(await page.$$eval('[aria-selected=true]',items=>items.length),0);
    assert.match(await page.$eval('#error',element=>element.textContent),/no longer|closed|available|choose/i);
    await page.keyboard.press('Enter');
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');await waitClosed(page);
    assert.equal((await page.evaluate(()=>window.__popupFake.calls)).find(call=>call[0]==='search')[1].query,'notes');
    pass('removed only matching tab restores draft, blocks implicit Enter, then explicit action searches draft');await page.close();
  }
  {
    const page=await openCase();await typeAtlas(page);
    await page.evaluate(()=>window.__popupFake.removeTab(21));
    await page.waitForFunction(()=>document.querySelectorAll('[role=option]').length===2);
    assert.equal(await page.$eval('#query',element=>element.value),'atlas');
    assert.equal(await page.$$eval('[aria-selected=true]',items=>items.length),0);
    assert.equal(await page.$eval('#query',element=>element.dataset.action),'search');
    assert.match(await page.$eval('#error',element=>element.textContent),/no longer|closed|available|choose/i);
    await page.evaluate(()=>window.__popupFake.updateTab(20,{title:'Atlas Design refreshed after removal'}));
    await page.waitForFunction(()=>document.querySelector('#results').textContent.includes('Atlas Design refreshed after removal'));
    assert.equal(await page.$$eval('[aria-selected=true]',items=>items.length),0,'a later refresh must not silently select a replacement after the selected tab vanished');
    await page.keyboard.press('Enter');
    assert.deepEqual(mutations(await page.evaluate(()=>window.__popupFake.calls)),[]);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.$eval('[aria-selected=true]',element=>element.dataset.action==='search'),true);
    await page.keyboard.press('Enter');await waitClosed(page);
    assert.equal((await page.evaluate(()=>window.__popupFake.calls)).find(call=>call[0]==='search')[1].query,'atlas');
    pass('selected removal with remaining matches clears selection and blocks implicit replacement commit');await page.close();
  }
  {
    const page=await openCase({shortcut:'Alt+Shift+8'});const platform=await shortcutPlatform(page);
    await typeAtlas(page);
    const query=await page.$eval('#query',element=>element.value);
    await openPreferences(page);
    assert.equal(await page.$('dialog'),null);
    assert.equal(await page.$eval('#search-view',element=>element.hidden),true);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'settings-close');
    assert.equal(await page.$eval('#shortcut-status',element=>element.hidden),true);
    assert.equal(await page.evaluate(()=>document.querySelector('#settings').getBoundingClientRect().height===document.body.getBoundingClientRect().height),true);
    assert.equal(await page.$eval('#shortcut-current',element=>element.textContent),platform.isMac?'⌥⇧8':'Alt+Shift+8');
    assert.equal(await page.$('#engine'),null);
    assert.deepEqual(await page.evaluate(()=>window.__popupFake.localData()),{});
    const calls=await page.evaluate(()=>window.__popupFake.calls);
    assert(calls.some(call=>call[0]==='commands-getAll'));
    assert.deepEqual(calls.filter(call=>call[0]==='commands-update'||call[0]==='commands-reset'||call[0]==='search-get'),[]);
    assert.deepEqual(calls.filter(call=>call[0]==='storage-remove'),[['storage-remove','local','searchEngine']]);
    await page.click('#settings-close');
    assert.equal(await page.$eval('#settings',element=>element.hidden),true);
    assert.equal(await page.$eval('#search-view',element=>element.hidden),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'query');
    assert.equal(await page.$eval('#query',element=>element.value),query);
    assert.equal(await page.$eval('[aria-selected=true]',element=>element.textContent.includes('Atlas Notes')),true);
    pass('Preferences replaces the search view, reads the current shortcut, and Back restores the query and selection');await page.close();
  }
  {
    const page=await openCase({shortcut:'Alt+Shift+8'});const platform=await shortcutPlatform(page);
    await openPreferences(page);await page.click('#shortcut-edit');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'shortcut-input');
    await page.keyboard.press('Shift');
    assert.equal(await page.$eval('#shortcut-clear',element=>element.hidden),true);
    assert.equal(await page.$eval('#shortcut-edit',element=>element.hidden),true);
    await page.click('#shortcut-cancel');
    assert.equal(await page.$eval('#shortcut-input',element=>element.hidden),true);
    assert.equal(await page.$eval('#shortcut-current',element=>element.textContent),platform.isMac?'⌥⇧8':'Alt+Shift+8');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'shortcut-edit');
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),'Alt+Shift+8');
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='commands-update'||call[0]==='commands-reset'),[]);
    pass('the inline recorder replaces the shortcut field, and Cancel preserves the binding and returns focus to the pencil');await page.close();
  }
  {
    const page=await openCase();const platform=await shortcutPlatform(page);
    await openPreferences(page);await page.click('#shortcut-edit');
    await recordShortcut(page,{key:'U',modifiers:[platform.isMac?'Meta':'Alt','Shift']});
    await page.waitForFunction(display=>document.querySelector('#shortcut-input').hidden&&document.querySelector('#shortcut-current').textContent===display&&!document.querySelector('#shortcut-edit').disabled,{},platform.customDisplay);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'shortcut-edit');
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='commands-update'),[['commands-update',{name:'_execute_action',shortcut:platform.customShortcut}]]);
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),platform.customShortcut);
    assert.match(await page.$eval('#shortcut-status',element=>element.textContent),/saved/i);
    pass('releasing a recorded shortcut saves only _execute_action inline and returns focus to the pencil');
    await page.click('#shortcut-clear');
    await page.waitForFunction(()=>document.querySelector('#shortcut-current').textContent==='Add shortcut'&&!document.querySelector('#shortcut-reset').disabled);
    assert.equal(await page.$eval('#shortcut-clear',element=>element.hidden),true);
    assert.equal(await page.$eval('#shortcut-reset',element=>element.hidden),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'shortcut-reset');
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),'');
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='commands-update').at(-1),['commands-update',{name:'_execute_action',shortcut:''}]);
    pass('the cross clears the real assignment, displays Add shortcut and offers Restore in the same position');
    await page.click('#shortcut-reset');
    await page.waitForFunction(display=>document.querySelector('#shortcut-current').textContent===display&&!document.querySelector('#shortcut-edit').disabled,{},platform.defaultDisplay);
    assert.equal(await page.$eval('#shortcut-reset',element=>element.hidden),true);
    assert.equal(await page.$eval('#shortcut-clear',element=>element.hidden),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'shortcut-clear');
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),platform.defaultShortcut);
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='commands-reset'),[['commands-reset','_execute_action']]);
    pass('the Restore icon uses the popup command API and brings back the default binding');await page.close();
  }
  {
    const page=await openCase();const platform=await shortcutPlatform(page);
    await openPreferences(page);await page.click('#shortcut-edit');
    await recordShortcut(page,{key:'K',modifiers:[platform.primary]});
    assert.equal(await page.$eval('#shortcut-error',element=>element.hidden),false);
    assert.match(await page.$eval('#shortcut-error',element=>element.textContent),/Firefox uses this shortcut/);
    assert.equal(await page.$eval('#shortcut-input',element=>element.hidden),false);
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),platform.defaultShortcut);
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='commands-update'),[]);
    pass('a known native Command/Ctrl K conflict is rejected without an API update');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#settings',element=>element.hidden),false);
    assert.equal(await page.$eval('#shortcut-input',element=>element.hidden),true);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'shortcut-edit');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#settings').hidden&&document.activeElement.id==='query');
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='close'),[]);
    pass('Escape cancels the editor first, then closes Preferences and restores query focus');await page.close();
  }
  {
    const page=await openCase({shortcut:'Alt+Shift+8',failShortcutUpdate:true});const platform=await shortcutPlatform(page);
    await openPreferences(page);await page.click('#shortcut-edit');
    await recordShortcut(page,{key:'U',modifiers:[platform.isMac?'Meta':'Alt','Shift']});
    await page.waitForFunction(()=>!document.querySelector('#shortcut-error').hidden&&!document.querySelector('#shortcut-input').disabled);
    assert.match(await page.$eval('#shortcut-error',element=>element.textContent),/could not save/);
    assert.equal(await page.$eval('#shortcut-input',element=>element.hidden),false);
    assert.equal(await page.$eval('#shortcut-current',element=>element.textContent),platform.isMac?'⌥⇧8':'Alt+Shift+8');
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),'Alt+Shift+8');
    assert.deepEqual((await page.evaluate(()=>window.__popupFake.calls)).filter(call=>call[0]==='commands-update'),[['commands-update',{name:'_execute_action',shortcut:platform.customShortcut}]]);
    pass('a failed shortcut API update preserves the current binding and keeps the editor available');await page.close();
  }
  {
    const page=await openCase({shortcut:'Alt+Shift+8',failShortcutUpdate:true});
    await openPreferences(page);await page.click('#shortcut-clear');
    await page.waitForFunction(()=>!document.querySelector('#shortcut-error').hidden&&!document.querySelector('#shortcut-clear').disabled);
    assert.match(await page.$eval('#shortcut-error',element=>element.textContent),/could not clear/);
    assert.equal(await page.evaluate(()=>window.__popupFake.currentShortcut()),'Alt+Shift+8');
    assert.equal(await page.$eval('#shortcut-reset',element=>element.hidden),true);
    pass('a failed clear shows an inline error and preserves the existing assignment');await page.close();
  }
  {
    const page=await openCase({shortcut:''});
    await page.setViewport({width:300,height:600});await openPreferences(page);
    assert.equal(await page.$eval('#shortcut-current',element=>element.textContent),'Add shortcut');
    assert.equal(await page.$eval('#shortcut-clear',element=>element.hidden),true);
    assert.equal(await page.$eval('#shortcut-reset',element=>element.hidden),false);
    assert.equal(await page.$eval('#shortcut-edit',element=>element.getAttribute('aria-label')),'Edit shortcut');
    assert.equal(await page.$eval('#shortcut-row',element=>element.scrollWidth<=element.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const centers=await page.$$eval('#shortcut-row > :not([hidden])',elements=>elements.map(element=>{const box=element.getBoundingClientRect();return Math.round(box.y+box.height/2);}));
    assert.equal(new Set(centers).size,1);
    pass('an initially unassigned shortcut uses the native-style single row without overflowing a narrow popup');await page.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(remoteRequests,[]);
  console.log('RESULT',passed,'integration checks passed; no page errors or remote network requests');
}finally{await browser?.close();server.close();}
