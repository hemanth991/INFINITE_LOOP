export const CONFIG = {
  version: '2026.10.25-2', asOf: '2026-10-25', seed: 42, paths: 1000,
  currency: 'INR', inflation: {general:.06,home:.07,education:.10,medical:.12,retirement:.06,equipment:.05,emergency:0,debt:0},
  assets: [
    {id:'equity',name:'Diversified Indian equity',mean:.105,vol:.20},
    {id:'debt',name:'Short-duration debt',mean:.065,vol:.045},
    {id:'gold',name:'Gold in INR',mean:.075,vol:.17},
    {id:'liquid',name:'Liquid reserve',mean:.055,vol:.008}
  ],
  correlation:[[1,.10,.05,0],[.10,1,.15,.2],[.05,.15,1,0],[0,.2,0,1]],
  inflationPhi:.85,inflationVol:.006,targets:{Need:.90,Want:.80,Wish:.70},
  tax:{slab:.30,ltcg:.125,stcg:.20,exemption:125000,holdingMonths:12,cess:.04,
    reference:'Equity capital gains concepts; Income-tax Act 2025, section 198 (LTCG).',
    source:'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/Finance_Bill.pdf'},
  rates:{fd:.065,savings:.03,epf:.0825,ppf:.071,nps:.08,usd:.04,fx:.025,regularFee:.015,directFee:.002},
  reserveMonths:6, circuitMonths:3, medicalShock:1200000,termIncomeMultiple:12,
  ufpiWeights:[.5,.3,.2],maxDelay:24,
  dataNote:'All return, volatility, correlation and statutory savings rates are editable modelling assumptions, not live quotes. Bundled market series are illustrative and cannot establish historical performance.',
  sources:[{name:'Income Tax Department — Finance Bill 2026',url:'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/Finance_Bill.pdf',retrieved:'2026-10-25'},{name:'RBI — Sovereign Gold Bonds',url:'https://sovereigngoldbonds.rbi.org.in/',retrieved:'2026-10-25'}]
};
