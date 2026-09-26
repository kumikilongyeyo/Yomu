/**
 * Changes to the built web app that belong in its Expo source.
 *
 * dist-app/ is Expo build output and the Expo project that produced it was
 * never handed over, so these are applied to the bundle. Every edit is anchored
 * to an exact string that must appear exactly once; if a future `expo export`
 * changes the minified names, this fails loudly naming the anchor that moved
 * rather than silently doing nothing. Re-run it after any rebuild:
 *
 *   node tools/patch-bundle.mjs            # apply
 *   node tools/patch-bundle.mjs --check    # verify, change nothing (exit 1 if not applied)
 *
 * Idempotent: applying twice is a no-op.
 *
 * It also links dist-app/yomu-overrides.css into every page. That cannot be done
 * from the Worker: Wrangler's asset server answers a matching path itself and
 * never invokes the Worker, so an HTMLRewriter there would never run.
 *
 * When the Expo source turns up, every edit here should move into it and this
 * script should be deleted. Each one records where it belongs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_DIR = 'dist-app/_expo/static/js/web';
const check = process.argv.includes('--check');

const EDITS = [
  /* --- reader chrome — app/read/[chapterId].web.tsx -------------------- */
  {
    name: 'reader: idle timeout 3s -> 2s',
    why:
      'The reader hid its chrome after 3 seconds. Two reads better on a phone, ' +
      'where the bars cover the page you are trying to read.',
    from: 'x=768,j=3e3,b=e=>',
    to:   'x=768,j=2e3,b=e=>',
  },
  {
    name: 'reader: scrolling no longer wakes the chrome',
    why:
      'The reader root had onPointerMove and onPointerDown both calling show(). ' +
      'On a touch screen a scroll is a stream of pointermove events, so the bars ' +
      'reappeared the moment you started reading. Pointer movement still wakes ' +
      'them for a mouse, where there is no other idle signal; touch is left to ' +
      'the tap handler, which already toggles them deliberately.',
    from: 'onPointerMove:Y,onPointerDown:Y',
    to:   "onPointerMove:e=>{e.pointerType==='mouse'&&Y()}",
  },
  {
    name: 'reader: double tap toggles the chrome, and leaves immersive first',
    why:
      'Originally `onTap:()=>Z?F(!1):Y()` -- a single tap toggled the bars, so ' +
      'any tap while reading flashed them up. An earlier pass made it two taps ' +
      'within 320ms, the same window the native reader uses, and that form is ' +
      'what the shipped bundle contains; it is the anchor below.\n' +
      'Now that the shell can also take the reader fullscreen, the same double ' +
      'tap has to be the way back out, or the only exit is a gesture the OS ' +
      'owns. The shell installs __yomuExit and returns true when it actually ' +
      'left something; the bar toggle is what happens when there was nothing to ' +
      'leave. Kept as one edit rather than two so that re-running the script ' +
      'sees exactly one anchor, applied or not.',
    from:
      'onTap:()=>{const t=Date.now();' +
      'if(t-(globalThis.__yomuTap??0)<320){globalThis.__yomuTap=0;Z?F(!1):Y()}' +
      'else globalThis.__yomuTap=t}',
    to:
      'onTap:()=>{const t=Date.now();' +
      'if(t-(globalThis.__yomuTap??0)<320){globalThis.__yomuTap=0;' +
      'globalThis.__yomuExit?.()?Y():Z?F(!1):Y()}' +
      'else globalThis.__yomuTap=t}',
  },

  {
    name: 'reader: pages sit flush in scroll mode',
    why:
      'buildLayout was given an 8px gap between every page. The scroll surface ' +
      'behind it is #0b0b0e, so on a webtoon -- where consecutive pages are ' +
      'slices of one continuous drawing -- that gap reads as a black bar cutting ' +
      'through the art. Page mode keeps the gap, because there the pages really ' +
      'are separate sheets and the seam is what tells them apart.',
    from: '(0,n.buildLayout)(h,j,P,s),[h,j,P])',
    to:   "(0,n.buildLayout)(h,j,P,'page'===w?s:0),[h,j,P,w])",
  },
  {
    name: 'reader: chapter rows carry their chapter id',
    why:
      'The chapter sheet lists rows whose id only exists inside the closure, so ' +
      'nothing outside React can tell which row is read and which is the one ' +
      'you are on. Exposing the id and number as attributes is the whole edit; ' +
      'the thumbnail and the read state are drawn by the shell, which is where ' +
      'the progress keys are already understood.',
    from:
      '(0,o.jsxs)("button",{"aria-current":e.id===v,onClick:()=>{se(e.id)},' +
      'children:[(0,o.jsxs)("strong",{children:["Chapter ",e.number]})',
    to:
      '(0,o.jsxs)("button",{"aria-current":e.id===v,"data-ch":e.id,"data-n":e.number,' +
      'onClick:()=>{se(e.id)},' +
      'children:[(0,o.jsxs)("strong",{children:["Chapter ",e.number]})',
  },

  {
    name: 'tiles: cover tiles carry their series id',
    why:
      'A tile prints a title and a source label and nothing a lookup can key ' +
      'on, so nothing outside React can tell that the title under the cursor is ' +
      'one you are part-way through. This is the same one-attribute edit as the ' +
      'chapter rows, and it is what lets the shell put "Chapter 41" back on a ' +
      'title you find again through search.',
    from: 'return(0,t.jsxs)("div",{className:"tile-card",children:[',
    to:   'return(0,t.jsxs)("div",{className:"tile-card","data-series":n.id,children:[',
  },

  {
    name: 'series: chapter rows carry their chapter number',
    why:
      'Same one-attribute edit as the reader\'s chapter sheet and the cover ' +
      'tiles. The circle keys its comments by chapter number, and the series ' +
      'list prints that number only inside a string ("Chapter 41") that would ' +
      'have to be parsed back out -- and parsed wrongly the moment a source ' +
      'names a chapter something else.',
    from: 'return(0,x.jsxs)("div",{className:"chapter-line"+(t?\' is-read\':\'\'),children:[',
    to:   'return(0,x.jsxs)("div",{className:"chapter-line"+(t?\' is-read\':\'\'),"data-chn":e.number,children:[',
  },

  {
    name: 'series: a chapter row says each thing once',
    why:
      'Every row read "Chapter 200 / Chapter 200 / 0 pages" on most sources. ' +
      'The name is printed under the number even when it is only the number ' +
      'again, and "0 pages" is what an unknown count looks like -- six of the ' +
      "seven extensions never report one, so it said nothing true. The name " +
      'now shows only when it adds something ("Romance Dawn"), the count only ' +
      'when it is known, and "Read" stays either way.',
    from:
      '(0,x.jsx)("span",{children:e.name}),(0,x.jsxs)("small",{children:[e.pageCount," pages",t?\' \\xb7 Read\':\'\']})',
    to:
      '(0,x.jsx)("span",{children:String(e.name||\'\').replace(/\\s+/g,\' \').trim().toLowerCase()===(\'chapter \'+e.number).toLowerCase()?\'\':e.name}),' +
      '(0,x.jsxs)("small",{children:[e.pageCount>0?e.pageCount+" pages":\'\',e.pageCount>0&&t?\' \\xb7 \':\'\',t?\'Read\':\'\']})',
  },

  {
    name: 'reader: the chrome can be held open from outside',
    why:
      'The bars fade after two seconds, which is right while you are reading ' +
      'and wrong the moment you reach the foot of a chapter -- that is exactly ' +
      'when you want the next-chapter control, and double tapping to summon it ' +
      'is a step for something the reader already knows you need.\n' +
      'Y() shows them and re-arms the hide; this exposes a variant that shows ' +
      'them and cancels it, so the shell can hold the bar open at the end of a ' +
      'chapter until you do something.',
    // Anchored through the effect that follows, so the patched text no longer
    // matches -- see the guard below for why that matters.
    from:
      'const X=(0,e.useRef)(null),Y=(0,e.useCallback)(()=>{F(!0),' +
      'X.current&&clearTimeout(X.current),X.current=setTimeout(()=>F(!1),j)},[]);' +
      '(0,e.useEffect)(()=>(Y(),',
    to:
      'const X=(0,e.useRef)(null),Y=(0,e.useCallback)(()=>{F(!0),' +
      'X.current&&clearTimeout(X.current),X.current=setTimeout(()=>F(!1),j)},[]);' +
      '(0,e.useEffect)(()=>{globalThis.__yomuHoldChrome=()=>{' +
      'X.current&&clearTimeout(X.current),F(!0)};' +
      'return()=>{delete globalThis.__yomuHoldChrome}});' +
      '(0,e.useEffect)(()=>(Y(),',
  },

  {
    name: 'reader: the reading mode is remembered per title',
    why:
      'Scroll, Page and Spread were one global setting, so switching a manga to ' +
      'Page switched every manhwa with it. The mode is now kept per series in ' +
      'yomu.v1.reader-mode.byTitle; the global key is still written and is the ' +
      'fallback for a title never opened, so the last choice carries to a new one.',
    from: "[_,P]=(0,e.useState)(()=>N(m,'scroll'))",
    to:
      "[_,P]=(0,e.useState)(()=>{try{const t=JSON.parse(localStorage.getItem('yomu.v1.reader-mode.byTitle')||'{}')[k];" +
      "if(t==='scroll'||t==='page'||t==='spread')return t}catch{}return N(m,'scroll')})",
  },
  {
    name: 'reader: the per-title mode is saved with the global one',
    why: 'The other half of the edit above.',
    from:
      '(0,e.useEffect)(()=>{try{localStorage.setItem(m,_),localStorage.setItem(p,String(E))}catch{}},[_,E]);',
    to:
      '(0,e.useEffect)(()=>{try{localStorage.setItem(m,_),localStorage.setItem(p,String(E));' +
      "if(k){const o=JSON.parse(localStorage.getItem('yomu.v1.reader-mode.byTitle')||'{}');" +
      "if(o[k]!==_){delete o[k];o[k]=_;const ks=Object.keys(o);ks.length>300&&delete o[ks[0]];" +
      "localStorage.setItem('yomu.v1.reader-mode.byTitle',JSON.stringify(o))}}}catch{}},[_,E,k]);",
  },
  {
    name: 'reader: a prefetched manifest can be handed to the reader',
    why:
      'Manifests are served no-store, so preloading the next chapter from outside ' +
      'saved nothing: the reader fetched it again on arrival. yomu-reader-plus.js ' +
      'puts the promise in globalThis.__yomuManifestHandoff (keyed source|chapter, ' +
      '2 minutes, used once) and this wrapper hands it over instead of refetching. ' +
      'It is defined here, not by the helper, so the adapter identity is the same ' +
      'on the first render as on every later one -- a wrapper that appeared after ' +
      'mount would change useReader\'s input and load the chapter twice. A Proxy ' +
      'with methods bound to the real adapter, not Object.create, so an adapter ' +
      'with private fields still works.',
    from: "b=e=>e.split(':')[0]??'';function N(e,s)",
    to:
      "b=e=>e.split(':')[0]??'',__yh=new WeakMap(),__ya=f=>{let w=__yh.get(f);if(w)return w;const bound=new Map();" +
      "const gm=(i,...a)=>{const c=globalThis.__yomuManifestHandoff,key=f.id+'|'+i,h=c&&c.get(key);" +
      "if(h&&Date.now()-h.at<12e4){c.delete(key);return h.promise.catch(()=>f.getManifest(i,...a))}return f.getManifest(i,...a)};" +
      "w=new Proxy(f,{get(t,q){if(q==='getManifest')return gm;const v=t[q];if(typeof v!=='function')return v;" +
      "let g=bound.get(q);g||(g=v.bind(t),bound.set(q,g));return g}});__yh.set(f,w);return w};function N(e,s)",
  },
  {
    name: 'reader: the adapter goes through the handoff',
    why: 'Uses the wrapper above. Same adapter otherwise.',
    from: 'W=(0,n.useReader)({adapter:f,sourceSeriesId:k,chapterId:v})',
    to: 'W=(0,n.useReader)({adapter:__ya(f),sourceSeriesId:k,chapterId:v})',
  },
  {
    name: 'reader: its state is readable from outside',
    why:
      'Preloading, the scroll-direction chrome and cross-source page rescue all ' +
      'need to know the chapter the reader is on, its neighbours, the page and ' +
      'the page list -- none of which is in the DOM. Published on ' +
      'globalThis.__yomuReader after every render, with show/hide for the chrome, ' +
      'and a yomu:reader event. Deleted on unmount.',
    from: 'const re=K?(w+1)/K*100:0;return(0,o.jsxs)',
    to:
      'const re=K?(w+1)/K*100:0;' +
      '(0,e.useEffect)(()=>{globalThis.__yomuReader={adapter:f,source:f.id,chapterId:v,seriesId:k,' +
      'next:G?.nextChapterId??null,previous:G?.previousChapterId??null,page:w,count:K,pages:J,mode:Q,sheet:!!M,' +
      'show:Y,hide:()=>{X.current&&clearTimeout(X.current),F(!1)}};' +
      "try{dispatchEvent(new Event('yomu:reader'))}catch{}});" +
      '(0,e.useEffect)(()=>()=>{delete globalThis.__yomuReader},[]);' +
      'return(0,o.jsxs)',
  },

  /* --- home — app/index.web.tsx --------------------------------------- */
  {
    name: 'home: the app\'s own Continue card yields to the shell\'s row',
    why:
      'The built-in card reads its resume state only for titles in the ' +
      'discovery feed -- readResume is mapped over the feed, never over ' +
      'listSeriesWithProgress -- so the title you were actually reading shows ' +
      'up only if a source happens to return it in its first 18. That is why ' +
      'Continue Reading kept vanishing. The shell builds the row from stored ' +
      'progress instead, and this guard stops the two stacking. Left as a ' +
      'fallback rather than deleted: if the shell fails to load, the old card ' +
      'still appears on the days it can.',
    from: 'Se&&Ce?(0,p.jsxs)(p.Fragment,',
    to:   'Se&&Ce&&!globalThis.__yomuContinue?(0,p.jsxs)(p.Fragment,',
  },
  {
    name: 'home: drop the duplicated genre chips',
    why:
      'The genre row printed Reincarnation and Martial arts twice -- once as a ' +
      'MangaDex genre and again as an AniList tag, identical labels, different ' +
      'filters. Eleven chips over three wrapped rows, two of them decoys. The ' +
      'MangaDex six stay (nothing else reaches them; More tags only offers ' +
      'AniList tags); the two duplicates go.',
    from:
      "N=[{tag:'Cultivation',label:'Cultivation'},{tag:'Wuxia',label:'Wuxia'}," +
      "{tag:'Reincarnation',label:'Reincarnation'},{tag:'Martial Arts',label:'Martial arts'}]",
    to: "N=[{tag:'Cultivation',label:'Cultivation'},{tag:'Wuxia',label:'Wuxia'}]",
  },

  {
    name: 'home: the grid is filtered and ordered by the shell',
    why:
      'Two problems in one expression. The default view leads with M, the ' +
      'most recently updated titles across every source -- which is a ' +
      'firehose, so the first thing on the page was whatever some site ' +
      'touched in the last hour rather than anything worth reading. And ' +
      'nothing filtered the feed at all, so one-chapter entries with no ' +
      'cover sat beside real series.\n' +
      'Both are judgement calls about what to show, which is the kind of ' +
      'thing that should be readable. So the array is handed to the shell, ' +
      'which decides; with the shell absent the old behaviour is exactly ' +
      'what happens.',
    from:
      'return[...M.map(({summary:e,sourceId:s,sourceLabel:a})=>' +
      '({summary:e,sourceId:s,sourceLabel:a})),' +
      '...e.filter(e=>!s.has(`${e.sourceId}:${e.summary.id}`))]},[ce,M,E,z,U,W])',
    to:
      'const _g=[...M.map(({summary:e,sourceId:s,sourceLabel:a})=>' +
      '({summary:e,sourceId:s,sourceLabel:a})),' +
      '...e.filter(e=>!s.has(`${e.sourceId}:${e.summary.id}`))];' +
      'return globalThis.__yomuGrid?globalThis.__yomuGrid(_g,e):_g},[ce,M,E,z,U,W])',
  },
  {
    name: 'home: a refresh control, and a handle for pull to refresh',
    why:
      'There was no way to ask for a different set of recommendations short ' +
      'of reloading the page. The reset-and-refetch the mount effect already ' +
      'runs is exactly the right action; it just had no button. Exposed as a ' +
      'global as well, so the shell can drive it from a pull gesture without ' +
      'needing a second copy of the sequence.',
    // Anchored through to the next statement so the patched form no longer
    // matches: a `to` that starts with its own `from` reapplies for ever.
    from:
      '(0,e.useEffect)(()=>{oe([]),he(0),fe(0,!0).catch(e=>F(e.message))},[pe]);' +
      'const xe=(0,e.useMemo)',
    to:
      '(0,e.useEffect)(()=>{oe([]),he(0),fe(0,!0).catch(e=>F(e.message))},[pe]);' +
      '(0,e.useEffect)(()=>{globalThis.__yomuReload=()=>{oe([]),he(0),' +
      'fe(0,!0).catch(e=>F(e.message))};return()=>{delete globalThis.__yomuReload}});' +
      'const xe=(0,e.useMemo)',
  },
  {
    name: 'home: the refresh button itself',
    why:
      'Beside the heading it belongs to, so it reads as "another of these" ' +
      'rather than as a page-level control.',
    // Same trap, same fix: the anchor runs into the segment row that follows,
    // so the button cannot be inserted twice.
    from:
      '(0,p.jsx)("h2",{children:"Find your next obsession"}),' +
      '(0,p.jsx)("div",{className:"m-seg"',
    to:
      '(0,p.jsx)("h2",{children:"Find your next obsession"}),' +
      '(0,p.jsx)("button",{className:"home-reload","aria-label":"Show different titles",' +
      'title:"Show different titles",onClick:()=>{oe([]),he(0),' +
      'fe(0,!0).catch(e=>F(e.message))},children:"\\u21bb"}),' +
      '(0,p.jsx)("div",{className:"m-seg"',
  },

  /* --- search entry points — app/_layout.tsx, index.web.tsx, library.web.tsx ---
   *
   * The compiled search screen groups results by source, so one work carried by
   * six sites reads as six results. /find.html renders one row per title with
   * its sources underneath, using the catalog's already-merged answer. These
   * three edits are every route into the old screen; they are separate because
   * each screen navigates its own way.
   */
  {
    name: 'nav: Discover tab opens the merged search page',
    why: 'The dock replaced the route client-side, which would never load a static page.',
    from: "[['/','Home','home'],['/search','Discover','search']",
    to:   "[['/','Home','home'],['/find.html','Discover','search']",
  },
  {
    name: 'nav: dock does a real navigation for static pages',
    why:
      'router.replace() only moves between Expo routes. A target ending in .html ' +
      'is a page of its own and needs a document load.',
    from: 'onClick:()=>c.replace(t)',
    to:   "onClick:()=>{t.endsWith('.html')?location.assign(t):c.replace(t)}",
  },
  {
    name: 'home: search field opens the merged search page',
    why:
      'Tapping the search field on Home pushed the old grouped-by-source screen. ' +
      'This is index.tsx, the native variant -- index.web.tsx renders no search ' +
      'field, so on web this code is not reached. Guarded on location existing so ' +
      'it stays correct rather than crashing if a native build ever runs it.',
    from: "onPress:()=>I.push('/search')",
    to:   "onPress:()=>{typeof location!=='undefined'?location.assign('/find.html'):I.push('/search')}",
  },
  {
    name: 'library: "Search sources" opens the merged search page',
    why: 'The empty-library button pushed the old screen; the other branch is unchanged.',
    from: "onClick:()=>b.push(w?'/search':'/')",
    to:   "onClick:()=>{w?location.assign('/find.html'):b.push('/')}",
  },

  /* --- chapter ids carry their series — src/sources/httpAdapter.ts ---------
   *
   * The reader is handed one thing, a chapter id, and has to work out which
   * series it belongs to: it reads `chapterId.split(':')[0]`. The MangaDex
   * adapter is built for that -- getSeries() mints `${seriesId}:${chapterId}`,
   * and every method taking a chapter id splits it back apart. The HTTP
   * adapter, which is every extension-backed source (Asura, Flame Comics, Weeb
   * Central, Webtoons, NamiComi) and every imported one, passed the source's
   * own chapter id straight through. With no colon in it the split returned the
   * whole chapter id as the series id, so the reader asked the Worker for a
   * series that does not exist, got a 502, and left `series` null forever: the
   * header read "Loading..." with no chapter name under it, the Chapters sheet
   * on the bottom bar came up empty, and the previous/next chapter buttons
   * stayed disabled. The pages themselves rendered, because a manifest is
   * fetched by chapter id alone -- which is why this looked like a reader that
   * had loaded nothing while the artwork was on the screen.
   *
   * The four edits below give the HTTP adapter the same convention as MangaDex.
   * They belong together: minting composite ids without stripping them again
   * would send `series:chapter` to the Worker and break every chapter.
   *
   * Ids stored before this (resume anchors, downloads, read marks) have no
   * colon, so they still fetch their manifest and read exactly as they did.
   * They simply do not gain a series until they are opened from a series page
   * again. A source whose own series id contains a colon is not supported, and
   * was not before either -- the reader's split predates this.
   */
  {
    name: 'http adapter: chapter ids are minted with their series',
    why:
      'getSeries() is the one place that holds both ids, so it is where the ' +
      'chapter ids the rest of the app navigates with get their series prefix ' +
      '-- exactly as the MangaDex adapter does a few modules over.',
    from:
      'getSeries:async function(e,t){const n=g.get(e);if(n)return n;' +
      'const s=c(await y(`series/${encodeURIComponent(e)}`,t));return g.set(e,s),s}',
    to:
      'getSeries:async function(e,t){const n=g.get(e);if(n)return n;' +
      'const s=c(await y(`series/${encodeURIComponent(e)}`,t));' +
      's.chapters=s.chapters.map($=>({...$,id:`${e}:${$.id}`}));' +
      'return g.set(e,s),s}',
  },
  {
    name: 'http adapter: the manifest request strips the series back off',
    why:
      'The Worker knows nothing of composite ids, so the id on the wire has to ' +
      "be the source's own. An id with no colon is unchanged, which is what " +
      'keeps anchors saved before this edit working.',
    from:
      'async getManifest(n,s){const o=await y(`chapters/${encodeURIComponent(n)}/manifest`,s);',
    to:
      "async getManifest(n,s){const $i=n.indexOf(':'),$c=n.slice($i+1)," +
      'o=await y(`chapters/${encodeURIComponent($c)}/manifest`,s);',
  },
  {
    name: 'http adapter: the manifest keeps the id the reader routed on',
    why:
      'Second half of the edit above. The refresh path has to strip too, and ' +
      'both paths now return through one re-stamp, because useReader() saves ' +
      'the resume anchor under manifest.chapterId and compares it against the ' +
      'route -- stamp the bare id and every chapter resumes from the top. ' +
      'sourceSeriesId is corrected the same way: the Worker can only infer it ' +
      'from the shape of a chapter id, and for a source with opaque ids it ' +
      'falls back to the chapter id itself, which files an offline download ' +
      'under a series of one chapter.',
    from:
      'if((0,e.isManifestExpired)(i)){const t=await y(`chapters/${encodeURIComponent(n)}/manifest?refresh=1`,s);' +
      'return(0,e.parseChapterManifest)(t)}return i}',
    to:
      'if((0,e.isManifestExpired)(i)){const t=await y(`chapters/${encodeURIComponent($c)}/manifest?refresh=1`,s);' +
      'i=(0,e.parseChapterManifest)(t)}' +
      'return{...i,chapterId:n,...($i>0?{sourceSeriesId:n.slice(0,$i)}:{})}}',
  },
  {
    name: 'http adapter: neighbours load the series they need',
    why:
      'getNeighbours() only searched series already in the memo, so whether the ' +
      'previous/next buttons worked at all depended on the series request ' +
      'winning a race against the manifest. The MangaDex adapter fetches the ' +
      'chapter list it needs; now this one does too, and the composite id says ' +
      'which series to ask for. A failure leaves the buttons disabled, as before.',
    from: 'async getNeighbours(e){for(const t of g.values()){',
    to:
      "async getNeighbours(e){const $i=e.indexOf(':');" +
      'if($i>0&&!g.has(e.slice(0,$i)))try{await this.getSeries(e.slice(0,$i))}catch{}' +
      'for(const t of g.values()){',
  },

  /* --- the kit's icons — assets/icons/svg -------------------------------
   *
   * The app draws its own 29 icons as inline paths in the bundle. The kit
   * ships 41, on the same 24px grid, and its wrapper is attribute-for-
   * attribute what the app already renders with: viewBox 0 0 24 24, fill
   * none, stroke currentColor, width 1.7, round caps and joins. So a swap is
   * the shapes and nothing else -- no sizing, no colour, no re-drawing.
   *
   * Sixteen of them, and only where the meaning is the same and the icon
   * sits in the same place. The rest of the kit's set is not here for two
   * reasons: about nine are for reader features the app does not have (fit
   * modes, reading direction, tap zones, papers, trim borders), and the
   * others would need a decision about where they go rather than what they
   * replace.
   *
   * spark is deliberately untouched: the Icon component falls back to it
   * for an unknown name, so changing it changes what every miss renders as.
   */
  {
    name: 'icon: home takes the kit home',
    from: "home:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"m3 10 9-7 9 7v10H3z\"}),(0,n.jsx)(\"path\",{d:\"M9 20v-7h6v7\"})]})",
    to: "home:(0,n.jsx)(\"path\",{d:\"M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5v-6.2H9V21H4a1 1 0 0 1-1-1z\"})",
  },
  {
    name: 'icon: search takes the kit search',
    from: "search:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"circle\",{cx:\"10.5\",cy:\"10.5\",r:\"6.5\"}),(0,n.jsx)(\"path\",{d:\"m16 16 5 5\"})]})",
    to: "search:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"circle\",{cx:\"11\",cy:\"11\",r:\"6.5\"}),(0,n.jsx)(\"path\",{d:\"m16 16 4.5 4.5\"})]})",
  },
  {
    name: 'icon: library takes the kit books',
    from: "library:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"rect\",{x:\"3\",y:\"4\",width:\"5\",height:\"16\",rx:\"1\"}),(0,n.jsx)(\"path\",{d:\"M11 4v16m4-15 5-1 3 15-5 1z\"})]})",
    to: "library:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"rect\",{x:\"3.5\",y:\"4\",width:\"4.4\",height:\"16\",rx:\"1\"}),(0,n.jsx)(\"rect\",{x:\"9.8\",y:\"4\",width:\"4.4\",height:\"16\",rx:\"1\"}),(0,n.jsx)(\"path\",{d:\"m16.6 5.6 3.2 13.2\"})]})",
  },
  {
    name: 'icon: settings takes the kit gear',
    from: "settings:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M4 7h16M4 17h16\"}),(0,n.jsx)(\"circle\",{cx:\"8\",cy:\"7\",r:\"3\"}),(0,n.jsx)(\"circle\",{cx:\"16\",cy:\"17\",r:\"3\"})]})",
    to: "settings:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M4 7.5h7M16 7.5h4M4 16.5h4M13 16.5h7\"}),(0,n.jsx)(\"circle\",{cx:\"13.5\",cy:\"7.5\",r:\"2.3\"}),(0,n.jsx)(\"circle\",{cx:\"10.5\",cy:\"16.5\",r:\"2.3\"})]})",
  },
  {
    name: 'icon: list takes the kit list',
    from: "list:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M8 6h12M8 12h12M8 18h12\"}),(0,n.jsx)(\"path\",{d:\"M4 6h.01M4 12h.01M4 18h.01\"})]})",
    to: "list:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M9 6.5h11M9 12h11M9 17.5h11\"}),(0,n.jsx)(\"circle\",{cx:\"5\",cy:\"6.5\",r:\"1.1\",fill:\"currentColor\"}),(0,n.jsx)(\"circle\",{cx:\"5\",cy:\"12\",r:\"1.1\",fill:\"currentColor\"}),(0,n.jsx)(\"circle\",{cx:\"5\",cy:\"17.5\",r:\"1.1\",fill:\"currentColor\"})]})",
  },
  {
    name: 'icon: play takes the kit play',
    from: "play:(0,n.jsx)(\"path\",{d:\"m8 4 12 8-12 8z\"})",
    to: "play:(0,n.jsx)(\"path\",{d:\"M8 5.5 18 12 8 18.5z\"})",
  },
  {
    name: 'icon: check takes the kit check',
    from: "check:(0,n.jsx)(\"path\",{d:\"m5 12 4 4L19 6\"})",
    to: "check:(0,n.jsx)(\"path\",{d:\"m5 12.5 4.5 4.5L19 7.5\"})",
  },
  {
    name: 'icon: bookmark takes the kit bookmark',
    from: "bookmark:(0,n.jsx)(\"path\",{d:\"M6 4h12v17l-6-4.5L6 21z\"})",
    to: "bookmark:(0,n.jsx)(\"path\",{d:\"M7 4.5h10a.5.5 0 0 1 .5.5v14.4L12 16l-5.5 3.4V5a.5.5 0 0 1 .5-.5z\"})",
  },
  {
    name: 'icon: download takes the kit dl',
    from: "download:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5\"}),(0,n.jsx)(\"path\",{d:\"M4 19h16\"})]})",
    to: "download:(0,n.jsx)(\"path\",{d:\"M12 4v10m0 0 3.6-3.6M12 14l-3.6-3.6M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2\"})",
  },
  {
    name: 'icon: moon takes the kit moon',
    from: "moon:(0,n.jsx)(\"path\",{d:\"M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11z\"})",
    to: "moon:(0,n.jsx)(\"path\",{d:\"M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z\"})",
  },
  {
    name: 'icon: sun takes the kit sunlow',
    from: "sun:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"circle\",{cx:\"12\",cy:\"12\",r:\"4\"}),(0,n.jsx)(\"path\",{d:\"M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2\"})]})",
    to: "sun:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"circle\",{cx:\"12\",cy:\"12\",r:\"3.4\"}),(0,n.jsx)(\"path\",{d:\"M12 4.5v1.6M12 17.9v1.6M4.5 12h1.6M17.9 12h1.6\"})]})",
  },
  {
    name: 'icon: sliders takes the kit tune',
    from: "sliders:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M4 8h10m4 0h2M4 16h4m4 0h8\"}),(0,n.jsx)(\"circle\",{cx:\"16\",cy:\"8\",r:\"2.2\"}),(0,n.jsx)(\"circle\",{cx:\"10\",cy:\"16\",r:\"2.2\"})]})",
    to: "sliders:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"path\",{d:\"M6 20V13M6 9.5V4M12 20v-8M12 8.5V4M18 20v-4M18 12.5V4\"}),(0,n.jsx)(\"circle\",{cx:\"6\",cy:\"11.2\",r:\"1.9\"}),(0,n.jsx)(\"circle\",{cx:\"12\",cy:\"10.2\",r:\"1.9\"}),(0,n.jsx)(\"circle\",{cx:\"18\",cy:\"14.2\",r:\"1.9\"})]})",
  },
  {
    name: 'icon: scrollMode takes the kit vscroll',
    from: "scrollMode:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"rect\",{x:\"6\",y:\"2\",width:\"12\",height:\"7\",rx:\"1.6\"}),(0,n.jsx)(\"rect\",{x:\"6\",y:\"11\",width:\"12\",height:\"7\",rx:\"1.6\"}),(0,n.jsx)(\"path\",{d:\"M12 19.5v2.2m0 0-1.6-1.6M12 21.7l1.6-1.6\"})]})",
    to: "scrollMode:(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(\"rect\",{x:\"6.5\",y:\"3.5\",width:\"11\",height:\"17\",rx:\"2\"}),(0,n.jsx)(\"path\",{d:\"M12 8.5v7m0 0-2.2-2.2M12 15.5l2.2-2.2\"})]})",
  },
  {
    name: 'icon: chevronLeft takes the kit left',
    from: "chevronLeft:(0,n.jsx)(\"path\",{d:\"m15 5-7 7 7 7\"})",
    to: "chevronLeft:(0,n.jsx)(\"path\",{d:\"M14 18 8 12l6-6\"})",
  },
  {
    name: 'icon: chevronRight takes the kit right',
    from: "chevronRight:(0,n.jsx)(\"path\",{d:\"m9 5 7 7-7 7\"})",
    to: "chevronRight:(0,n.jsx)(\"path\",{d:\"m10 6 6 6-6 6\"})",
  },
  {
    name: 'icon: close takes the kit x',
    from: "close:(0,n.jsx)(\"path\",{d:\"M6 6l12 12M18 6 6 18\"})",
    to: "close:(0,n.jsx)(\"path\",{d:\"M6 6 18 18M18 6 6 18\"})",
  },
  {
    name: 'appearance: light is the default',
    why:
      'GlassRoot read localStorage yomu.appearance and fell back to dark. The ' +
      'brand is white and yellow, so the app opens on Paper now and dark is ' +
      'something you choose. The stylesheet defaults the same way, and the ' +
      'status bar tint below follows.',
    from: "document.documentElement.dataset.mode=localStorage.getItem('yomu.appearance')||'dark'",
    to:   "document.documentElement.dataset.mode=localStorage.getItem('yomu.appearance')||'light'",
  },
];


