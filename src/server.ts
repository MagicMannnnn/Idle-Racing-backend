import express from "express"
import http from "http"
import cors from "cors"
import { Server } from "socket.io"
import { query } from "./db.js"

const PORT = Number(process.env.PORT || 3000)

const app = express()
app.use(cors())
app.use(express.json())

function log(...args: any[]) {
  console.log(new Date().toISOString(), ...args)
}

app.get("/health", async (_req, res) => {
  await query("SELECT 1")
  res.json({ ok: true })
})

const server = http.createServer(app)
const io = new Server(server, { cors: { origin: "*" } })

type Driver = { name: string; number: number; rating: number }

type RaceRow = {
  race_id: string
  track: string
  laps: number
  ai_count: number
  host_user_id: string
  started: boolean
  updated_at: string
}

type RaceConfig = {
  raceID: string
  track: string
  laps: number
  aiCount: number
  drivers: Driver[]
  hostUserId: string
  started: boolean
  updatedAt: number
}

type AckOk<T extends object> = { ok: true } & T
type AckErr = { ok: false; error: string }
type Ack<T extends object> = AckOk<T> | AckErr

async function ensureMembership(raceID: string, userId: string) {
  await query(
    `INSERT INTO race_users (race_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (race_id, user_id) DO NOTHING`,
    [raceID, userId]
  )
}

async function getRaceConfig(raceID: string): Promise<RaceConfig | null> {
  const raceRes = await query(
    `SELECT race_id, track, laps, ai_count, host_user_id, started, updated_at
     FROM races
     WHERE race_id = $1`,
    [raceID]
  )
  const race = (raceRes.rows?.[0] as RaceRow | undefined)
  if (!race) return null

  // merge all drivers from all users in this race into one list
  const driversRes = await query(
    `SELECT drivers
     FROM race_user_drivers
     WHERE race_id = $1
     ORDER BY updated_at ASC`,
    [raceID]
  )

  const merged: Driver[] = []
  for (const row of driversRes.rows as any[]) {
    const arr = Array.isArray(row.drivers) ? row.drivers : []
    merged.push(...(arr as Driver[]))
  }

  return {
    raceID: race.race_id,
    track: race.track,
    laps: race.laps,
    aiCount: race.ai_count,
    drivers: merged,
    hostUserId: race.host_user_id,
    started: race.started,
    updatedAt: new Date(race.updated_at).getTime(),
  }
}

async function broadcastState(raceID: string) {
  const cfg = await getRaceConfig(raceID)
  if (!cfg) return
  io.to(raceID).emit("race:state", cfg)
  log(`[broadcast] race:state -> room=${raceID} drivers=${cfg.drivers.length} started=${cfg.started}`)
}

