// Types for lib/guardian-health.js — the guardian robustness/uptime report (rules 51–74).
export interface GuardianFeedHealth { label: string; ageMin: number | null; stale: boolean; present: boolean; }
export interface GuardianDashboardHttp { healthy: boolean; detail: string; restarted: boolean; }
export interface GuardianHealthReport {
  ok:       boolean;               // nothing needs a human right now
  degraded: boolean;               // calm degradation active (stale/partial data, site up)
  banner:   string | null;         // global "dati non aggiornati" banner (rule 48/62)
  pipeline: { ageMin: number | null; stale: boolean };
  feeds:    GuardianFeedHealth[];
  watchdog: {
    monitorAgeMin: number | null;
    monitorFresh:  boolean;
    allHealthy:    boolean | null;
    dashboardHttp: GuardianDashboardHttp | null;
    unhealthyAgents: string[];
  };
  build: {
    buildIdPresent: boolean;
    phase:          'idle' | 'building';
    lastResult:     'ok' | 'fail' | null;
    treeCoherent:   boolean | null;
    deployHeldBack: boolean;
  };
  guardian: {
    auditorUp:      boolean;
    auditorAgeMin:  number | null;
    directiveCount: number;
    readOnly:       boolean;
    everyActionLogged: boolean;
    posture:        string;
  };
  checkedAt: string;
}
export declare function getGuardianHealth(now?: number): GuardianHealthReport;
export declare const CORE_FEEDS: Array<{ file: string; tsKey: string; label: string }>;
export declare const PIPELINE_STALE_MS: number;
export declare const FEED_STALE_MS: number;
export declare const AUDITOR_DOWN_MS: number;