const entries = fs.readdirSync(BUNDLE_DIR).filter((f) => /^entry-.*\.js$/.test(f));
if (entries.length !== 1) {
  console.error(`Expected exactly one entry bundle in ${BUNDLE_DIR}, found ${entries.length}.`);
  process.exit(1);
}
const file = path.join(BUNDLE_DIR, entries[0]);
let source = fs.readFileSync(file, 'utf8');

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/* An edit whose replacement still contains its own anchor can never be seen as
 * applied: `from` is found again afterwards, so --check reports NOT APPLIED and
 * a second run applies it a second time. That has happened three times in this
 * file -- once it would have added a duplicate refresh button on every run --
 * and it is entirely mechanical to catch, so it is caught here rather than
 * remembered. Extend `from` through whatever follows it until this passes. */
for (const edit of EDITS) {
  if (!edit.to.includes(edit.from)) continue;
  console.error(`UNSAFE EDIT  ${edit.name}`);
  console.error('             its replacement still contains its own anchor, so it');
  console.error('             would re-apply on every run. Extend `from` through the');
  console.error('             text that follows it.');
  process.exit(1);
}

let changed = 0;
let bundleChanged = 0;
let failed = 0;

for (const edit of EDITS) {
  const already = occurrences(source, edit.to);
  const pending = occurrences(source, edit.from);

  if (pending === 1) {
    if (check) {
      console.log(`NOT APPLIED  ${edit.name}`);
      failed++;
    } else {
      source = source.replace(edit.from, edit.to);
      console.log(`applied      ${edit.name}`);
      changed++;
      bundleChanged++;
    }
    continue;
  }
  if (pending === 0 && already >= 1) {
    console.log(`already      ${edit.name}`);
    continue;
  }
  console.error(`ANCHOR LOST  ${edit.name}`);
  console.error(`             looked for: ${edit.from}`);
  console.error(`             found ${pending} times; the bundle was rebuilt and the`);
  console.error(`             minified names moved. Re-derive this anchor.`);
  failed++;
}

