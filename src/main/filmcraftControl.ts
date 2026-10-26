import { Socket } from 'node:net'

export interface FilmcraftControlOptions {
  host?: string
  port: number
  token: string
  timeoutMs?: number
  /** Per-request timeout; defaults to timeoutMs. Filmcraft commands can take over 500ms. */
  requestTimeoutMs?: number
}

interface ControlReply {
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

function timeoutError(action: string, timeoutMs: number): Error {
  return new Error(`Filmcraft control ${action} timed out after ${timeoutMs}ms.`)
}

/** Loopback-only JSON-lines client for Filmcraft's authenticated control channel. */
export class FilmcraftControl {
  private readonly socket: Socket
  private readonly token: string
  private readonly timeoutMs: number
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  private constructor(socket: Socket, token: string, timeoutMs: number) {
    this.socket = socket
    this.token = token
    this.timeoutMs = timeoutMs
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', (error: Error) => this.failPending(error))
    socket.on('close', () => this.failPending(new Error('Filmcraft control connection closed.')))
  }

  static async connect(options: FilmcraftControlOptions): Promise<FilmcraftControl> {
    const host = options.host ?? '127.0.0.1'
    if (host !== '127.0.0.1') throw new Error('Filmcraft control only permits 127.0.0.1.')
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(timeoutError('connection', timeoutMs))
      }, timeoutMs)
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      socket.connect(options.port, host, () => {
        clearTimeout(timer)
        socket.removeAllListeners('error')
        resolve()
      })
    })
    return new FilmcraftControl(socket, options.token, options.requestTimeoutMs ?? timeoutMs)
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!method) throw new Error('Filmcraft control request needs a method.')
    const id = this.nextId++
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(timeoutError(`request ${method}`, this.timeoutMs))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.socket.write(`${JSON.stringify({ id, token: this.token, method, ...(params ? { params } : {}) })}\n`)
    return reply
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('engine.execute', { command, params })
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let reply: ControlReply
      try {
        reply = JSON.parse(line) as ControlReply
      } catch {
        this.failPending(new Error('Filmcraft control returned invalid JSON.'))
        this.close()
        return
      }
      if (typeof reply.id !== 'number') continue
      const pending = this.pending.get(reply.id)
      if (!pending) continue
      this.pending.delete(reply.id)
      clearTimeout(pending.timer)
      if (reply.ok === true) pending.resolve(reply.result)
      else pending.reject(new Error(reply.error || 'Filmcraft control request failed.'))
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}