io.on("connection", (socket) => {
  log(`[socket] connected id=${socket.id}`)

  socket.on("disconnect", (reason) => {
    log(`[socket] disconnected id=${socket.id} reason=${reason}`)
  })

  socket.on("ping", () => {
    log(`[socket] ping from ${socket.id}`)
    socket.emit("pong")
  })

  // HOST creates a race
  socket.on("race:create", async (payload: any, ack?: (res: Ack<{ state: RaceConfig }>) => void) => {
    log(`[event] race:create from=${socket.id}`, payload)

    const raceID = payload?.raceID
    const track = payload?.track
    const laps = payload?.laps
    const aiCount = payload?.aiCount
    const userId = payload?.userId

    if (!raceID || !track || typeof laps !== "number" || typeof aiCount !== "number" || !userId) {
      return ack?.({ ok: false, error: "Invalid payload" })
    }

    try {
      await query("BEGIN")

      await query(
        `INSERT INTO races (race_id, track, laps, ai_count, host_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [raceID, track, laps, aiCount, userId]
      )

      await ensureMembership(raceID, userId)

      await query("COMMIT")

      socket.join(raceID)
      log(`[room] ${socket.id} joined room=${raceID} (host create)`)

      const cfg = await getRaceConfig(raceID)
      if (!cfg) return ack?.({ ok: false, error: "Race created but not found" })

      ack?.({ ok: true, state: cfg })

      // notify everyone in room (currently just host)
      await broadcastState(raceID)
    } catch (e: any) {
      await query("ROLLBACK").catch(() => {})
      const msg = String(e?.message ?? e)
      log(`[error] race:create raceID=${raceID}`, msg)
      if (msg.includes("duplicate key") || msg.includes("already exists")) {
        return ack?.({ ok: false, error: "RaceID already exists" })
      }
      return ack?.({ ok: false, error: "Failed to create race" })
    }
  })

  // User joins an existing race
  socket.on("race:join", async (payload: any, ack?: (res: Ack<{ state: RaceConfig; host?: boolean }>) => void) => {
    log(`[event] race:join from=${socket.id}`, payload)

    const raceID = payload?.raceID
    const userId = payload?.userId
    if (!raceID || !userId) return ack?.({ ok: false, error: "Invalid payload" })

    const cfg = await getRaceConfig(raceID)
    if (!cfg) return ack?.({ ok: false, error: "Race not found" })

    try {
      await ensureMembership(raceID, userId)

      socket.join(raceID)
      log(`[room] ${socket.id} joined room=${raceID} (join)`)

      ack?.({ ok: true, state: cfg, host: cfg.hostUserId === userId })

      io.to(raceID).emit("race:user_joined", { socketId: socket.id })
      log(`[broadcast] race:user_joined -> room=${raceID} socketId=${socket.id}`)

      await broadcastState(raceID)
    } catch (e: any) {
      log(`[error] race:join raceID=${raceID}`, String(e?.message ?? e))
      ack?.({ ok: false, error: "Failed to join race" })
    }
  })

  // Each user submits their drivers[] (stored per userId)
  socket.on(
    "race:drivers_update",
    async (payload: any, ack?: (res: Ack<{}>) => void) => {
      log(`[event] race:drivers_update from=${socket.id}`, payload)

      const raceID = payload?.raceID
      const userId = payload?.userId
      const drivers = payload?.drivers

      if (!raceID || !userId || !Array.isArray(drivers)) {
        return ack?.({ ok: false, error: "Invalid payload" })
      }

      const cfg = await getRaceConfig(raceID)
      if (!cfg) return ack?.({ ok: false, error: "Race not found" })
      if (cfg.started) return ack?.({ ok: false, error: "Race already started" })

      try {
        // must be a member first (foreign key); ensure membership
        await ensureMembership(raceID, userId)

        await query(
          `INSERT INTO race_user_drivers (race_id, user_id, drivers)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (race_id, user_id)
           DO UPDATE SET drivers = EXCLUDED.drivers, updated_at = NOW()`,
          [raceID, userId, JSON.stringify(drivers)]
        )

        // update race updated_at
        await query(`UPDATE races SET updated_at = NOW() WHERE race_id = $1`, [raceID])

        ack?.({ ok: true })
        log(`[db] drivers saved raceID=${raceID} userId=${userId} count=${drivers.length}`)

        await broadcastState(raceID)
      } catch (e: any) {
        log(`[error] race:drivers_update raceID=${raceID}`, String(e?.message ?? e))
        ack?.({ ok: false, error: "Failed to update drivers" })
      }
    }
  )

  // Host starts race (broadcast config)
  socket.on("race:start", async (payload: any, ack?: (res: Ack<{}>) => void) => {
    log(`[event] race:start from=${socket.id}`, payload)

    const raceID = payload?.raceID
    const userId = payload?.userId
    if (!raceID || !userId) return ack?.({ ok: false, error: "Invalid payload" })

    const cfg = await getRaceConfig(raceID)
    if (!cfg) return ack?.({ ok: false, error: "Race not found" })
    if (cfg.started) return ack?.({ ok: false, error: "Race already started" })
    if (cfg.hostUserId !== userId) return ack?.({ ok: false, error: "Only host can start" })

    try {
      await query(`UPDATE races SET started = TRUE, updated_at = NOW() WHERE race_id = $1`, [raceID])

      const startedCfg = await getRaceConfig(raceID)
      if (!startedCfg) return ack?.({ ok: false, error: "Race not found after start" })

      const startedAt = Date.now()

      io.to(raceID).emit("race:started", { config: startedCfg, startedAt })
      log(`[broadcast] race:started -> room=${raceID} drivers=${startedCfg.drivers.length}`)

      await broadcastState(raceID)

      ack?.({ ok: true })
    } catch (e: any) {
      log(`[error] race:start raceID=${raceID}`, String(e?.message ?? e))
      ack?.({ ok: false, error: "Failed to start race" })
    }
  })
})

server.listen(PORT, () => {
  log(`Server running on port ${PORT}`)
})