/* --- every page links Yomu's own stylesheet ---------------------------- *
 *
 * The overrides are presentation-only and keyed on the app's own semantic class
 * names, so unlike the edits above they survive a rebuild's minifier. They just
 * need a <link>, and the built HTML is where it has to go.
 */
const PAGES_DIR = 'dist-app';

// Each is matched by its own filename, so adding one later tops up pages that
// already carry the other rather than being mistaken for done.
const ASSETS = [
  /* Archivo is one variable family covering both roles -- width 62..125 gives
     the expanded display cut, so display and UI are a single request. No
     `file`, so the local-existence check skips it; `probe` is what marks a
     page as already carrying it. */
  {
    probe: 'family=Archivo',
    label: 'Archivo (Google Fonts)',
    tag:
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap">',
  },
  { file: 'yomu-overrides.css', tag: '<link rel="stylesheet" href="/yomu-overrides.css">' },
  /* Both define their own namespaced properties (--yb-*, .yp-*) and override
     nothing the skin sets, so they sit here rather than after it and the
     skin-goes-last rule below is left intact. */
  { file: 'yomu-badges.css', tag: '<link rel="stylesheet" href="/yomu-badges.css">' },
  { file: 'yomu-pet.css', tag: '<link rel="stylesheet" href="/yomu-pet.css">' },
  /* The shelf, the stickers and the Circle reactions. Its own namespace
     (.ysh-*, .ys, .yomu-react*) and nothing the skin sets. */
  { file: 'yomu-shelf.css', tag: '<link rel="stylesheet" href="/yomu-shelf.css">' },
  /* Heat ramp tokens keyed on data-mode like yomu-badges.css; nothing the
     skin sets. */
  { file: 'yomu-streak.css', tag: '<link rel="stylesheet" href="/yomu-streak.css">' },
  { file: 'yomu-companion.css', tag: '<link rel="stylesheet" href="/yomu-companion.css">' },
  { file: 'yomu-discovery.css', tag: '<link rel="stylesheet" href="/yomu-discovery.css">' },
  { file: 'yomu-social.css', tag: '<link rel="stylesheet" href="/yomu-social.css">' },
  { file: 'yomu-wrap.css', tag: '<link rel="stylesheet" href="/yomu-wrap.css">' },
  { file: 'yomu-wall.css', tag: '<link rel="stylesheet" href="/yomu-wall.css">' },
  { file: 'yomu-diary.css', tag: '<link rel="stylesheet" href="/yomu-diary.css">' },
  { file: 'yomu-rails.css', tag: '<link rel="stylesheet" href="/yomu-rails.css">' },
  /* The reader's chapter-end card. Its own .ych namespace and nothing the
     skin sets. */
  { file: 'yomu-chapter-end.css', tag: '<link rel="stylesheet" href="/yomu-chapter-end.css">' },
  /* The glass chips every tile tag wears. After every other tag stylesheet
     so its placement rules win ties. */
  { file: 'yomu-tags.css', tag: '<link rel="stylesheet" href="/yomu-tags.css">' },
  { file: 'yomu-gate.js', tag: '<script src="/yomu-gate.js" defer></scr' + 'ipt>' },
  /* Ahead of the shell, which reads window.YOMU_GREETINGS synchronously.
     Both are deferred, and deferred scripts run in document order. */
  { file: 'yomu-greetings.js', tag: '<script src="/yomu-greetings.js" defer></scr' + 'ipt>' },
  { file: 'yomu-shell.js', tag: '<script src="/yomu-shell.js" defer></scr' + 'ipt>' },
  { file: 'yomu-sync.js', tag: '<script src="/yomu-sync.js" defer></scr' + 'ipt>' },
  { file: 'yomu-circle.js', tag: '<script src="/yomu-circle.js" defer></scr' + 'ipt>' },
  /* Order here is a dependency chain, and deferred scripts run in document
     order, so it is the only thing holding it together:
       progress  owns the counters and the affinity gates
       badges    renders an equipped title, and progress names the family
       pet       reads progress to know whether Mori is unlocked
       greet     needs all three before it can choose a line
     Moving greet above progress does not throw; it silently drops every
     gated line, which looks like a smaller corpus rather than a bug. */
  { file: 'yomu-progress.js', tag: '<script src="/yomu-progress.js" defer></scr' + 'ipt>' },
  { file: 'yomu-badges.js', tag: '<script src="/yomu-badges.js" defer></scr' + 'ipt>' },
  /* Stickers draw from nothing but their own catalogue; the shelf registers
     the milestone badge families into the renderer above, so it must follow
     it, and the Circle client (earlier in the chain) only ever asks for
     these at paint time, after every deferred script has run. */
  { file: 'yomu-stickers.js', tag: '<script src="/yomu-stickers.js" defer></scr' + 'ipt>' },
  { file: 'yomu-shelf.js', tag: '<script src="/yomu-shelf.js" defer></scr' + 'ipt>' },
  /* yomu-integrity.js, yomu-reader-plus.js, yomu-page-rescue.js,
     yomu-ledger.js, yomu-chapter-end.js, yomu-cast.js, yomu-capsule.js,
     yomu-heat.js and yomu-race.js are deliberately NOT here:
     yomu-fabric-route.js loads them on entering /read/ or /series/. On every
     page they cost the release gate's warm-revisit budget (see that file). */
  { file: 'yomu-pet.js', tag: '<script src="/yomu-pet.js" defer></scr' + 'ipt>' },
  { file: 'yomu-greet.js', tag: '<script src="/yomu-greet.js" defer></scr' + 'ipt>' },
  /* After the pet (it borrows the sprite), the shelf (the badge drop) and
     greet (the line). */
  { file: 'yomu-ceremony.js', tag: '<script src="/yomu-ceremony.js" defer></scr' + 'ipt>' },
  /* The companion update. All four read the pet, the store and greet, and
     none is read by anything earlier. */
  /* Engines, then the UI that reads them. */
  { file: 'yomu-streak.js', tag: '<script src="/yomu-streak.js" defer></scr' + 'ipt>' },
  { file: 'yomu-streak-ui.js', tag: '<script src="/yomu-streak-ui.js" defer></scr' + 'ipt>' },
  { file: 'yomu-roam.js', tag: '<script src="/yomu-roam.js" defer></scr' + 'ipt>' },
  { file: 'yomu-binge.js', tag: '<script src="/yomu-binge.js" defer></scr' + 'ipt>' },
  /* The discovery update. Skins first: it sets data-yomu-skin on <html>
     as it loads and the earlier that lands the less of a flash. */
  { file: 'yomu-skins.js', tag: '<script src="/yomu-skins.js" defer></scr' + 'ipt>' },
  { file: 'yomu-roulette.js', tag: '<script src="/yomu-roulette.js" defer></scr' + 'ipt>' },
  { file: 'yomu-bingo.js', tag: '<script src="/yomu-bingo.js" defer></scr' + 'ipt>' },
  /* The social update. All three read what yomu-circle.js already fetched. */
  { file: 'yomu-shelfshare.js', tag: '<script src="/yomu-shelfshare.js" defer></scr' + 'ipt>' },
  /* Year in Yomu. Reads the store and the AniList cache; draws on a canvas. */
  { file: 'yomu-wrap.js', tag: '<script src="/yomu-wrap.js" defer></scr' + 'ipt>' },
  /* The cover wall. Reads the library and the reading index; Home only. */
  { file: 'yomu-wall.js', tag: '<script src="/yomu-wall.js" defer></scr' + 'ipt>' },
  /* Mori's diary: on-device lines when a title is finished. No model call. */
  { file: 'yomu-diary.js', tag: '<script src="/yomu-diary.js" defer></scr' + 'ipt>' },
  /* Ratings on tiles, from the AniList cache yomu-anilist.js keeps. */
  /* Ahead of the files that build chips (ratings, rails), so YomuTags exists
     when they paint. Rails and ratings still work without it. */
  { file: 'yomu-tags.js', tag: '<script src="/yomu-tags.js" defer></scr' + 'ipt>' },
  /* Customize look: the sheet Mori's menu and Your Yomu open. Its chip hooks
     live in yomu-tags.css; this pair is the knobs and the sheet. The gradient
     editor it uses (/vendor/grapick) is fetched by the sheet on demand and is
     deliberately not linked here. */
  { file: 'yomu-look.css', tag: '<link rel="stylesheet" href="/yomu-look.css">' },
  { file: 'yomu-look.js', tag: '<script src="/yomu-look.js" defer></scr' + 'ipt>' },
  { file: 'yomu-ratings.js', tag: '<script src="/yomu-ratings.js" defer></scr' + 'ipt>' },
  /* Ahead of yomu-mori.js and yomu-rank.js, which both ask it. */
  { file: 'yomu-anilist.js', tag: '<script src="/yomu-anilist.js" defer></scr' + 'ipt>' },
  /* One resolver for "what happens when I click a title", ahead of every
     surface that draws one. Fetches nothing until something is clicked. */
  { file: 'yomu-open-title.js', tag: '<script src="/yomu-open-title.js" defer></scr' + 'ipt>' },
  /* Source Fabric is listed only in sources.html, and Yomu routes client-side,
     so reaching Sources from inside the app never loaded it -- a reload was
     the only way in, and an installed Home Screen app has no reload button.
     This belongs on every page precisely because it is the page that does not
     have Source Fabric that needs to be able to fetch it. Order-independent:
     it reads location on its own and loads what it needs. */
  { file: 'yomu-fabric-route.js', tag: '<script src="/yomu-fabric-route.js" defer></scr' + 'ipt>' },
  /* The discovery engine, then the rails that draw it. */
  { file: 'yomu-rank.js', tag: '<script src="/yomu-rank.js" defer></scr' + 'ipt>' },
  { file: 'yomu-rails.js', tag: '<script src="/yomu-rails.js" defer></scr' + 'ipt>' },
  /* The controlled customiser: presets and the knobs the look sheet grew.
     It rewrites the sheet yomu-look.js builds, so it follows it. These three
     were shipped by the deploy workflow's HTML injection and by nothing else,
     which meant a local page and a deployed page disagreed about whether the
     customiser existed at all. Linking them here makes the committed pages
     the truth; the workflow's own injection is a no-op once the tag is
     already present. */
  { file: 'yomu-controls.js', tag: '<script src="/yomu-controls.js" defer></scr' + 'ipt>' },
  /* Last: it takes the pet's tap over, so the pet has to exist first. */
  { file: 'yomu-mori.js', tag: '<script src="/yomu-mori.js" defer></scr' + 'ipt>' },
  /* Last, so it overrides both the compiled palette and yomu-overrides.css on
     equal specificity. Moving it earlier silently un-skins the app. */
  { file: 'yomu-skin.css', tag: '<link rel="stylesheet" href="/yomu-skin.css">' },
  /* The one thing allowed after the skin: the skins. It overrides the
     Aurora and Paper source tokens the skin defines, and must win on order. */
  { file: 'yomu-skins.css', tag: '<link rel="stylesheet" href="/yomu-skins.css">' },
  /* ...and the customiser's two sheets, which the deploy workflow has been
     appending here all along. Kept in that position deliberately rather than
     filed with the other stylesheets above: the site-gradient presets paint
     `body`, the skin paints `body`, and the preset is the reader's explicit
     choice, so it has to be the one that lands last. */
  { file: 'yomu-controls-base.css', tag: '<link rel="stylesheet" href="/yomu-controls-base.css">' },
  { file: 'yomu-controls-components.css', tag: '<link rel="stylesheet" href="/yomu-controls-components.css">' },
];

