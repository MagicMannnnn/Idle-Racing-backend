import express from "express"
import http from "http"
import cors from "cors"
import { Server } from "socket.io"
import { query } from "./db.js"

const PORT = Number(process.env.PORT || 3000)

const app = express()
app.use(cors())
app.use(express.json())

app.get("/health", async (_req, res) => {
  await query("SELECT 1")
  res.json({ ok: true })
})

const server = http.createServer(app)
const io = new Server(server, { cors: { origin: "*" } })

io.on("connection", (socket) => {
  socket.on("ping", () => {
    socket.emit("pong")
  })
})

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
