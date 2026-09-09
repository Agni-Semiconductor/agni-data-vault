/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { parseFilename, buildStoragePath, kindFromExtension } from '../api/_lib/storage.js';
import { pickAllowed, parsePagination, requireDate, requireUuid } from '../api/_lib/validate.js';
import { __setCacheForTests, validateEntity } from '../api/_lib/fieldDefs.js';
describe('api core', () => {
  it('parses dciv filename',()=>expect(parseFilename('Dhiren Site@1 Subsite capacitor DC-IV#1 Run4482 04-21-2026.xlsx')).toEqual({run_number:4482,file_date:'2026-04-21',detected_kind:'dciv'}));
  it('parses aciv filename',()=>expect(parseFilename('Spencer Site@1 Basic Tests capacitor AC IV#1 Run41 07-24-2026.xls')).toEqual({run_number:41,file_date:'2026-07-24',detected_kind:'aciv'}));
  it('parses pund filename',()=>expect(parseFilename('FeCap Site@1 Subsite capacitor PUND_half_int#1 Run5486 07-07-2026.xlsx').detected_kind).toBe('pund'));
  it('detects abbreviated dciv',()=>expect(parseFilename('20-DC-3.xlsx')).toEqual({run_number:null,file_date:null,detected_kind:'dciv'}));
  it('detects campaign dciv',()=>expect(parseFilename('cap_camp_x_r000c002_dciv.csv').detected_kind).toBe('dciv'));
  it('builds a sanitized storage path',()=>expect(buildStoragePath('S 1','mid','bad<>.csv')).toBe('samples/S 1/mid/bad__.csv'));
  it('classifies extensions',()=>expect(kindFromExtension('a.xlsx')).toBe('raw_xls'));
  it('classifies plot extensions',()=>expect(kindFromExtension('a.png')).toBe('plot_png'));
  it('uses pagination defaults',()=>expect(parsePagination({})).toEqual({limit:50,offset:0}));
  it('caps pagination',()=>expect(parsePagination({limit:'999',offset:'2'})).toEqual({limit:200,offset:2}));
  it('rejects non uuid ids',()=>expect(()=>requireUuid('not-a-uuid')).toThrow(/uuid/));
  it('picks allowed keys with warnings',()=>{const w=[];expect(pickAllowed({a:1,b:2},['a'],w)).toEqual({a:1});expect(w).toEqual(['unknown key "b" ignored']);});
  const defs={sample:[{key:'label',type:'text',column_name:'label',active:true,required:true,sort_order:1},{key:'custom',type:'number',column_name:null,active:true,required:false,sort_order:2},{key:'when',type:'date',column_name:null,active:true,required:false,sort_order:3},{key:'owner',type:'select',options_list_key:'people',column_name:null,active:true,required:false,sort_order:4}]};
  it('routes fields to columns and meta',async()=>{__setCacheForTests(defs,{people:[{value:'spencer',active:true}]});const r=await validateEntity('sample',{label:'A',custom:'4',meta_status:{custom:'assumed'}});expect(r.columns.label).toBe('A');expect(r.meta.custom).toBe(4);expect(r.meta_status.custom).toBe('assumed');});
  it('rejects a bad date with details',async()=>{__setCacheForTests(defs,{});await expect(validateEntity('sample',{label:'A',when:'no'})).rejects.toMatchObject({status:422,details:[{key:'when',message:'must be YYYY-MM-DD'}]});});
  it('rejects impossible dates and null required values', async()=>{ __setCacheForTests(defs,{}); expect(()=>requireDate('2026-02-30')).toThrow(); await expect(validateEntity('sample',{label:null})).rejects.toMatchObject({status:422,details:[{key:'label',message:'required'}]}); });
  it('warns for unknown keys',async()=>{__setCacheForTests(defs,{});expect((await validateEntity('sample',{label:'A',wat:2})).warnings).toEqual(['unknown key "wat" ignored']);});
  it('rejects inactive option unless current',async()=>{__setCacheForTests(defs,{people:[{value:'old',active:false}]});await expect(validateEntity('sample',{label:'A',owner:'old'})).rejects.toMatchObject({status:422});expect((await validateEntity('sample',{label:'A',owner:'old'},{current:{meta:{owner:'old'}}})).meta.owner).toBe('old');});
});
