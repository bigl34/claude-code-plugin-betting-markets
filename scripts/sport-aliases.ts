/**
 * Sport Key Alias Map for The Odds API
 *
 * Maps common search terms to The Odds API sport keys.
 * Used by TheOddsClient.search() to determine which sport
 * endpoint(s) to query without wasting credits guessing.
 *
 * The Odds API charges 1 credit per sport+region request,
 * so accurate alias matching is critical for credit conservation.
 */

// =============================================================================
// Alias Map
// =============================================================================

/**
 * Maps sport keys → arrays of aliases (team names, league names, common terms).
 * Case-insensitive substring matching is used at search time.
 */
export const SPORT_ALIASES: Record<string, string[]> = {
  // ── Football/Soccer ───────────────────────────────────────────
  soccer_epl: [
    'premier league', 'epl',
    'arsenal', 'chelsea', 'liverpool', 'man city', 'manchester city',
    'man united', 'manchester united', 'tottenham', 'spurs',
    'newcastle', 'aston villa', 'west ham', 'brighton',
    'everton', 'crystal palace', 'fulham', 'wolves',
    'bournemouth', 'brentford', 'nottingham forest', 'ipswich', 'leicester',
    'southampton',
  ],
  soccer_uefa_champs_league: [
    'champions league', 'ucl', 'champions league final',
  ],
  soccer_uefa_europa_league: [
    'europa league',
  ],
  soccer_efl_champ: [
    'championship', 'efl championship',
  ],
  soccer_fa_cup: [
    'fa cup',
  ],
  soccer_spain_la_liga: [
    'la liga', 'real madrid', 'barcelona', 'atletico madrid',
  ],
  soccer_germany_bundesliga: [
    'bundesliga', 'bayern munich', 'dortmund',
  ],
  soccer_italy_serie_a: [
    'serie a', 'juventus', 'ac milan', 'inter milan', 'napoli',
  ],
  soccer_france_ligue_one: [
    'ligue 1', 'psg', 'paris saint germain',
  ],

  // ── American Football ─────────────────────────────────────────
  americanfootball_nfl: [
    'nfl', 'super bowl',
    'chiefs', '49ers', 'eagles', 'cowboys', 'bills',
    'ravens', 'lions', 'packers', 'dolphins', 'jets',
  ],
  americanfootball_ncaaf: [
    'college football', 'ncaaf',
  ],

  // ── Basketball ────────────────────────────────────────────────
  basketball_nba: [
    'nba',
    'lakers', 'celtics', 'warriors', 'bucks', 'nuggets',
    'heat', 'knicks', 'suns', 'mavericks', 'clippers',
  ],

  // ── Tennis ────────────────────────────────────────────────────
  tennis_atp_french_open: ['french open', 'roland garros'],
  tennis_atp_wimbledon: ['wimbledon'],
  tennis_atp_us_open: ['us open tennis'],
  tennis_atp_aus_open: ['australian open'],

  // ── Boxing / MMA ──────────────────────────────────────────────
  mma_mixed_martial_arts: [
    'ufc', 'mma', 'mixed martial arts',
  ],
  boxing_boxing: [
    'boxing',
  ],

  // ── Cricket ───────────────────────────────────────────────────
  cricket_ipl: ['ipl', 'indian premier league'],
  cricket_test_match: ['test cricket', 'ashes'],

  // ── Horse Racing ──────────────────────────────────────────────
  horse_racing_uk: [
    'horse racing', 'cheltenham', 'grand national', 'royal ascot',
  ],

  // ── Politics ──────────────────────────────────────────────────
  politics_us_presidential_election_winner: [
    'president', 'presidential', 'trump', 'election', 'biden',
    'white house', 'democrat', 'republican',
  ],

  // ── Golf ──────────────────────────────────────────────────────
  golf_masters_tournament_winner: ['masters', 'augusta'],
  golf_pga_championship_winner: ['pga championship'],
  golf_the_open_championship_winner: ['the open', 'british open'],
  golf_us_open_winner: ['us open golf'],

  // ── Rugby ─────────────────────────────────────────────────────
  rugbyunion_six_nations: [
    'six nations', 'rugby six nations',
  ],

  // ── Formula 1 ─────────────────────────────────────────────────
  motorsport_formula1: [
    'f1', 'formula 1', 'formula one', 'grand prix',
  ],
};

// =============================================================================
// Search Function
// =============================================================================

/**
 * Find sport keys matching a search query.
 *
 * Performs case-insensitive substring matching against all aliases.
 * A query like "arsenal champions league" could match both soccer_epl
 * and soccer_uefa_champs_league.
 *
 * @param query - User search query
 * @returns Array of matching sport keys (may be empty)
 */
export function findSportKeys(query: string): string[] {
  const queryLower = query.toLowerCase();
  const matches: string[] = [];

  for (const [sportKey, aliases] of Object.entries(SPORT_ALIASES)) {
    for (const alias of aliases) {
      if (queryLower.includes(alias)) {
        matches.push(sportKey);
        break; // One match per sport key is enough
      }
    }
  }

  return matches;
}
