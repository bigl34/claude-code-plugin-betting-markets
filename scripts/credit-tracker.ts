/**
 * The Odds API Credit Tracker
 *
 * Persistent credit tracking with circuit breaker for The Odds API's
 * free tier (500 credits/month). Uses atomic file I/O to prevent corruption
 * and auto-resets counters on month boundaries.
 *
 * Storage: ~/.cache/plugin-cache/betting-markets-manager/theodds-credits.json
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CreditStatus } from './types.js';

// =============================================================================
// Types
// =============================================================================

interface RequestLogEntry {
  timestamp: string;
  endpoint: string;
  creditsUsed: number;
}

interface CreditState {
  creditsUsed: number;
  creditsRemaining: number;
  lastUpdated: string;
  monthStart: string;       // YYYY-MM format for detecting month rollover
  monthlyBudget: number;
  requestLog: RequestLogEntry[];
  liveUsageConfirmed: boolean;
}

function parseCreditHeader(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// =============================================================================
// Credit Tracker
// =============================================================================

const CACHE_DIR = join(homedir(), '.cache', 'plugin-cache', 'betting-markets-manager');
const STATE_FILE = join(CACHE_DIR, 'theodds-credits.json');
const MAX_LOG_ENTRIES = 100;

export class CreditTracker {
  private state: CreditState;
  private budget: number;

  constructor(monthlyBudget: number = 400) {
    this.budget = monthlyBudget;
    this.state = this.loadState();
    this.state.liveUsageConfirmed ??= false;
    this.state.monthlyBudget = monthlyBudget;
    this.checkMonthReset();
  }

  // ============================================
  // STATE PERSISTENCE
  // ============================================

  private loadState(): CreditState {
    if (!existsSync(STATE_FILE)) {
      return this.createFreshState();
    }

    try {
      const raw = readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw) as CreditState;
    } catch {
      return this.createFreshState();
    }
  }

  private createFreshState(): CreditState {
    const now = new Date();
    return {
      creditsUsed: 0,
      creditsRemaining: this.budget,
      lastUpdated: now.toISOString(),
      monthStart: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      monthlyBudget: this.budget,
      requestLog: [],
      liveUsageConfirmed: false,
    };
  }

  private saveState(): void {
    // Ensure directory exists
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    // Atomic write: temp file + rename
    const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
    try {
      writeFileSync(tmpFile, JSON.stringify(this.state, null, 2));
      renameSync(tmpFile, STATE_FILE);
    } catch (error) {
      // Clean up temp file on error
      try {
        if (existsSync(tmpFile)) {
          unlinkSync(tmpFile);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  // ============================================
  // MONTH RESET
  // ============================================

  private checkMonthReset(): void {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    if (this.state.monthStart !== currentMonth) {
      this.state = this.createFreshState();
      this.saveState();
    }
  }

  // ============================================
  // CREDIT CHECKS
  // ============================================

  /**
   * Check if we have enough credits for a request.
   * Returns true if the request should proceed.
   *
   * This is evaluated only after a free live-usage preflight. The configured
   * budget is intentionally independent of the provider account's allowance.
   */
  canMakeRequest(estimatedCost: number = 1): boolean {
    this.checkMonthReset();

    return this.state.liveUsageConfirmed === true &&
      this.state.creditsUsed + estimatedCost <= this.budget;
  }

  /**
   * Record a request before it's made (pessimistic tracking).
   * Call updateFromHeaders() after the response for accurate counts.
   */
  recordRequest(endpoint: string, estimatedCost: number = 1): void {
    this.state.creditsUsed += estimatedCost;
    this.state.creditsRemaining = Math.max(0, this.state.creditsRemaining - estimatedCost);
    this.state.lastUpdated = new Date().toISOString();

    // Append to log, trim if needed
    this.state.requestLog.push({
      timestamp: new Date().toISOString(),
      endpoint,
      creditsUsed: estimatedCost,
    });

    if (this.state.requestLog.length > MAX_LOG_ENTRIES) {
      this.state.requestLog = this.state.requestLog.slice(-MAX_LOG_ENTRIES);
    }

    this.saveState();
  }

  /**
   * Update credit counts from The Odds API response headers.
   * The API returns x-requests-remaining and x-requests-used headers.
   */
  updateFromHeaders(headers: Headers): boolean {
    const remaining = parseCreditHeader(headers.get('x-requests-remaining'));
    const used = parseCreditHeader(headers.get('x-requests-used'));

    if (remaining !== undefined) {
      this.state.creditsRemaining = remaining;
    }
    if (used !== undefined) {
      this.state.creditsUsed = used;
      this.state.liveUsageConfirmed = true;
    }

    if (remaining !== undefined || used !== undefined) {
      this.state.lastUpdated = new Date().toISOString();
      this.saveState();
    }
    return used !== undefined;
  }

  // ============================================
  // STATUS
  // ============================================

  /**
   * Get formatted credit status for the credit-status CLI command.
   */
  getCreditStatus(): CreditStatus {
    this.checkMonthReset();

    return {
      used: this.state.creditsUsed,
      remaining: this.state.creditsRemaining,
      budget: this.state.monthlyBudget,
      lastUpdated: this.state.lastUpdated,
      percentUsed: this.state.monthlyBudget > 0
        ? Math.round((this.state.creditsUsed / this.state.monthlyBudget) * 100 * 100) / 100
        : 0,
    };
  }

  /**
   * Get a human-readable summary string.
   */
  getFormattedStatus(): string {
    const status = this.getCreditStatus();
    const bar = this.progressBar(status.percentUsed);

    return [
      `The Odds API Credits (${this.state.monthStart})`,
      `${'─'.repeat(40)}`,
      `Used:      ${status.used} / ${status.budget}`,
      `Remaining: ${status.remaining}`,
      `Usage:     ${bar} ${status.percentUsed}%`,
      `Updated:   ${status.lastUpdated}`,
      `Requests:  ${this.state.requestLog.length} this month`,
    ].join('\n');
  }

  private progressBar(percent: number): string {
    const width = 20;
    const barPercent = Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : 0;
    const filled = Math.round((barPercent / 100) * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }
}
