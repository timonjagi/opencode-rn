import { create } from "zustand"
import { useConnections } from "./connections"
import { useSessions } from "./sessions"
import { send as notify } from "../lib/notifications"
import type { Client, Part, Session, Message } from "../lib/sdk"

// Session status from the server
type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }

// Tool status labels derived from part type
const TOOL_STATUS: Record<string, string> = {
  read: "Gathering context...",
  list: "Searching codebase...",
  grep: "Searching codebase...",
  glob: "Searching codebase...",
  webfetch: "Searching web...",
  edit: "Making edits...",
  write: "Making edits...",
  apply_patch: "Making edits...",
  bash: "Running command...",
  task: "Delegating...",
  todowrite: "Planning...",
  todoread: "Planning...",
}

function statusFromPart(part: Part): string {
  if (part.type === "reasoning") return "Thinking..."
  if (part.type === "tool" && part.tool) return TOOL_STATUS[part.tool] || `Running ${part.tool}...`
  if (part.type === "text") return "Writing..."
  return "Working..."
}

interface EventsState {
  connected: boolean
  sessionStatus: Record<string, SessionStatus>
  statusText: Record<string, string>
  // Permissions & questions (pending per session)
  permissions: Record<
    string,
    Array<{
      id: string
      sessionID: string
      permission: string
      patterns: string[]
      metadata: Record<string, unknown>
      tool?: { messageID: string; callID: string }
    }>
  >
  questions: Record<
    string,
    Array<{
      id: string
      sessionID: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiple?: boolean
        custom?: boolean
      }>
      tool?: { messageID: string; callID: string }
    }>
  >

  connect: () => void
  disconnect: () => void
}

let controller: AbortController | null = null
let isReconnecting = false

function parseJSON<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[]
    } catch {
      return []
    }
  }
  return []
}

function normalizePermission(perm: Record<string, unknown>) {
  const patterns = parseJSON<string>(perm.patterns)
  const inputPatterns = parseJSON<string>(perm.input)
  return {
    id: String(perm.id),
    sessionID: String(perm.sessionID),
    permission: String(perm.permission || perm.tool || perm.name || ""),
    patterns: patterns.length > 0 ? patterns : inputPatterns,
    metadata: (perm.metadata && typeof perm.metadata === "object" ? perm.metadata : {}) as Record<string, unknown>,
    tool:
      perm.tool && typeof perm.tool === "object"
        ? (perm.tool as { messageID: string; callID: string })
        : undefined,
    name: perm.name ? String(perm.name) : undefined,
  }
}

function normalizeQuestion(q: Record<string, unknown>) {
  const questions = parseJSON<Record<string, unknown>>(q.questions)
  const normalizedQuestions = questions.map((item) => {
    const options = parseJSON<{ label: string; description: string }>(item.options)
    return {
      question: String(item.question || ""),
      header: String(item.header || ""),
      options: options.map((opt) =>
        typeof opt === "string" ? { label: opt, description: "" } : { label: String(opt.label || ""), description: String(opt.description || "") },
      ),
      multiple: Boolean(item.multiple),
      custom: item.custom !== false,
    }
  })
  return {
    id: String(q.id),
    sessionID: String(q.sessionID),
    questions: normalizedQuestions,
    tool:
      q.tool && typeof q.tool === "object"
        ? (q.tool as { messageID: string; callID: string })
        : undefined,
  }
}

export async function refreshPending(client: Client, sessionID: string) {
  try {
    const [perms, questions] = await Promise.all([client.permission.list(), client.question.list()])
    const serverPerms = ((perms || []) as Record<string, unknown>[])
      .filter((p) => String(p.sessionID) === sessionID)
      .map(normalizePermission)
    const serverQuestions = ((questions || []) as Record<string, unknown>[])
      .filter((q) => String(q.sessionID) === sessionID)
      .map(normalizeQuestion)

    const serverPermIds = new Set(serverPerms.map((p) => p.id))
    const serverQuestionIds = new Set(serverQuestions.map((q) => q.id))

    useEvents.setState((state) => {
      const localPerms = state.permissions[sessionID] || []
      const localQuestions = state.questions[sessionID] || []
      const existingPermIds = new Set(localPerms.map((p) => p.id))
      const existingQuestionIds = new Set(localQuestions.map((q) => q.id))

      // Add new items from server, keep local items still on server, drop stale
      const mergedPerms = [
        ...serverPerms.filter((p) => !existingPermIds.has(p.id)),
        ...localPerms.filter((p) => serverPermIds.has(p.id)),
      ]
      const mergedQuestions = [
        ...serverQuestions.filter((q) => !existingQuestionIds.has(q.id)),
        ...localQuestions.filter((q) => serverQuestionIds.has(q.id)),
      ]

      return {
        permissions: { ...state.permissions, [sessionID]: mergedPerms },
        questions: { ...state.questions, [sessionID]: mergedQuestions },
      }
    })
  } catch (err) {
    console.warn("[Events] Failed to refresh pending:", err)
  }
}

