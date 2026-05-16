import { getDatabase, CopyFollow } from "./schema";

export function createCopyFollow(
  followerId: string,
  leaderId: string,
  ratio: number = 1.0
): void {
  const db = getDatabase();
  const now = Date.now();

  db.prepare(
    `INSERT INTO copy_follows (follower_id, leader_id, ratio, active, created_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(follower_id, leader_id) 
     DO UPDATE SET active = 1, ratio = ?`
  ).run(followerId, leaderId, ratio, now, ratio);
}

export function removeCopyFollow(followerId: string, leaderId?: string): void {
  const db = getDatabase();

  if (leaderId) {
    db.prepare(
      "UPDATE copy_follows SET active = 0 WHERE follower_id = ? AND leader_id = ?"
    ).run(followerId, leaderId);
  } else {
    // Remove all follows
    db.prepare("UPDATE copy_follows SET active = 0 WHERE follower_id = ?").run(
      followerId
    );
  }
}

export function getActiveFollows(followerId: string): CopyFollow[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM copy_follows WHERE follower_id = ? AND active = 1"
    )
    .all(followerId) as CopyFollow[];
}

export function getFollowers(leaderId: string): CopyFollow[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM copy_follows WHERE leader_id = ? AND active = 1"
    )
    .all(leaderId) as CopyFollow[];
}

export function getFollowCount(followerId: string): number {
  const db = getDatabase();
  const result = db
    .prepare(
      "SELECT COUNT(*) as count FROM copy_follows WHERE follower_id = ? AND active = 1"
    )
    .get(followerId) as { count: number };

  return result.count;
}

export function getCopyLeaderboard(limit: number = 5): Array<{
  leader_id: string;
  username: string | null;
  follower_count: number;
  total_pnl: number;
  win_rate: number;
}> {
  const db = getDatabase();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  return db
    .prepare(
      `SELECT 
        u.telegram_id as leader_id,
        u.username,
        COUNT(DISTINCT cf.follower_id) as follower_count,
        u.total_pnl,
        CASE 
          WHEN (u.win_count + u.loss_count) > 0 
          THEN CAST(u.win_count AS REAL) / (u.win_count + u.loss_count) * 100
          ELSE 0 
        END as win_rate
       FROM users u
       INNER JOIN copy_follows cf ON u.telegram_id = cf.leader_id
       WHERE cf.active = 1
       GROUP BY u.telegram_id
       ORDER BY follower_count DESC, u.total_pnl DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    leader_id: string;
    username: string | null;
    follower_count: number;
    total_pnl: number;
    win_rate: number;
  }>;
}

export function isFollowing(followerId: string, leaderId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      "SELECT COUNT(*) as count FROM copy_follows WHERE follower_id = ? AND leader_id = ? AND active = 1"
    )
    .get(followerId, leaderId) as { count: number };

  return result.count > 0;
}
