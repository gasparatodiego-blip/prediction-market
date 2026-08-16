export const PLAN_PRICES: Record<string, number> = {
  free:         0,
  pro:          15,
  profit_share: 0,
};

export function getPlanLimits(plan: string) {
  switch (plan) {
    case 'pro':
    case 'profit_share':
      return {
        maxOpportunities: null,
        telegramAlerts:   true,
        emailAlerts:      true,
        kellySizing:      true,
        realtimeData:     true,
        portfolioTracker: true,
        dataDelay:        0,
      };
    default: // free
      return {
        maxOpportunities: 3,
        telegramAlerts:   false,
        emailAlerts:      false,
        kellySizing:      false,
        realtimeData:     false,
        portfolioTracker: true,
        dataDelay:        300,
      };
  }
}
