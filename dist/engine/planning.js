export function capitalSummary(plan, goals = plan.goals) {
  const savings = Math.max(0, Number(plan.savings) || 0);
  const reserve = Math.max(0, Number(plan.emergency) || 0);
  const earmarked = goals.reduce((total, goal) => total + Math.max(0, Number(goal.earmarked) || 0), 0);
  const available = Math.max(0, savings - reserve);
  return {savings, reserve, earmarked, available, free: Math.max(0, available - earmarked), excess: Math.max(0, earmarked - available)};
}

// Explicit user action only: preserve relative earmarks while fitting the real budget.
// Work in paise; assign rounding residue once so no money is created or lost.
export function fitEarmarks(plan, goals = plan.goals) {
  goals = goals.map(g => g.category === 'emergency' ? {...g, earmarked: 0} : g);
  const {available, earmarked} = capitalSummary(plan, goals);
  if (earmarked <= available) return structuredClone(goals);
  let left = Math.floor(available * 100);
  const last = goals.findLastIndex(g => g.earmarked > 0);
  return goals.map((g, i) => {
    const amount = i === last ? left : Math.min(left, Math.floor((g.earmarked || 0) / earmarked * available * 100));
    left -= amount;
    return {...g, earmarked: amount / 100};
  });
}

export function compactSnapshotResult(result) {
  return {
    totalShortfall: result.totalShortfall,
    healthScore: result.healthScore,
    paths: result.paths,
    goal_outcomes: (result.goal_outcomes || []).map(({bands, series, ...goal}) => goal)
  };
}
