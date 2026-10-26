import {simulate,recover} from './core.js';
import {CONFIG} from '../data/config.js';
const cache=new Map();
self.onmessage=({data})=>{try{if(data.targets)CONFIG.targets=data.targets;let key=JSON.stringify([data.type,data.plan,CONFIG.targets]),result=cache.get(key);if(!result){result=data.type==='recover'?recover(data.plan):simulate(data.plan);if(cache.size>10)cache.delete(cache.keys().next().value);cache.set(key,result)}self.postMessage({id:data.id,type:data.type,result})}catch(e){self.postMessage({id:data.id,error:e.message})}};
