// ========================================
// 밸런스 게임 · Express + Postgres(Supabase) 서버
// ========================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------
// DB 연결 (Supabase pooler — SSL 필수)
// 환경변수 trailing newline 방지를 위해 .trim()
// ----------------------------------------
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// ----------------------------------------
// Lazy init: cold start마다 호출돼도 한 번만 실행
// ----------------------------------------
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id          SERIAL PRIMARY KEY,
      option_a    TEXT NOT NULL,
      option_b    TEXT NOT NULL,
      votes_a     INT NOT NULL DEFAULT 0,
      votes_b     INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id           SERIAL PRIMARY KEY,
      question_id  INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      voter_id     TEXT NOT NULL,
      choice       CHAR(1) NOT NULL CHECK (choice IN ('A', 'B')),
      UNIQUE (question_id, voter_id)
    );
  `);
  dbInitialized = true;
}

// ----------------------------------------
// Middleware
// ----------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// /api 진입 전 DB 초기화 보장
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다.' });
  }
});

// ----------------------------------------
// API: 질문 목록 조회
//   ?voterId=xxx 를 넘기면 내 투표 기록(myVote)도 함께 반환
// ----------------------------------------
app.get('/api/questions', async (req, res) => {
  try {
    const voterId = (req.query.voterId || '').trim();

    const { rows: questions } = await pool.query(
      `SELECT id, option_a, option_b, votes_a, votes_b, created_at
         FROM questions
        ORDER BY created_at DESC, id DESC`
    );

    // 내 투표 매핑
    let myVotes = {};
    if (voterId) {
      const { rows: voteRows } = await pool.query(
        `SELECT question_id, choice FROM votes WHERE voter_id = $1`,
        [voterId]
      );
      myVotes = voteRows.reduce((acc, r) => {
        acc[r.question_id] = r.choice;
        return acc;
      }, {});
    }

    const data = questions.map((q) => ({
      id: q.id,
      optionA: q.option_a,
      optionB: q.option_b,
      votesA: q.votes_a,
      votesB: q.votes_b,
      createdAt: q.created_at,
      myVote: myVotes[q.id] || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/questions error:', err);
    res.status(500).json({ success: false, message: '질문을 불러오지 못했습니다.' });
  }
});

// ----------------------------------------
// API: 새 질문 등록
// ----------------------------------------
app.post('/api/questions', async (req, res) => {
  try {
    const optionA = (req.body.optionA || '').trim();
    const optionB = (req.body.optionB || '').trim();

    if (!optionA || !optionB) {
      return res.status(400).json({ success: false, message: 'A안과 B안을 모두 입력해주세요.' });
    }
    if (optionA === optionB) {
      return res.status(400).json({ success: false, message: '두 선택지가 동일합니다.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO questions (option_a, option_b)
       VALUES ($1, $2)
       RETURNING id, option_a, option_b, votes_a, votes_b, created_at`,
      [optionA, optionB]
    );
    const q = rows[0];

    res.status(201).json({
      success: true,
      data: {
        id: q.id,
        optionA: q.option_a,
        optionB: q.option_b,
        votesA: q.votes_a,
        votesB: q.votes_b,
        createdAt: q.created_at,
        myVote: null,
      },
    });
  } catch (err) {
    console.error('POST /api/questions error:', err);
    res.status(500).json({ success: false, message: '질문 등록에 실패했습니다.' });
  }
});

// ----------------------------------------
// API: 질문 삭제 (votes 는 ON DELETE CASCADE)
// ----------------------------------------
app.delete('/api/questions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, message: '잘못된 질문 ID입니다.' });
    }

    const { rowCount } = await pool.query(`DELETE FROM questions WHERE id = $1`, [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '질문을 찾을 수 없습니다.' });
    }

    res.json({ success: true, message: '삭제되었습니다.' });
  } catch (err) {
    console.error('DELETE /api/questions/:id error:', err);
    res.status(500).json({ success: false, message: '질문 삭제에 실패했습니다.' });
  }
});

