import { randomUUID } from "crypto";
import { getDatabase, Tournament, TournamentScore } from "./schema";

export function createTournament(
  groupId: string,
  durationMinutes: number,
  createdBy: string
): Tournament {
  const db = getDatabase();
  const now = Date.now();
  const id = randomUUID();
  const endTs = now + durationMinutes * 60 * 1000;

  db.prepare(
    `INSERT INTO tournaments (id, group_id, start_ts, end_ts, status, created_by)
     VALUES (?, ?, ?, ?, 'active', ?)`
  ).run(id, groupId, now, endTs, createdBy);

  return db
    .prepare("SELECT * FROM tournaments WHERE id = ?")
    .get(id) as Tournament;
}

export function getActiveTournament(groupId: string): Tournament | null {
  const db = getDatabase();
  const now = Date.now();

  return (
    (db
      .prepare(
        "SELECT * FROM tournaments WHERE group_id = ? AND status = 'active' AND end_ts > ?"
      )
      .get(groupId, now) as Tournament) || null
  );
}

export function completeTournament(tournamentId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE tournaments SET status = 'completed' WHERE id = ?").run(
    tournamentId
  );
}

export function updateTournamentScore(
  tournamentId: string,
  telegramId: string,
  netPnl: number
): void {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO tournament_scores (tournament_id, telegram_id, net_pnl, trade_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(tournament_id, telegram_id)
     DO UPDATE SET 
       net_pnl = net_pnl + ?,
       trade_count = trade_count + 1`
  ).run(tournamentId, telegramId, netPnl, netPnl);
}

export function getTournamentScores(
  tournamentId: string
): Array<TournamentScore & { username: string | null }> {
  const db = getDatabase();

  return db
    .prepare(
      `SELECT ts.*, u.username
       FROM tournament_scores ts
       INNER JOIN users u ON ts.telegram_id = u.telegram_id
       WHERE ts.tournament_id = ?
       ORDER BY ts.net_pnl DESC, ts.trade_count DESC`
    )
    .all(tournamentId) as Array<TournamentScore & { username: string | null }>;
}

export function checkExpiredTournaments(): Tournament[] {
  const db = getDatabase();
  const now = Date.now();

  const expired = db
    .prepare(
      "SELECT * FROM tournaments WHERE status = 'active' AND end_ts <= ?"
    )
    .all(now) as Tournament[];

  // Mark them as completed
  for (const tournament of expired) {
    completeTournament(tournament.id);
  }

  return expired;
}