export const useEvents = create<EventsState>((set, get) => ({
  connected: false,
  sessionStatus: {},
  statusText: {},
  permissions: {},
  questions: {},

  connect: () => {
    // Disconnect existing
    get().disconnect()

    const client = useConnections.getState().client
    if (!client) return

    controller = new AbortController()
    set({ connected: true })
    console.log("[SSE] Connecting to event stream...")

    // Run in background
    ;(async () => {
      try {
        // On reconnect, reconcile pending state with server
        if (isReconnecting) {
          isReconnecting = false
          const currentSession = useSessions.getState().currentSession
          if (currentSession) {
            refreshPending(client, currentSession.id)
          }
        }

        for await (const event of client.global.events(controller?.signal)) {
          if (controller?.signal.aborted) break

          const payload = (event as any).payload || event
          const type = payload.type as string
          const props = payload.properties || {}

          switch (type) {
            case "session.status": {
              const sessionID = props.sessionID as string
              const status = props.status as SessionStatus
              if (!sessionID) break

              // Detect busy → idle transition for completion notification
              const previous = get().sessionStatus[sessionID]
              const completed = previous?.type === "busy" && status.type === "idle"

              set((state) => ({
                sessionStatus: { ...state.sessionStatus, [sessionID]: status },
                // Clear status text when idle
                statusText: status.type === "idle" ? { ...state.statusText, [sessionID]: "" } : state.statusText,
              }))

              // SSE is the source of truth — update sending state unconditionally
              if (status.type === "idle") {
                useSessions.setState((state) => ({
                  sending: { ...state.sending, [sessionID]: false },
                }))
                // Refresh messages if this is the session the user is viewing
                const sessions = useSessions.getState()
                if (sessions.currentSession?.id === sessionID) {
                  sessions.refreshMessages()
                }
              }

              if (completed) {
                const match = useSessions.getState().sessions.find((s) => s.id === sessionID)
                notify({
                  category: "completed",
                  title: "Task completed",
                  body: match?.title || "Session finished processing",
                  sessionId: sessionID,
                })
              }
              break
            }

            case "message.updated": {
              const info = props.info as Message | undefined
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } } as any)
              break
            }

            case "message.part.updated": {
              const part = props.part as Part | undefined
              if (!part) break

              // Update status text from the latest part
              const sessionID = (part as any).sessionID as string
              if (sessionID) {
                set((state) => ({
                  statusText: { ...state.statusText, [sessionID]: statusFromPart(part) },
                }))
              }

              useSessions.getState().handleEvent({ type, properties: { part } } as any)
              break
            }

            case "message.removed": {
              const messageID = props.messageID as string
              if (!messageID) break
              useSessions.getState().handleEvent({ type, properties: { messageID } } as any)
              break
            }

            case "message.part.removed": {
              const partID = props.partID as string
              const messageID = props.messageID as string
              if (!partID || !messageID) break
              useSessions.setState((state) => {
                const msgParts = state.parts[messageID]
                if (!msgParts) return {}
                return {
                  parts: {
                    ...state.parts,
                    [messageID]: msgParts.filter((p) => p.id !== partID),
                  },
                }
              })
              break
            }

            case "session.updated": {
              const info = props.info as Session | undefined
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } } as any)
              break
            }

            case "session.created": {
              const info = props.info as Session | undefined
              if (!info) break
              if (info.parentID) break
              // Add to sessions list
              useSessions.setState((state) => {
                const exists = state.sessions.some((s) => s.id === info.id)
                if (exists) return {}
                return { sessions: [info, ...state.sessions] }
              })
              break
            }

            case "session.error": {
              const error = props.error as { message?: string } | undefined
              const sessionID = props.sessionID as string
              if (!sessionID) break
              // Clear sending state unconditionally — SSE is truth
              useSessions.setState((state) => ({
                sending: { ...state.sending, [sessionID]: false },
                // Surface error only if user is viewing this session
                ...(state.currentSession?.id === sessionID
                  ? { error: error?.message || "Session error occurred" }
                  : {}),
              }))
              if (useSessions.getState().currentSession?.id === sessionID) {
                useSessions.getState().refreshMessages()
              }
              notify({
                category: "errors",
                title: "Session error",
                body: error?.message || "Something went wrong",
                sessionId: sessionID,
              })
              break
            }

            case "permission.asked": {
              const req = props as any
              if (!req.id || !req.sessionID) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [req.sessionID]: [...(state.permissions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "permissions",
                title: req.permission || "Permission requested",
                body: req.patterns?.join(", ") || "A tool needs your approval",
                sessionId: req.sessionID,
              })
              break
            }

            case "permission.replied": {
              const sessionID = props.sessionID as string
              const requestID = props.requestID as string
              if (!sessionID || !requestID) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [sessionID]: (state.permissions[sessionID] || []).filter((p) => p.id !== requestID),
                },
              }))
              break
            }

            case "question.asked": {
              const req = props as any
              if (!req.id || !req.sessionID) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [req.sessionID]: [...(state.questions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "questions",
                title: req.questions?.[0]?.header || "Input needed",
                body: req.questions?.[0]?.question || "The assistant has a question",
                sessionId: req.sessionID,
              })
              break
            }

            case "question.replied":
            case "question.rejected": {
              const sessionID = props.sessionID as string
              const requestID = props.requestID as string
              if (!sessionID || !requestID) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [sessionID]: (state.questions[sessionID] || []).filter((q) => q.id !== requestID),
                },
              }))
              break
            }
          }
        }
      } catch (err) {
        // Connection dropped - try reconnect after delay
        if (!controller?.signal.aborted) {
          console.warn("[SSE] Connection lost, reconnecting in 3s:", err)
          set({ connected: false })
          isReconnecting = true
          setTimeout(() => get().connect(), 3000)
        } else {
          console.log("[SSE] Disconnected (aborted)")
        }
      }
    })()
  },

  disconnect: () => {
    console.log("[SSE] Disconnecting")
    controller?.abort()
    controller = null
    set({ connected: false, sessionStatus: {}, statusText: {} })
  },
}))