// /start is the first-run flow and must not carry the shell: the shell is
// what redirects to /start, and a page that redirects to itself is a loop.
// That applies to the scripts, not the stylesheets -- skipping the page
// wholesale left the first screen a new reader ever sees as the only
// unskinned one in the app. These pages get the CSS and the fonts, no JS.
// shelf.html is for someone who does not have Yomu: styles, no companion.
/* The mode, before the first frame.
 *
 * The app sets it in a React effect -- GlassRoot's
 * `useEffect(() => { document.documentElement.dataset.mode =
 * localStorage.getItem('yomu.appearance') || 'light' }, [])` -- and an effect
 * runs after the commit that paints. Nothing carries data-mode in the shipped
 * HTML, so the stylesheet's own default (Paper) is what the first frame wears
 * and a dark reader watched every navigation flash white and correct itself.
 * Landing, Discovery and Search are three separate documents, so it happened
 * on each of them.
 *
 * This is the same read, done synchronously in the head, where it costs a
 * localStorage hit before anything is drawn. The effect then writes the value
 * that is already there. The raw preference is written rather than a resolved
 * one, because 'system' is a mode yomu-skin.css resolves for itself.
 *
 * It also carries the skin (same reason, same class of flash), sets
 * color-scheme so the browser's own scrollbars and form controls are right
 * from the first frame, and keeps the browser tint in step by reading --bg
 * back off the stylesheet rather than keeping a second table of grounds here.
 *
 * `data-yomu-boot` suppresses transitions until the document is ready, so a
 * theme applied at boot arrives as a state rather than as an animation. It
 * must go on the element and its descendants both: a transition on <html>
 * alone is not what makes a header fade from white.
 *
 * Inline on purpose. A file would be a request, and a request is a frame.
 */
