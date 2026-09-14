import test from 'node:test';
import assert from 'node:assert/strict';
import { generateYomuDescriptor } from '../src/yomu-descriptor.js';

const forged={
  profile:{id:'example-com',name:'Example',baseUrl:'https://example.com',strategies:{series:{title:[{selector:'h1',attrs:['text']}],cover:[{selector:'meta[property="og:image"]',attrs:['content']}],description:[{selector:'.description',attrs:['text']}]},chapters:[{selector:'.chapters a[href]',urlAttrs:['href']}],pages:[{selector:'.reader img',attrs:['data-src','src','srcset']}] }},
  series:{url:'https://example.com/manga/foo',title:'Foo',cover:'https://cdn.example.com/foo.jpg'},
  catalog:{url:'https://example.com/manga',count:20,score:90,listSelector:'.card',linkSelector:'a[href]',titleSelector:'h3',coverSelector:'img',coverAttrs:['data-src','src'],sample:[{url:'https://example.com/manga/foo',cover:'https://cdn.example.com/foo.jpg'}]},
  chapters:[{url:'https://example.com/manga/foo/chapter-1',title:'Chapter 1'}],
  samplePages:[{chapter:{title:'Chapter 1'},pages:['https://cdn.example.com/1.jpg','https://cdn.example.com/2.jpg']}],
  gauntlet:{score:96}
};

test('generates native Yomu descriptor with URL-safe routing',()=>{
  const out=generateYomuDescriptor(forged,{category:'manhwa'});
  assert.equal(out.descriptor.endpoints.popular.pageMax,1);
  assert.deepEqual(out.descriptor.endpoints.series.vars.seriesUrl.transform,[{urldecode:true}]);
  assert.deepEqual(out.descriptor.endpoints.pages.vars.chapterUrl.transform,[{split:'::',index:1}]);
  assert.ok(out.descriptor.hosts.includes('cdn.example.com'));
  assert.equal(out.indexEntry.capabilities.pages,true);
  assert.equal(out.validation.combinedScore,96);
});
