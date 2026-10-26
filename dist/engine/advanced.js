import {CONFIG as C} from '../data/config.js';
import {amortize,rng,quantile,sum,clamp} from './core.js';

export function collateralSwap({principal,oldRate,newRate,fees,collateral,trigger=.7,months=60,volatility=.17},paths=1000){
 let breached=0,random,normal;const loan=amortize({principal,apr:newRate,months});
 for(let n=0;n<paths;n++){random=rng(C.seed+7919*n);normal=()=>Math.sqrt(-2*Math.log(Math.max(1e-12,random())))*Math.cos(2*Math.PI*random());let value=collateral,hit=principal>value*trigger;for(let t=0;t<months;t++){value*=Math.exp((Math.log1p(.06)-.5*volatility**2)/12+volatility/Math.sqrt(12)*normal());if((loan.rows[t]?.balance||0)>value*trigger)hit=true}if(hit)breached++}
 return {annualSaving:principal*(oldRate-newRate)-fees,breachProbability:breached/paths,startingLtv:principal/Math.max(1,collateral),paths,trigger};
}
export function familyTreasury({amount,bankRate,familyRate,fdRate,slab,fees}){return {borrowerAnnualSaving:amount*(bankRate-familyRate)-fees,lenderAnnualDifference:amount*(familyRate-fdRate)*(1-slab),householdAnnualDifference:amount*(bankRate-fdRate*(1-slab)-familyRate*slab)-fees}}
export function bondSensitivity(duration,convexity,yieldChange){return -duration*yieldChange+.5*convexity*yieldChange**2}
export function foreignSleeve(principal,months,usdYield,fxDrift,fxVol=.08,paths=1000){let out=[];for(let n=0;n<paths;n++){let r=rng(C.seed+n*7919),value=principal;for(let t=0;t<months;t++){let z=Math.sqrt(-2*Math.log(Math.max(1e-12,r())))*Math.cos(2*Math.PI*r()),fx=Math.exp((Math.log1p(fxDrift)-.5*fxVol**2)/12+fxVol/Math.sqrt(12)*z);value*=(1+usdYield)**(1/12)*fx}out.push(value)}return {p10:quantile(out,.1),median:quantile(out,.5),p90:quantile(out,.9),lossProbability:out.filter(v=>v<principal).length/paths,principal,months,usdYield,fxDrift,fxVol,paths}}
export function strategySeries(rows,kind,w){let value=1,floor=1/(1+C.rates.fd)**(rows.length/12),returns=[];for(const row of rows){let ret;if(kind==='fd')ret=(1+C.rates.fd)**(1/12)-1;else if(kind==='foreign')ret=.5*((1+row.usdYield)**(1/12)*(1+row.fx)-1)+.5*row.debt;else if(kind==='barbell')ret=.4*row.gold+.35*row.debt+.25*row.liquid;else if(kind==='cppi'){let risky=Math.min(value,3*Math.max(0,value-floor));ret=value>0?(risky*row.equity+(value-risky)*row.liquid)/value:0;floor*=(1+C.rates.fd)**(1/12)}else ret=sum(w.map((v,i)=>v*row[C.assets[i].id]));value*=1+ret;returns.push({...row,equity:ret})}return returns}
export function fractionalKelly(expected,riskFree,volatility){return clamp(.25*(expected-riskFree)/Math.max(.0001,volatility**2),0,.25)}