const HEAD_FIRST = {
  probe: 'id="yomu-boot"',
  label: 'prepaint theme bootstrap',
  tag: `<style id="yomu-boot-style">:root[data-yomu-boot],:root[data-yomu-boot] *{transition:none!important;animation-duration:0s!important}</style><script id="yomu-boot">(function(){try{var d=document.documentElement,p=null;try{p=localStorage.getItem('yomu.appearance')}catch(e){}if(p!=='dark'&&p!=='light'&&p!=='system')p='light';d.dataset.mode=p;var dark=p==='dark'||(p==='system'&&typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: dark)').matches);d.style.colorScheme=dark?'dark':'light';try{var k=localStorage.getItem('yomu.v1.skin');if(k)d.dataset.yomuSkin=k}catch(e){}d.setAttribute('data-yomu-boot','');var tint=function(){var v='';try{v=getComputedStyle(d).getPropertyValue('--bg').trim()}catch(e){}if(!v)v=dark?'#080d14':'#f5f2ec';var m=document.querySelector('meta[name=\"theme-color\"]');if(!m){m=document.createElement('meta');m.name='theme-color';document.head.appendChild(m)}if(m.content!==v)m.content=v};tint();var done=function(){d.removeAttribute('data-yomu-boot');tint()};if(document.readyState==='loading')addEventListener('DOMContentLoaded',function(){setTimeout(done,0)});else setTimeout(done,0);addEventListener('load',tint);}catch(e){}})();</scr` + `ipt>`,
};

