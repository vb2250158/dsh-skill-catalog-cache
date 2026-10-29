import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync}from'node:fs'
import{createRequire}from'node:module'
import{resolve}from'node:path'
import{pathToFileURL}from'node:url'
const root=process.env.DSH_SOURCE_ROOT
if(!root)throw Error('Set DSH_SOURCE_ROOT')
const require=createRequire(resolve(root,'vendor/include/package.json')),yaml=require('js-yaml')
const {entryListSchema,applyEntryPatches}=await import(pathToFileURL(resolve(root,'vendor/include/lib/index.js')))
const load=p=>yaml.load(readFileSync(p,'utf8'),{schema:entryListSchema})
test('bundle replaces each shipped scoped provider and preserves other preset configuration',()=>{
 const patches=load(new URL('../presets/cordis.patch.yml',import.meta.url));let replaced=0
 for(const id of ['standard','ptc','minimal','cordis']){
  const original=load(resolve(root,'packages/bundle/web-app/presets',id+'.patch.yml'))[0].insert
  const expected=structuredClone(original)
  const rewrite=rows=>{for(const row of rows){if(row.name==='@deepseek-ai/dsh-skill-filesystem'){row.name='dsh-skill-catalog-cache';replaced++}if(row.group&&Array.isArray(row.config))rewrite(row.config)}}
  rewrite(expected[0].config.plugins)
  const actual=applyEntryPatches(original,patches.filter(x=>x.id===original[0].id),()=>assert.fail('Unexpected patch warning'))
  assert.deepEqual(actual,expected)
 }
 assert.equal(replaced,3)
 assert.deepEqual(load(new URL('../cordis.patch.yml',import.meta.url)),[{id:'skill-filesystem',disabled:true}])
})