// ----------------------------------------
// API: 투표 (중복 방지 + 선택 변경 시 득표 재계산)
//   body: { voterId, choice: 'A' | 'B' }
//   - 처음 투표: 새 선택지 +1
//   - 같은 선택지 재투표: 변화 없음
//   - 다른 선택지로 변경: 이전 -1, 새 선택 +1
//   동시성 안전을 위해 트랜잭션으로 처리
// ----------------------------------------
app.post('/api/questions/:id/vote', async (req, res) => {
  const client = await pool.connect();
  try {
    const questionId = parseInt(req.params.id, 10);
    const voterId = (req.body.voterId || '').trim();
    const choice = (req.body.choice || '').trim().toUpperCase();

    if (Number.isNaN(questionId)) {
      return res.status(400).json({ success: false, message: '잘못된 질문 ID입니다.' });
    }
    if (!voterId) {
      return res.status(400).json({ success: false, message: 'voterId가 필요합니다.' });
    }
    if (choice !== 'A' && choice !== 'B') {
      return res.status(400).json({ success: false, message: "choice 는 'A' 또는 'B' 여야 합니다." });
    }

    await client.query('BEGIN');

    // 질문 잠금 조회 (없으면 404)
    const qRes = await client.query(
      `SELECT id FROM questions WHERE id = $1 FOR UPDATE`,
      [questionId]
    );
    if (qRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: '질문을 찾을 수 없습니다.' });
    }

    // 기존 투표 확인
    const prevRes = await client.query(
      `SELECT choice FROM votes WHERE question_id = $1 AND voter_id = $2`,
      [questionId, voterId]
    );
    const prevChoice = prevRes.rowCount > 0 ? prevRes.rows[0].choice : null;

    if (prevChoice === choice) {
      // 변화 없음 — 현재 상태만 반환
      await client.query('COMMIT');
    } else {
      if (prevChoice === null) {
        // 신규 투표
        await client.query(
          `INSERT INTO votes (question_id, voter_id, choice) VALUES ($1, $2, $3)`,
          [questionId, voterId, choice]
        );
        await client.query(
          `UPDATE questions
              SET votes_a = votes_a + CASE WHEN $1 = 'A' THEN 1 ELSE 0 END,
                  votes_b = votes_b + CASE WHEN $1 = 'B' THEN 1 ELSE 0 END
            WHERE id = $2`,
          [choice, questionId]
        );
      } else {
        // 선택 변경: 이전 -1, 새 선택 +1
        await client.query(
          `UPDATE votes SET choice = $1 WHERE question_id = $2 AND voter_id = $3`,
          [choice, questionId, voterId]
        );
        await client.query(
          `UPDATE questions
              SET votes_a = votes_a
                    + CASE WHEN $1 = 'A' THEN 1 ELSE 0 END
                    - CASE WHEN $2 = 'A' THEN 1 ELSE 0 END,
                  votes_b = votes_b
                    + CASE WHEN $1 = 'B' THEN 1 ELSE 0 END
                    - CASE WHEN $2 = 'B' THEN 1 ELSE 0 END
            WHERE id = $3`,
          [choice, prevChoice, questionId]
        );
      }
      await client.query('COMMIT');
    }

    // 최신 상태 반환
    const { rows } = await pool.query(
      `SELECT id, option_a, option_b, votes_a, votes_b, created_at
         FROM questions WHERE id = $1`,
      [questionId]
    );
    const q = rows[0];

    res.json({
      success: true,
      data: {
        id: q.id,
        optionA: q.option_a,
        optionB: q.option_b,
        votesA: q.votes_a,
        votesB: q.votes_b,
        createdAt: q.created_at,
        myVote: choice,
      },
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error('POST /api/questions/:id/vote error:', err);
    res.status(500).json({ success: false, message: '투표 처리에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// ----------------------------------------
// SPA fallback (Express 5 문법)
// ----------------------------------------
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------------------------------
// Local: 서버 시작 / Vercel: app export
// ----------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 밸런스 게임 서버 실행 중 → http://localhost:${PORT}`);
  });
}

module.exports = app;