const SCRIPT_FREE_PAGES = new Set(['start.html', 'shelf.html']);
const isScript = (a) => a.tag.includes('<script');

/* A released page may carry scripts/bundle-css.mjs's single stylesheet instead
   of the individual links this tool inserts. That is not a page missing its
   CSS -- it is the same CSS, concatenated. The bundler writes a
   `==== /yomu-x.css ====` banner per input, so which files a given bundle
   actually contains is something this can read rather than assume: a stale or
   partial bundle still reports its inputs as missing, which is the point. */
const BUNDLE_LINK = /\/(yomu-app-[0-9a-f]{12}\.css)/;
function stylesheetsInBundle(html) {
  const link = html.match(BUNDLE_LINK);
  if (!link) return new Set();
  const bundle = path.join(PAGES_DIR, link[1]);
  if (!fs.existsSync(bundle)) return new Set();
  const css = fs.readFileSync(bundle, 'utf8');
  return new Set([...css.matchAll(/==== \/(yomu-[A-Za-z0-9._-]+\.css) ====/g)].map((m) => m[1]));
}

for (const { file: assetFile } of ASSETS) {
  if (!assetFile) continue;
  if (fs.existsSync(path.join(PAGES_DIR, assetFile))) continue;
  console.error(`\nMissing ${path.join(PAGES_DIR, assetFile)} — nothing to link.`);
  failed++;
}

