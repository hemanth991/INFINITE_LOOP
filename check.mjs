import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
if (existsSync('dist/data/families.json')) throw Error('Private account data must not be present in dist/. Move it to private storage before building.');
async function check(dir){for(const f of await readdir(dir,{withFileTypes:true})){let p=dir+'/'+f.name;if(f.isDirectory())await check(p);else if(p.endsWith('.js')){let r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status)throw Error(r.stderr)}}}await check('dist');let html=await readFile('dist/index.html','utf8');if(!html.includes('app.js'))throw Error('Missing application entry');console.log('All modules parse. Static application is ready in dist/.');
for(const route of ['start','overview','profile','goals','cashflow','debt','invest','stress','fix','compare','action','method']){await mkdir('dist/'+route,{recursive:true});await writeFile('dist/'+route+'/index.html',html)}