if (!failed) {
  /* Top-level pages, then the route shells in subdirectories.
   *
   * Only the top level gets the asset links: those shells are Expo's dynamic
   * route templates, the SPA fallback serves index.html in their place, and
   * giving them thirty-eight scripts they will never run would be cost with
   * no reader behind it. The markup edits *do* reach them -- a viewport that
   * blocks zoom is wrong wherever it is written, and these two files are the
   * series and reader shells, which is exactly where somebody wants to
   * enlarge a panel. */
  const subPages = fs.readdirSync(PAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((dir) => fs.readdirSync(path.join(PAGES_DIR, dir.name))
      .filter((f) => f.endsWith('.html'))
      .map((f) => path.join(dir.name, f)));
  const topPages = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html'));

  for (const page of [...topPages, ...subPages]) {
    const markupOnly = subPages.includes(page);
    const pagePath = path.join(PAGES_DIR, page);
    let html = fs.readFileSync(pagePath, 'utf8');

    /* Edits to the prerendered markup itself.
     *
     * Expo writes each route's first paint into the HTML and React hydrates
     * onto it, so a bundle edit that changes what a route renders has to be
     * made here as well or the two disagree and React throws #418 and redraws.
     * Unlike the bundle anchors these are stable, readable markup; they are
     * matched exactly and skipped when a page does not contain them. */
    const HTML_EDITS = [
      /* The status bar tint iOS paints behind a standalone web app. A value
         that is not the page's own ground shows as a seam above the content
         on a phone. Four have been in circulation -- Expo's #070708 and
         #0b0d12, a hand-written #141414, and the previous kit's #0c131b --
         so each is mapped straight to Aurora's ground rather than chained,
         which would need two passes after a fresh export.

         One value, not a light/dark pair: the app's mode is a stored setting
         rather than an OS preference, so a media-switched meta would be right
         for System viewers and wrong for anyone who forced the other mode.
         Aurora is the default, so Aurora is the tint. */
      ...['#070708', '#0b0d12', '#141414', '#0c131b', '#080d14'].flatMap((old) =>
        // Expo writes the tag as `"/>`; the hand-written pages write `" />`.
        // Both spellings are in the tree, so both are matched.
        ['/>', ' />'].map((close) => ({
          name: `theme-color ${old}${close === ' />' ? ' (hand-written)' : ''}`,
          from: `<meta name="theme-color" content="${old}"${close}`,
          to:   `<meta name="theme-color" content="#f5f2ec"${close}`,
        })),
      ),
      /* One owner for the mode.
       *
       * Six hand-written pages each re-read `yomu.appearance` and wrote
       * data-mode themselves, from a script at the bottom of the body. That
       * was necessary when nothing else set it, and it is not *wrong* today:
       * it writes the same value the prepaint bootstrap already wrote, so
       * removing it changes no pixel. It goes because it is a second writer
       * of a value that now has an owner.
       *
       * The cost of leaving it is the next change to what a mode means. The
       * bootstrap also resolves the skin, color-scheme and browser tint from
       * the same read; these lines know about none of that, and the next
       * person to add something to the mode has six other places to remember.
       * That is the shape the audit is pointing at -- not a bug today, a
       * standing invitation to one.
       */
      {
        name: 'drop per-page theme re-interpretation',
        from: "    try { document.documentElement.dataset.mode = localStorage.getItem('yomu.appearance') || 'light'; } catch {}\n",
        to: '',
      },
      {
        name: 'drop per-page theme re-interpretation (indented)',
        from: "  try { document.documentElement.dataset.mode = localStorage.getItem('yomu.appearance') || 'light'; } catch {}\n",
        to: '',
      },

      /* Pinch zoom, given back.
       *
       * Expo exports `maximum-scale=1, user-scalable=no`, which is the single
       * most common accessibility defect in a mobile web app: it takes the
       * browser's own magnification away from anyone who needs it, and a
       * reader app is exactly where someone wants to enlarge a panel. Safari
       * has ignored it since iOS 10, so on iPhone this was already only
       * affecting Android and desktop -- which is to say it was doing nothing
       * except for the people it hurt.
       *
       * `viewport-fit=cover` stays: that is the notch, not the zoom. Both
       * spellings Expo and the hand-written pages use are matched, and pages
       * already correct are left alone.
       */
      ...[
        'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
        'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover',
      ].map((old) => ({
        name: 'restore pinch zoom',
        from: `<meta name="viewport" content="${old}"`,
        to: '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"',
      })),
      {
        name: 'duplicate genre chips',
        // Pairs with the bundle edit of the same name. Reincarnation and
        // Martial arts were printed twice -- once as a MangaDex genre and
        // again as an AniList tag -- and the AniList pair is the one dropped.
        from:
          '<button class="genre-chip genre-chip--ani" aria-pressed="false">Reincarnation</button>' +
          '<button class="genre-chip genre-chip--ani" aria-pressed="false">Martial arts</button>',
        to: '',
      },
    ];

    for (const edit of HTML_EDITS) {
      if (!html.includes(edit.from)) continue;
      if (check) { console.log(`NOT APPLIED  ${edit.name}: ${page}`); failed++; continue; }
      html = html.split(edit.from).join(edit.to);
      fs.writeFileSync(pagePath, html);
      console.log(`applied      ${edit.name}: ${page}`);
      changed++;
    }

    if (markupOnly) continue;

    /* The prepaint bootstrap goes first in the head, ahead of every
       stylesheet and every other script, because its whole job is to have
       run before anything is drawn. */
    if (!html.includes(HEAD_FIRST.probe)) {
      const head = html.match(/<head\b[^>]*>/);
      if (!head) {
        console.log(`skipped      ${HEAD_FIRST.label}: ${page} (no <head>)`);
      } else if (check) {
        console.log(`NOT APPLIED  ${HEAD_FIRST.label}: ${page}`);
        failed++;
      } else {
        html = html.replace(head[0], head[0] + HEAD_FIRST.tag);
        fs.writeFileSync(pagePath, html);
        console.log(`applied      ${HEAD_FIRST.label}: ${page}`);
        changed++;
      }
    }

    // Matched on the href/src, not the bare filename: a page that merely
    // mentions an asset in a comment must not be mistaken for one that links it.
    const wanted = SCRIPT_FREE_PAGES.has(page) ? ASSETS.filter((a) => !isScript(a)) : ASSETS;
    const probeOf = (a) => a.probe ?? ('"/' + a.file + '"');
    const nameOf = (a) => a.file ?? a.label;
    const bundled = stylesheetsInBundle(html);
    const missing = wanted.filter((a) => !html.includes(probeOf(a)) && !bundled.has(a.file));
    if (!missing.length) { console.log(`already      assets: ${page}`); continue; }
    if (!html.includes('</head>')) { console.log(`skipped      assets: ${page} (no <head>)`); continue; }
    if (check) { console.log(`NOT APPLIED  assets: ${page} (${missing.map(nameOf).join(', ')})`); failed++; continue; }

    /* Inserted at its place in ASSETS, not appended.
     *
     * This used to drop every missing tag in one block before </head>, which
     * is right for a page being linked for the first time and wrong for a page
     * that already carries thirty of them: a new asset landed last however the
     * list was ordered. Several entries above document an order they need --
     * greetings before the shell, badges before the shelf, the skin last --
     * and those were only holding because they happened to be added when the
     * pages were first built. The first new one to actually depend on its
     * position (yomu-chapter-end.js, which has to register a window listener
     * before yomu-pet.js registers its own) got index 35 instead of 8 and the
     * dependency silently did not hold.
     *
     * So each tag goes after the last asset before it that the page already
     * has, and before everything else. A page with none of them is unchanged:
     * they all go before </head>, in list order.
     *
     * This narrows the gap; it does not close it. The existing pages were
     * built with an order that is not this list's -- yomu-pet.js sits four
     * entries before yomu-shelf.js here and eight *after* it in index.html --
     * so a new entry can still land on the far side of something this list
     * puts it before. Nothing may depend on this list's order for
     * correctness; it is a preference, and the comments above it say what
     * each entry would *like*. */
    for (const asset of missing) {
      const index = wanted.indexOf(asset);
      let anchor = null;
      for (let i = index - 1; i >= 0; i--) {
        const before = wanted[i];
        if (missing.includes(before)) continue;
        if (html.includes(before.tag)) { anchor = before.tag; break; }
      }
      html = anchor
        ? html.replace(anchor, anchor + asset.tag)
        : html.replace('</head>', asset.tag + '</head>');
    }
    fs.writeFileSync(pagePath, html);
    console.log(`applied      assets: ${page} (${missing.map(nameOf).join(', ')})`);
    changed++;
  }
}

// The bundle is written only if a bundle edit changed it; the HTML pass
// writes its own files as it goes.
if (bundleChanged) fs.writeFileSync(file, source);

/*
 * The service worker serves /_expo/static/ cache-first, because Expo's hashed
 * filenames promise the bytes never change. This script breaks that promise:
 * it edits the bundle in place under the same name. So a reader whose worker
 * cached the bundle before an edit keeps the old one for good -- an iOS Home
 * Screen install has no reload that would clear it.
 *
 * The shell cache is therefore named after the bundle's contents (BUNDLE_STAMP). Any edit
 * changes sw.js by a byte, the browser installs the new worker, and its
 * activate step deletes every yomu-shell-* cache but its own.
 */
{
  const SW = 'dist-app/sw.js';
  const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 10);
  // A separate constant, not SHELL_VERSION: deploy-yomu.yml's "Verify live
  // Yomu" step greps the live sw.js for the literal SHELL_VERSION = 'v3' and
  // rolls the release back without it (it did, once, on 2026-09-24).
  const stamp = `const BUNDLE_STAMP = '${digest}';`;
  const sw = fs.readFileSync(SW, 'utf8');
  const current = sw.match(/const BUNDLE_STAMP = '[^']*';/)?.[0];
  if (!current || !sw.includes("SHELL_VERSION = 'v3'")) {
    console.log(`ANCHOR LOST  service worker: BUNDLE_STAMP or SHELL_VERSION = 'v3' missing in ${SW}`);
    failed++;
  } else if (current === stamp) {
    console.log('already      service worker: shell cache follows the bundle');
  } else if (check) {
    console.log(`NOT APPLIED  service worker: ${current} does not name this bundle (${digest})`);
    failed++;
  } else {
    fs.writeFileSync(SW, sw.replace(current, stamp));
    console.log(`applied      service worker: shell cache ${digest}`);
    changed++;
  }
}

if (failed) process.exit(1);
console.log(changed ? `\n${changed} edit(s) applied` : '\nnothing to do');
